// Local (stdio) MCP server for developers who want to run the tools on their
// own machine with an API key. The plugin itself uses DecisionLayer's hosted
// server at /mcp, which signs users in with OAuth; see README.md.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveBaseUrl, resolveLocalApiKey, type Config } from "./config.js";
import { createServer } from "./tools.js";

const config: Config = {
  baseUrl: resolveBaseUrl(),
  apiKey: resolveLocalApiKey(),
  userId: process.env.DECISIONLAYER_USER_ID?.trim() || undefined,
  transport: "stdio",
};
await createServer(config).connect(new StdioServerTransport());
