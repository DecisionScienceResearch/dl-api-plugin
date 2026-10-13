# Connecting other MCP clients to DecisionLayer

DecisionLayer's MCP server is a standard remote MCP server:

- Endpoint: `https://www.decisionlayer.ai/mcp` (streamable HTTP)
- Sign-in: OAuth 2.1 with PKCE. The server advertises itself at
  `/.well-known/oauth-protected-resource/mcp` and registers clients
  dynamically (RFC 7591), so no client ID, secret or API key is needed.
- Tools: `get_account`, `get_profile`, `file_case`, `file_consent_case`,
  `get_case`, `run_simulation`, `get_simulation`, `send_feedback`.

Any client that supports remote MCP servers with OAuth can use it. The files
in this directory are ready-made configurations for the common ones. On first
use each client opens a DecisionLayer sign-in page in the browser; sign in,
review what the app may do, and click **Allow**. To disconnect later, open
**Settings › API keys › Connected apps** on decisionlayer.ai. Each client
you connect appears there as its own app.

The ChatGPT and Codex plugin is covered in the [main README](../README.md).

| Client | How to connect | File here |
| --- | --- | --- |
| Claude Code | `claude mcp add` or install the plugin | [`claude-code/.mcp.json`](claude-code/.mcp.json) |
| Claude Desktop and claude.ai | Add a custom connector in the app | [`claude-desktop/`](claude-desktop/) (fallback only) |
| Cursor | Project or global `mcp.json` | [`cursor/mcp.json`](cursor/mcp.json) |
| VS Code (GitHub Copilot) | Workspace `.vscode/mcp.json` | [`vscode/mcp.json`](vscode/mcp.json) |
| Your own agent (Claude API, Managed Agents) | Pass the server URL and a token | see below |

## Claude Code

**Option A: add the server directly.** From a terminal:

```bash
claude mcp add --transport http decisionlayer https://www.decisionlayer.ai/mcp
```

That adds it for the current project (`--scope local`). Use `--scope user` to
make it available in every project, or `--scope project` to write it to a
`.mcp.json` file you can commit for your team. Then, inside Claude Code, run
`/mcp`, choose **decisionlayer** and follow the browser sign-in. From a shell
the same login is `claude mcp login decisionlayer`.

To share the configuration in a repository instead, copy
[`claude-code/.mcp.json`](claude-code/.mcp.json) to the repository root:

```json
{
  "mcpServers": {
    "decisionlayer": {
      "type": "http",
      "url": "https://www.decisionlayer.ai/mcp"
    }
  }
}
```

**Option B: install the plugin.** This repository is also a Claude Code
plugin marketplace. The plugin adds the same server plus the three skills
that guide a filing or a simulation:

```bash
claude plugin marketplace add DecisionScienceResearch/dl-api-plugin
claude plugin install decisionlayer@decisionlayer
```

If the server does not prompt you to sign in on first use, run `/mcp` and
authenticate it there.

Try it with:

> Simulate an arbitration case with DecisionLayer using the sample dispute.

## Claude Desktop and claude.ai

Both use **custom connectors**, which Anthropic brokers from its cloud. In
the app, open **Customize › Connectors**, click **+ Add › Add custom
connector**, name it *DecisionLayer*, and enter the URL
`https://www.decisionlayer.ai/mcp`. Leave the OAuth client settings at their
defaults: DecisionLayer registers the client automatically. Click **Connect**
and sign in when the DecisionLayer page opens.

Custom connectors are available on Free (one connector), Pro, Max, Team and
Enterprise plans. On Team and Enterprise, an owner can add the connector once
under **Organization settings** for everyone.

The file in [`claude-desktop/`](claude-desktop/) is **not** needed for Claude
Desktop. It is for clients that can only launch local (stdio) servers, and it
uses the community `mcp-remote` bridge to reach the hosted server:

```json
{
  "mcpServers": {
    "decisionlayer": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.14.3", "https://www.decisionlayer.ai/mcp"]
    }
  }
}
```

`mcp-remote` is a third-party package. Prefer a client's native remote
support whenever it has one.

## Cursor

Copy [`cursor/mcp.json`](cursor/mcp.json) to `.cursor/mcp.json` in your
project, or to `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "decisionlayer": {
      "url": "https://www.decisionlayer.ai/mcp"
    }
  }
}
```

Cursor detects that the server requires OAuth and opens the sign-in page.
No `auth` block is needed because DecisionLayer supports dynamic client
registration.

## VS Code (GitHub Copilot)

Copy [`vscode/mcp.json`](vscode/mcp.json) to `.vscode/mcp.json` in your
workspace, or run **MCP: Add Server** from the Command Palette and enter the
URL:

```json
{
  "servers": {
    "decisionlayer": {
      "type": "http",
      "url": "https://www.decisionlayer.ai/mcp"
    }
  }
}
```

## Your own agent

**Claude API (MCP connector).** The Messages API can call the server
directly: pass the server in `mcp_servers` and reference it from an
`mcp_toolset` entry in `tools`, with the beta header `mcp-client-2025-11-20`.
The API does not run the OAuth flow for you: obtain an access token through
the normal browser sign-in once, pass it as `authorization_token`, and
refresh it with the refresh token (access tokens last one hour).

**Claude Managed Agents.** Declare the server in the agent's `mcp_servers`
(`{"type": "url", "name": "decisionlayer", "url": "https://www.decisionlayer.ai/mcp"}`)
with a matching `mcp_toolset`, and store the OAuth credential in a vault
attached to the session.

**Headless agents with an API key.** The hosted server accepts OAuth sign-ins
only. For a server-side agent that cannot open a browser, run the bundled
stdio server in this repository with a DecisionLayer API key instead; see
*Running the tools locally with an API key* in the [main README](../README.md).
It offers the same eight tools against the same public API.

See the DecisionLayer docs for the full picture of what agents can and
cannot do through these tools, including how human steps such as signing and
payment are handed back.

## Any other client

Point it at `https://www.decisionlayer.ai/mcp` with streamable HTTP
transport and OAuth. The server supports PKCE (S256), dynamic registration,
refresh tokens and revocation, and advertises all of its endpoints at
`https://www.decisionlayer.ai/.well-known/oauth-authorization-server`. If the
client supports only SSE transport or cannot do OAuth, use the `mcp-remote`
bridge above or the stdio server with an API key.
