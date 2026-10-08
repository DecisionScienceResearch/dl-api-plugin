import { randomUUID } from "node:crypto";
import { PLUGIN_NAME, PLUGIN_VERSION, type Config } from "./config.js";
import type { ResolvedFile } from "./files.js";

/** Files at or above this size go through POST /uploads instead of the multipart body. */
export const DIRECT_UPLOAD_BYTES = 8 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 300_000;

/** An error response from the DecisionLayer API (or a failure to reach it). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: string[] = [],
    readonly reason?: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export interface Account {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  can_file_cases: boolean;
  created_at: string;
}

export interface FilePart {
  /** Multipart field for the file itself, e.g. `contract_file`. */
  field: string;
  /** Field used instead when the file is sent as a direct-upload ticket. */
  ticketField: string;
  file: ResolvedFile;
}

// The account behind a key never changes, so one lookup per key is enough.
const accountIds = new Map<string, Promise<string | undefined>>();

export class DecisionLayerClient {
  constructor(
    private readonly config: Config,
    private readonly apiKey: string,
  ) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /** How this program names itself to the API, e.g. in feedback. */
  get clientLabel(): string {
    return `${PLUGIN_NAME}/${PLUGIN_VERSION} (${this.config.transport})`;
  }

  /** Identifies the person behind the request: the configured override, else their account ID. */
  private async userId(): Promise<string | undefined> {
    if (this.config.userId) return this.config.userId;
    let pending = accountIds.get(this.apiKey);
    if (!pending) {
      pending = this.send<Account>("GET", "/me", {}, undefined)
        .then((account) => account.id)
        .catch(() => undefined);
      accountIds.set(this.apiKey, pending);
      // A failed lookup should be retried on the next request, not remembered.
      void pending.then((id) => {
        if (!id) accountIds.delete(this.apiKey);
      });
    }
    return pending;
  }

  private headers(userId: string | undefined, extra: Record<string, string>): Record<string, string> {
    const client = `${PLUGIN_NAME}/${PLUGIN_VERSION}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      // The API logs User-Agent, so the user is named there as well as in its own header.
      "User-Agent": `${client} (${this.config.transport}${userId ? `; user=${userId}` : ""})`,
      "X-DecisionLayer-Client": client,
      ...extra,
    };
    if (userId) headers["X-DecisionLayer-User"] = userId;
    return headers;
  }

  private async send<T>(
    method: string,
    path: string,
    extraHeaders: Record<string, string>,
    body: (() => BodyInit) | undefined,
    userId?: string,
  ): Promise<T> {
    const url = `${this.config.baseUrl}/api/v1${path}`;
    // Every POST that creates something carries an Idempotency-Key, so a retry is safe.
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: this.headers(userId, extraHeaders),
          body: body?.(),
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt < 1) continue;
        const cause = error instanceof Error ? error.message : String(error);
        throw new ApiError(0, `Could not reach DecisionLayer at ${this.config.baseUrl}: ${cause}`);
      }
      if (response.status === 503 && attempt < 2) {
        const wait = Number(response.headers.get("retry-after") || 1);
        await new Promise((done) => setTimeout(done, Math.min(wait, 5) * 1000));
        continue;
      }
      const text = await response.text();
      let parsed: any;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      if (response.ok) return parsed as T;
      const envelope = parsed?.error;
      throw new ApiError(
        response.status,
        envelope?.message || `DecisionLayer returned HTTP ${response.status}.`,
        Array.isArray(envelope?.details) ? envelope.details : [],
        envelope?.reason,
        response.headers.get("x-request-id") || undefined,
      );
    }
  }

  async get<T>(path: string): Promise<T> {
    return this.send<T>("GET", path, {}, undefined, await this.userId());
  }

  /** POSTs a JSON body. */
  async postJson<T>(path: string, payload: unknown): Promise<T> {
    return this.send<T>(
      "POST",
      path,
      { "Content-Type": "application/json" },
      () => JSON.stringify(payload),
      await this.userId(),
    );
  }

  /** Uploads one large file straight to storage and returns its ticket. */
  private async directUpload(file: ResolvedFile): Promise<string> {
    const prepared = await this.postJson<{
      uploads: { upload_url: string; content_type: string; ticket: string }[];
    }>("/uploads", {
      files: [{ filename: file.filename, size: file.bytes.byteLength, content_type: file.contentType }],
    });
    const upload = prepared.uploads[0];
    const put = await fetch(upload.upload_url, {
      method: "PUT",
      headers: { "Content-Type": upload.content_type },
      body: file.bytes as BodyInit,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!put.ok) {
      throw new ApiError(put.status, `Uploading '${file.filename}' failed with HTTP ${put.status}.`);
    }
    return upload.ticket;
  }

  /**
   * POSTs a multipart form. Blank fields are left out so the API applies its
   * own defaults. `idempotencyKey` makes a retried call return the original
   * result instead of filing twice.
   */
  async postForm<T>(
    path: string,
    fields: Record<string, string | undefined>,
    files: FilePart[],
    idempotencyKey: string = randomUUID(),
  ): Promise<T> {
    const tickets: [string, string][] = [];
    const inline: FilePart[] = [];
    for (const part of files) {
      if (part.file.bytes.byteLength >= DIRECT_UPLOAD_BYTES) {
        tickets.push([part.ticketField, await this.directUpload(part.file)]);
      } else {
        inline.push(part);
      }
    }

    const build = () => {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) {
        if (value !== undefined && value !== "") form.append(name, value);
      }
      for (const [name, ticket] of tickets) form.append(name, ticket);
      for (const { field, file } of inline) {
        form.append(field, new Blob([file.bytes as BlobPart], { type: file.contentType }), file.filename);
      }
      return form;
    };
    return this.send<T>("POST", path, { "Idempotency-Key": idempotencyKey }, build, await this.userId());
  }
}
