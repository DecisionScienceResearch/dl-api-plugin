import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { readFile, stat } from "node:fs/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { z } from "zod";
import type { Transport } from "./config.js";

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
// One tool call may carry at most this many files, totalling at most this many
// bytes across every file argument. The hosted server has the same limits.
export const MAX_FILES_PER_CALL = 10;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const DOWNLOAD_TIMEOUT_MS = 120_000;

export const CONTRACT_EXTENSIONS = [".pdf", ".docx", ".rtf", ".txt"];
export const EVIDENCE_EXTENSIONS = [
  ...CONTRACT_EXTENSIONS,
  ".jpg",
  ".jpeg",
  ".png",
  ".mp4",
  ".mov",
  ".avi",
];

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
};

// Media types ChatGPT or a download server may report, used when a file's
// name carries no accepted extension.
const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/rtf": ".rtf",
  "text/rtf": ".rtf",
  "text/plain": ".txt",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
};

/**
 * One file, in the shape the hosted server takes (ChatGPT's attachment
 * object), plus `path` for files on this computer. Pasted text goes in the
 * tools' separate `*_text` arguments.
 */
export const fileInputSchema = z
  .object({
    download_url: z.string().optional().describe("HTTPS URL the file can be downloaded from. Required unless path is given."),
    file_id: z.string().optional().describe("ChatGPT's ID for an attached file. Other clients may pass the file name."),
    mime_type: z.string().optional().describe("The file's media type, e.g. application/pdf, if known."),
    file_name: z.string().optional().describe("The file's name including extension, if known."),
    path: z
      .string()
      .optional()
      .describe("Absolute path to a file on the user's computer. Only this local server accepts it; give download_url otherwise."),
  })
  .describe("One file: download_url, or path for a file on this computer.");

export type FileInput = z.infer<typeof fileInputSchema>;

/** A file argument's value: a file to fetch, or text the user pasted (sent as .txt). */
export type FileSource = FileInput | string;

export interface ResolvedFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/** A problem with the user's input, safe to show as-is. */
export class InputError extends Error {}

/**
 * Caps the attachments of one tool call. The file count is checked before
 * anything is read; bytes are charged as each file arrives, and a download
 * stops as soon as it would pass what is left.
 */
export class AttachmentBudget {
  remaining = MAX_TOTAL_BYTES;

  constructor(fileCount: number) {
    if (fileCount > MAX_FILES_PER_CALL) {
      throw new InputError(
        `Too many files: ${fileCount} were provided and one call accepts at most ${MAX_FILES_PER_CALL}.`,
      );
    }
  }

  overBudget(label: string): InputError {
    return new InputError(
      `${label}: the files in this call together exceed ${MAX_TOTAL_BYTES / (1024 * 1024)} MiB.`,
    );
  }

  charge(size: number, label: string): void {
    if (size > this.remaining) throw this.overBudget(label);
    this.remaining -= size;
  }
}

const privateRanges = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  privateRanges.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  privateRanges.addSubnet(net, prefix, "ipv6");
}

function isPrivateAddress(address: string): boolean {
  const mapped = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  const family = isIP(mapped);
  if (family === 0) return true;
  return privateRanges.check(mapped, family === 4 ? "ipv4" : "ipv6");
}

class NotPublicAddress extends Error {
  constructor(readonly host: string) {
    super(host);
  }
}

/**
 * Resolves a host once and refuses it unless every address is public. The
 * connection is made to the address checked here, so a DNS answer that
 * changes between the check and the connection cannot reach a private one.
 */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 0);
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      return callback(new NotPublicAddress(hostname) as NodeJS.ErrnoException, "", 0);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

/** The file name a Content-Disposition header gives, without any path. */
function dispositionFilename(header: string): string {
  let name = "";
  const encoded = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (encoded) {
    try {
      name = decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ""));
    } catch {
      name = "";
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
    name = (plain?.[1] ?? plain?.[2] ?? "").trim();
  }
  return name.replace(/\\/g, "/").split("/").pop() ?? "";
}

function decodedName(pathname: string): string {
  try {
    return decodeURIComponent(basename(pathname));
  } catch {
    return basename(pathname);
  }
}

interface Download {
  bytes: Uint8Array;
  /** From Content-Disposition, else the URL's last path segment. */
  name: string;
  mediaType: string;
}

type Hop = { redirect: URL } | Download;

/** One GET, streamed, stopping as soon as the body passes either limit. */
function fetchOnce(url: URL, label: string, budget: AttachmentBudget): Promise<Hop> {
  const tooLarge = new InputError(`${label}: the file is larger than 100 MiB.`);
  return new Promise((done, failed) => {
    const req = request(url, { lookup: publicLookup, timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      const header = (name: string) => {
        const value = res.headers[name];
        return (Array.isArray(value) ? value[0] : value) ?? "";
      };
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return done({ redirect: new URL(res.headers.location, url) });
      }
      if (status >= 400) {
        res.resume();
        return failed(new InputError(`${label}: downloading the file failed with HTTP ${status}.`));
      }
      const refuse = (error: InputError) => {
        failed(error);
        req.destroy();
      };
      const declared = Number(header("content-length") || 0);
      if (declared > MAX_FILE_BYTES) return refuse(tooLarge);
      if (declared > budget.remaining) return refuse(budget.overBudget(label));
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_FILE_BYTES) return refuse(tooLarge);
        if (total > budget.remaining) return refuse(budget.overBudget(label));
        chunks.push(chunk);
      });
      res.on("end", () => {
        budget.charge(total, label);
        done({
          bytes: Buffer.concat(chunks),
          name: dispositionFilename(header("content-disposition")) || decodedName(url.pathname),
          mediaType: header("content-type"),
        });
      });
      res.on("error", () => failed(new InputError(`${label}: the file could not be downloaded.`)));
    });
    req.on("timeout", () => req.destroy(new InputError(`${label}: the download timed out.`)));
    req.on("error", (error) => {
      if (error instanceof InputError) return failed(error);
      if (error instanceof NotPublicAddress) {
        return failed(new InputError(`${label}: download_url host '${error.host}' is not a public address.`));
      }
      failed(new InputError(`${label}: the file could not be downloaded.`));
    });
    req.end();
  });
}

async function download(rawUrl: string, label: string, budget: AttachmentBudget): Promise<Download> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InputError(`${label}: download_url is not a valid URL.`);
  }
  // Redirects are followed by hand so every hop gets the same checks.
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:") throw new InputError(`${label}: download_url must use https.`);
    // An IP literal is connected to without a lookup, so it is checked here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isPrivateAddress(host)) {
      throw new InputError(`${label}: download_url host '${url.hostname}' is not a public address.`);
    }
    const result = await fetchOnce(url, label, budget);
    if (!("redirect" in result)) return result;
    url = result.redirect;
  }
  throw new InputError(`${label}: download_url redirected too many times.`);
}

function mediaType(value: string | undefined): string {
  return (value ?? "").split(";")[0].trim().toLowerCase();
}

/** Recognises an accepted file type from its leading bytes, or returns "". */
function sniffExtension(bytes: Uint8Array): string {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const startsWith = (prefix: string) => data.subarray(0, prefix.length).equals(Buffer.from(prefix, "latin1"));
  if (startsWith("%PDF-")) return ".pdf";
  if (startsWith("\x89PNG\r\n\x1a\n")) return ".png";
  if (startsWith("\xff\xd8\xff")) return ".jpg";
  if (startsWith("{\\rtf")) return ".rtf";
  if (startsWith("PK\x03\x04") && data.includes("word/document.xml")) return ".docx";
  if (data.subarray(4, 8).toString("latin1") === "ftyp") {
    return data.subarray(8, 12).toString("latin1") === "qt  " ? ".mov" : ".mp4";
  }
  if (startsWith("RIFF") && data.subarray(8, 12).toString("latin1") === "AVI ") return ".avi";
  return "";
}

/**
 * Names a file so that its extension says what it is. When the name carries
 * no accepted extension, the type comes from the reported mime_type, then the
 * server's Content-Type, then the file's leading bytes.
 */
function typedFilename(
  input: FileInput,
  found: { name: string; mediaType: string; bytes: Uint8Array },
  allowed: string[],
  defaultName: string,
): string {
  const name = (input.file_name || found.name).trim();
  if (allowed.includes(extname(name).toLowerCase())) return name;
  for (const extension of [
    MEDIA_TYPE_EXTENSIONS[mediaType(input.mime_type)],
    MEDIA_TYPE_EXTENSIONS[mediaType(found.mediaType)],
    sniffExtension(found.bytes),
  ]) {
    if (extension && allowed.includes(extension)) return `${name || defaultName}${extension}`;
  }
  return name || defaultName;
}

async function readLocalFile(input: FileInput, label: string, budget: AttachmentBudget) {
  const path = input.path!;
  const expanded = path.startsWith("~/") ? homedir() + path.slice(1) : path;
  const fullPath = resolve(expanded);
  let size: number;
  try {
    const info = await stat(fullPath);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    throw new InputError(`${label}: no readable file at ${fullPath}.`);
  }
  if (size > MAX_FILE_BYTES) throw new InputError(`${label}: the file is larger than 100 MiB.`);
  budget.charge(size, label);
  return { bytes: await readFile(fullPath), name: basename(fullPath), mediaType: "" };
}

export async function resolveFile(
  source: FileSource,
  opts: { label: string; allowed: string[]; transport: Transport; defaultName: string; budget: AttachmentBudget },
): Promise<ResolvedFile> {
  const { label, allowed, transport, budget } = opts;
  let bytes: Uint8Array;
  let filename: string;
  if (typeof source === "string") {
    bytes = new TextEncoder().encode(source);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new InputError(`${label}: the file is larger than 100 MiB.`);
    budget.charge(bytes.byteLength, label);
    filename = `${opts.defaultName}.txt`;
  } else {
    const sources = [source.path, source.download_url].filter((value) => value !== undefined && value !== "");
    if (sources.length !== 1) {
      throw new InputError(`${label}: provide exactly one of download_url or path.`);
    }
    if (source.path && transport !== "stdio") {
      throw new InputError(
        `${label}: file paths only work when the plugin runs on the user's computer. Use download_url instead.`,
      );
    }
    const found = source.path
      ? await readLocalFile(source, label, budget)
      : await download(source.download_url!, label, budget);
    bytes = found.bytes;
    filename = typedFilename(source, found, allowed, opts.defaultName);
  }

  if (bytes.byteLength === 0) throw new InputError(`${label}: the file is empty.`);
  const extension = extname(filename).toLowerCase();
  if (!allowed.includes(extension)) {
    throw new InputError(
      `${label}: '${filename}' is not an accepted file type. Accepted: ${allowed.join(", ")}.`,
    );
  }
  return { filename, contentType: CONTENT_TYPES[extension], bytes };
}
