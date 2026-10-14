import { PLUGIN_NAME, PLUGIN_VERSION, type Config } from "./config.js";
import { InputError, type ResolvedFile } from "./files.js";

/** Files at or above this size go through POST /uploads instead of the multipart body. */
export const DIRECT_UPLOAD_BYTES = 8 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 300_000;

// The API's two 409 messages for a refused Idempotency-Key. postForm turns them
// into advice on what the retry means.
const KEY_REUSED_MESSAGE = "This Idempotency-Key was already used for a different request.";
const IN_PROGRESS_MESSAGE = "A request with this Idempotency-Key is still in progress.";

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

  /** Says what a refused idempotency key means for the request, if it was refused. */
  private retryAdvice(error: unknown): string | undefined {
    if (!(error instanceof ApiError) || error.status !== 409) return undefined;
    if (error.message === IN_PROGRESS_MESSAGE) {
      return (
        "The first attempt with this idempotency_key is still running. Wait a minute, then call again with the same " +
        "idempotency_key and the same arguments to get its result."
      );
    }
    if (error.message === KEY_REUSED_MESSAGE) {
      const large = DIRECT_UPLOAD_BYTES / (1024 * 1024);
      return (
        "This idempotency_key was already used for a request with different arguments or files. If this is a retry after " +
        "an error or timeout, the first attempt may have gone through: a retry that includes a file of " +
        `${large} MB or more always looks different, because the file is uploaded again. Ask the user to check their ` +
        `dashboard at ${this.config.baseUrl}/dashboard before trying again with a new idempotency_key.`
      );
    }
    return undefined;
  }

  /**
   * POSTs a multipart form. Blank fields are left out so the API applies its
   * own defaults. The caller chooses `idempotencyKey` and sends it again on a
   * retry, so a retried call returns the original result instead of filing
   * twice; a key made up here would be lost with a call that timed out.
   */
  async postForm<T>(
    path: string,
    fields: Record<string, string | undefined>,
    files: FilePart[],
    idempotencyKey: string,
  ): Promise<T> {
    const key = idempotencyKey.trim();
    if (!key) {
      throw new InputError(
        "idempotency_key is required: pass a new unique value, such as a UUID, and reuse it only to retry this request.",
      );
    }
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
    try {
      return await this.send<T>("POST", path, { "Idempotency-Key": key }, build, await this.userId());
    } catch (error) {
      const advice = this.retryAdvice(error);
      if (advice) throw new InputError(advice);
      throw error;
    }
  }
}
