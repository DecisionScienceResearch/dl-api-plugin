import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN_NAME = "decisionlayer-chatgpt-plugin";
export const PLUGIN_VERSION = "0.1.0";

export const DEFAULT_BASE_URL = "https://www.decisionlayer.ai";
export const KEY_FILE = join(homedir(), ".config", "decisionlayer", "api_key");
export const KEYS_PAGE_PATH = "/settings/api-keys";
export const TEST_KEYS_PAGE_PATH = "/settings/test-api-keys";

export type Transport = "stdio" | "http";

export interface Config {
  baseUrl: string;
  apiKey: string | undefined;
  /** Optional override for the value sent in X-DecisionLayer-User. */
  userId: string | undefined;
  transport: Transport;
}

export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.DECISIONLAYER_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`DECISIONLAYER_BASE_URL is not a valid URL: ${raw}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) {
    throw new Error("DECISIONLAYER_BASE_URL must use https.");
  }
  // The bare domain 301s to www, and a redirected POST would lose its body.
  if (url.hostname === "decisionlayer.ai") url.hostname = "www.decisionlayer.ai";
  return url.origin;
}

/** Local (stdio) key lookup: environment first, then the key file. */
export function resolveLocalApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.DECISIONLAYER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromFile = readFileSync(env.DECISIONLAYER_API_KEY_FILE || KEY_FILE, "utf8").trim();
    return fromFile || undefined;
  } catch {
    return undefined;
  }
}

export function isTestKey(apiKey: string): boolean {
  return apiKey.startsWith("dvarb_test_");
}

export function missingKeyMessage(baseUrl: string, transport: Transport): string {
  const where =
    transport === "http"
      ? "Send it as `Authorization: Bearer dvarb_...` on the MCP connection."
      : `Set the DECISIONLAYER_API_KEY environment variable, or save the key in ${KEY_FILE}, then restart the plugin.`;
  return [
    "No DecisionLayer API key is configured.",
    `Create one at ${baseUrl}${KEYS_PAGE_PATH} (or a sandbox test key at ${baseUrl}${TEST_KEYS_PAGE_PATH}).`,
    where,
    "Never paste the key into the chat.",
  ].join(" ");
}
