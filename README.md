# DecisionLayer plugin for ChatGPT, Codex and Claude Code

Bring a case to arbitration with [DecisionLayer](https://www.decisionlayer.ai) from a conversation.

- **File a full case** under a contract that has an arbitration clause.
- **File a consent case**, where you invite the other party to agree to arbitrate.
- **Simulate a case** first: give both sides of a dispute and get a written award back in a few minutes, with nothing filed and nobody contacted.

You sign in with your DecisionLayer account. There is nothing to configure and no key to copy.

## Quick start

**1. Install the plugin.** This repository is a plugin marketplace with one plugin in it:

```bash
codex plugin marketplace add DecisionScienceResearch/dl-api-plugin
```

Then open the plugin list, find **DecisionLayer** and install it. To install from a local clone instead, run `codex plugin marketplace add /path/to/dl-api-plugin`.

For **Claude Code** the same repository is a plugin marketplace too:

```bash
claude plugin marketplace add DecisionScienceResearch/dl-api-plugin
claude plugin install decisionlayer@decisionlayer
```

Or skip the plugin and add the server alone with `claude mcp add --transport http decisionlayer https://www.decisionlayer.ai/mcp`. **Claude Desktop, claude.ai, Cursor, VS Code** and any other MCP client connect to the same server; ready-made configurations and steps are in [`clients/`](clients/README.md).

**2. Connect your account.** The first time the plugin needs DecisionLayer, a browser window opens on decisionlayer.ai. Sign in (or create an account), review what the app will be able to do, and click **Allow**. You are sent straight back.

**3. Try it.** Start a new conversation and say:

> Simulate an arbitration case with DecisionLayer using the sample dispute.

To disconnect later, open **Settings › API keys › Connected apps** on decisionlayer.ai and click **Disconnect**. The app is signed out immediately; anything it filed stays on your dashboard.

## Try it with the simulator

The simulator is the quickest way to see DecisionLayer work. It takes the contract and both parties' arguments in one call, and an AI arbitrator writes an award.

The plugin ships with a made-up security-deposit dispute ([sample-case.md](plugins/decisionlayer/skills/simulate-arbitration-case/references/sample-case.md)), so you can run a simulation without preparing anything. You can also describe your own dispute.

Before you run one:

- **The award is published.** It gets a public link that works for 30 days. Use made-up names if the dispute is real and you want privacy. After the 30 days the award text is still returned by the tool; only the public PDF link goes away.
- **Simulations are limited** to a monthly allowance per account. The API answers 429 when it is used up.

## Filing a real case

Ask for what you want in plain language, for example:

> Help me bring a case to arbitration with DecisionLayer. Here is the lease. [attach lease.pdf]

> Start a consent arbitration case against Jordan Chen about our shared fence.

The assistant collects what the filing needs, shows you a summary, and files only after you confirm. It does not make up names, addresses or amounts.

Filing a full case is limited to approved accounts: `get_account` reports whether yours is (`can_file_cases`), and the assistant says so before it starts. Consent cases and simulations need no approval. To request filing access, email casemanager@decisionlayer.ai.

| | Full case | Consent case |
| --- | --- | --- |
| When to use it | Your contract has an arbitration clause | No clause, or you would rather invite the other party to agree |
| You provide | The contract, the question, your argument, both parties' names and addresses | The question and the other party's name and email |
| After filing | Sign the terms, pay the filing fee and verify your identity at the link returned | Sign and pay at the link returned; the other party is then emailed an invitation |
| Case ID starts with | `case_` | `creq_` |

Signing, payment and identity verification happen on the DecisionLayer website. The plugin gives you the link.

## How it works

The plugin points at DecisionLayer's hosted MCP server, `https://www.decisionlayer.ai/mcp`, which lives inside the DecisionLayer application. DecisionLayer is also the OAuth 2.1 authorization server:

| Endpoint | Purpose |
| --- | --- |
| `/.well-known/oauth-protected-resource/mcp` | Tells the client where to sign in (RFC 9728) |
| `/.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |
| `/oauth/register` | Dynamic client registration (RFC 7591), so ChatGPT and Codex need no pre-shared client ID |
| `/oauth/authorize` → `/oauth/consent` | Sign in with your DecisionLayer account and click Allow |
| `/oauth/token` | Code exchange with PKCE, and refresh |
| `/oauth/revoke` | Token revocation |

Clicking **Allow** creates a *grant* for your account and that app. Access tokens last an hour, refresh tokens thirty days (rotated on use), and every token dies with its grant. Each MCP tool calls the public DecisionLayer API as you, so a case filed from ChatGPT is identical to one filed with an API key: it is owned by your account, carries an idempotency key, and goes through the same validation. The idempotency key is scoped to the account: a retry with the same key and the same arguments replays the first result, a retry while the first attempt is still running is a 409 for about a minute, and the same key with different arguments is refused.

The seven tools:

| Tool | What it does |
| --- | --- |
| `get_account` | Reports which account is connected (`GET /api/v1/me`) |
| `file_case` | Files a full case (`POST /api/v1/cases`) |
| `file_consent_case` | Files a consent case (`POST /api/v1/consent-cases`) |
| `get_case` | Reports a case's status, whose turn it is, and the next step with its link (`GET /api/v1/cases/{id}` or `/consent-cases/{id}`) |
| `run_simulation` | Starts a simulation (`POST /api/v1/simulations`) |
| `get_simulation` | Waits for a simulation and returns the award (`GET /api/v1/simulations/{id}` and `/result`) |
| `send_feedback` | Sends a note to the DecisionLayer team, for example when a tool call failed (`POST /api/v1/feedback`) |

Signing, payment and identity verification have no tool. When a filing needs one of them, the tool result carries the web link (`action_url` for a case, `sign_url` for a consent case) and the assistant hands it to the user.

Documents can be attached in the chat, given as an HTTPS link, or pasted as text. Contracts may be `.pdf`, `.docx`, `.rtf` or `.txt`; evidence may also be `.jpg`, `.jpeg`, `.png`, `.mp4`, `.mov` or `.avi`. Each file can be up to 100 MiB.

Three skills guide the conversation: `file-arbitration-case`, `file-consent-case` and `simulate-arbitration-case`.

The server side (authorization server, consent page, MCP endpoint and tools) is in the DecisionLayer application repository, under `app/services/oauth_server.py`, `app/services/mcp_server.py`, `app/services/mcp_tools.py` and `app/routers/oauth.py`.

## Running the tools locally with an API key

For development, this repository also contains a small stdio MCP server (`src/`, bundled to `plugins/decisionlayer/mcp/server.mjs`) that offers the same seven tools against the public API with an API key instead of a sign-in. It is not what the plugin installs by default.

1. Create a key at `https://www.decisionlayer.ai/settings/api-keys` (or a sandbox test key at `/settings/test-api-keys`; test filings skip signing and payment, contact nobody, and never produce an award, and test keys cannot run simulations).
2. Save it: `export DECISIONLAYER_API_KEY=dvarb_...`, or write it to `~/.config/decisionlayer/api_key`.
3. Replace `plugins/decisionlayer/mcp.json` with `mcp.local.json`, or run `npm run inspect` to try the server in the MCP Inspector.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DECISIONLAYER_API_KEY` | none | Your API key. Takes priority over the key file. |
| `DECISIONLAYER_API_KEY_FILE` | `~/.config/decisionlayer/api_key` | Where to read the key from when the variable is not set |
| `DECISIONLAYER_BASE_URL` | `https://www.decisionlayer.ai` | The DecisionLayer environment, e.g. `https://staging.decisionlayer.ai` |
| `DECISIONLAYER_USER_ID` | your account ID | The value sent in `X-DecisionLayer-User` |

In local mode files can also be given as a path on your computer. Every request identifies itself with `X-DecisionLayer-Client`, `X-DecisionLayer-User` and a matching `User-Agent`; the hosted server does the same.

## Development

```bash
npm install
npm test          # builds the local server, then runs its tests against a fake DecisionLayer API
npm run typecheck
npm run inspect   # opens the MCP Inspector against the local server
```

```
.agents/plugins/marketplace.json   marketplace entry for Codex and ChatGPT
.claude-plugin/marketplace.json    marketplace entry for Claude Code
plugins/decisionlayer/
  plugin.json                      plugin manifest
  .codex-plugin/plugin.json        the same manifest in the older layout
  .claude-plugin/plugin.json       the same manifest for Claude Code
  mcp.json                         points Codex at the hosted MCP server
  .mcp.json                        points Claude Code at the hosted MCP server
  mcp.local.json                   alternative: run the bundled server locally with an API key
  mcp/server.mjs                   the built local server (generated, committed)
  skills/                          the three skills and the sample case
  assets/                          logo and icon
clients/                           configurations for Claude Code, Claude Desktop, Cursor, VS Code
src/                               local server source (TypeScript)
test/                              its end-to-end tests
```

`mcp/server.mjs` is a single bundled file so the local mode runs straight from a git install with no `npm install`. After changing anything in `src/`, run `npm run build` and commit the result. Keep the version in `package.json`, all three `plugin.json` files and `src/config.ts` the same; the tests check the manifests.

## Scope

This version brings cases. It does not submit later-round responses, act for the respondent, sign, pay, list cases or read a decided award. The REST API covers all of those with an API key (`/api/v1/cases/{id}/responses`, `/claim`, `/sign`, `/decision`, the `/events` change feed and the list endpoints); see the [API reference](https://www.decisionlayer.ai/api/docs). Nothing the assistant says is legal advice.

## License

[MIT](LICENSE)
