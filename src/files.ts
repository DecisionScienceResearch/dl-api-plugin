import { lookup } from "node:dns/promises";
import { readFile, stat } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { z } from "zod";
import type { Transport } from "./config.js";

export const MAX_FILE_BYTES = 100 * 1024 * 1024;

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

export const fileInputSchema = z
  .object({
    path: z
      .string()
      .optional()
      .describe("Absolute path to a file on the user's computer. Only works when the plugin runs locally."),
    download_url: z.string().optional().describe("HTTPS URL the file can be downloaded from."),
    text: z
      .string()
      .optional()
      .describe("The document's full text, used when the user pasted it into the chat. Sent as a .txt file."),
    filename: z
      .string()
      .optional()
      .describe("File name including extension. Required with download_url when the URL does not end in one."),
    file_id: z.string().optional().describe("Set by ChatGPT for attached files. Ignored."),
  })
  .describe("One document. Provide exactly one of path, download_url or text.");

export type FileInput = z.infer<typeof fileInputSchema>;

export interface ResolvedFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/** A problem with the user's input, safe to show as-is. */
export class InputError extends Error {}

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

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new InputError(`download_url host '${hostname}' is not a public address.`);
  }
}

async function download(rawUrl: string, label: string): Promise<{ bytes: Uint8Array; url: URL }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InputError(`${label}: download_url is not a valid URL.`);
  }
  // Redirects are followed by hand so every hop gets the same checks.
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:") throw new InputError(`${label}: download_url must use https.`);
    await assertPublicHost(url.hostname);
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) break;
      url = new URL(next, url);
      continue;
    }
    if (!response.ok) {
      throw new InputError(`${label}: downloading the file failed with HTTP ${response.status}.`);
    }
    if (Number(response.headers.get("content-length") || 0) > MAX_FILE_BYTES) {
      throw new InputError(`${label}: the file is larger than 100 MiB.`);
    }
    return { bytes: new Uint8Array(await response.arrayBuffer()), url };
  }
  throw new InputError(`${label}: download_url redirected too many times.`);
}

export async function resolveFile(
  input: FileInput,
  opts: { label: string; allowed: string[]; transport: Transport; defaultName: string },
): Promise<ResolvedFile> {
  const { label, allowed, transport } = opts;
  const sources = [input.path, input.download_url, input.text].filter(
    (value) => value !== undefined && value !== "",
  );
  if (sources.length !== 1) {
    throw new InputError(`${label}: provide exactly one of path, download_url or text.`);
  }

  let bytes: Uint8Array;
  let filename: string;
  if (input.text) {
    bytes = new TextEncoder().encode(input.text);
    filename = input.filename || `${opts.defaultName}.txt`;
    if (extname(filename).toLowerCase() !== ".txt") filename = `${filename}.txt`;
  } else if (input.path) {
    if (transport !== "stdio") {
      throw new InputError(
        `${label}: file paths only work when the plugin runs on the user's computer. Use download_url or text instead.`,
      );
    }
    const expanded = input.path.startsWith("~/") ? homedir() + input.path.slice(1) : input.path;
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
    bytes = await readFile(fullPath);
    filename = input.filename || basename(fullPath);
  } else {
    const downloaded = await download(input.download_url!, label);
    bytes = downloaded.bytes;
    filename = input.filename || decodeURIComponent(basename(downloaded.url.pathname));
  }

  if (bytes.byteLength === 0) throw new InputError(`${label}: the file is empty.`);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new InputError(`${label}: the file is larger than 100 MiB.`);
  const extension = extname(filename).toLowerCase();
  if (!allowed.includes(extension)) {
    throw new InputError(
      `${label}: '${filename}' is not an accepted file type. Accepted: ${allowed.join(", ")}.`,
    );
  }
  return { filename, contentType: CONTENT_TYPES[extension], bytes };
}
