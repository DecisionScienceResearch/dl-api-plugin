# DecisionLayer plugin for ChatGPT, Codex and Claude Code

Bring a case to arbitration with [DecisionLayer](https://www.decisionlayer.ai) from a conversation.

- **File a full case** under a contract that has an arbitration clause.
- **File a consent case**, where you invite the other party to agree to arbitrate.
- **Simulate a case** first: give both sides of a dispute and get a written award back in a few minutes, with nothing filed and nobody contacted.
- **Carry a case through**: see what is waiting on you, read what the other party filed, submit your response when it is your turn, and read the award. This works for the respondent as well as the claimant.

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

## After a case is filed

The same assistant takes either party through the rest of the case:

> What is waiting on me at DecisionLayer?

> I was served with a DecisionLayer case. Help me respond.

> Has the other side replied on my case? Show me what they filed.

| Step | What the assistant does |
| --- | --- |
| Find the case | `list_cases` lists your cases and consent cases and which are waiting on you. A case filed *against* you appears once you have claimed it on the DecisionLayer website with the link or code from your notice. |
| Read it | `get_case_record` returns the claim and every submitted round. `get_case_file` reads a file: the text of a .pdf, .docx, .rtf or .txt a part at a time, or a .jpg or .png as an image. A video, or a PDF that is only scanned pages, cannot be read; you open it on the case page. |
| Respond | `respond_to_case` submits your turn: the respondent's first response, the claimant's reply, or the respondent's counter response. A submitted round is final, so the assistant shows you the whole response and asks before it submits. |
| Follow it | `get_case_updates` says what has happened since you last asked and where each case stands. |
| Read the award | `get_decision` returns the award once the case is decided. |

If you were invited to a consent case, give the assistant the link from the invitation email: `claim_consent_case` opens it and `answer_consent_case` records your accept or reject. Either answer is final.

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

Clicking **Allow** creates a *grant* for your account and that app. Access tokens last an hour, refresh tokens thirty days (rotated on use), and every token dies with its grant. Each MCP tool calls the public DecisionLayer API as you, so a case filed from ChatGPT is identical to one filed with an API key: it is owned by your account and goes through the same validation, approvals and monthly limits.

The sixteen tools. The first eight bring a case; the rest carry one forward and were added in 1.1 without changing the first eight:

| Tool | What it does | Returns |
| --- | --- | --- |
| `get_account` | Reports which account is connected and whether it may file full cases (`GET /api/v1/me`) | `name`, `email`, `can_file_cases`, `dashboard_url` |
| `get_profile` | Identifies the connected account, so a client such as ChatGPT can tell accounts apart (`GET /api/v1/me`) | `id`, `name`, `email` |
| `file_case` | Files a full case (`POST /api/v1/cases`) | `id`, `status`, `action_url`, `dashboard_url` |
| `file_consent_case` | Files a consent case (`POST /api/v1/consent-cases`) | `id`, `status`, `action_url`, `dashboard_url` |
| `get_case` | Reports a case's status, whose turn it is, and the next step with its link (`GET /api/v1/cases/{id}` or `/consent-cases/{id}`) | `status`, `role`, `current_turn`, `action_required`, `next_action`, `action_url`, `view_url`, and the question, amount and respondent |
| `run_simulation` | Starts a simulation (`POST /api/v1/simulations`) | `id`, `status`, `page_url` |
| `get_simulation` | Waits up to `wait_seconds` (default 30, at most 50) for a simulation and returns the award (`GET /api/v1/simulations/{id}` and `/result`) | `status`, `page_url`, and once ready the award `text` and, for 30 days, `pdf_url` |
| `send_feedback` | Sends a note to the DecisionLayer team, for example when a tool call failed. The assistant shows you the note and sends it only if you agree (`POST /api/v1/feedback`) | An `fb_` ID |
| `list_cases` | Lists your cases and consent cases; `only_action_required` lists just the ones waiting on you (`GET /api/v1/cases` and `/consent-cases`) | `cases`, `more`, `dashboard_url` |
| `get_case_record` | Returns what was filed on a case and whether it is your turn (`GET /api/v1/cases/{id}` and `/responses`) | The question and amount, `filings` (the claim, then each round, with their files), `your_turn`, `open_round`, `response_fields` |
| `get_case_file` | Reads one file from a case (`GET /api/v1/cases/{id}/files` and `/files/{file_id}`) | `text` for one `part` of `parts`, or an image; `readable: false` with a `note` and `view_url` otherwise |
| `respond_to_case` | Submits your turn on a case (`POST /api/v1/cases/{id}/responses`) | The `round` submitted, and the case's `status`, `next_action`, `action_url`, `waiting_on`, `status_summary` |
| `get_case_updates` | Reports what happened on your cases, or on one (`GET /api/v1/events`, `/cases/{id}/events`, `/consent-cases/{id}/events`) | `updates`, `cases` (where each stands now), `cursor`, `more` |
| `get_decision` | Returns the award once a case is decided (`GET /api/v1/cases/{id}/decision`) | `published`, the award `text`, `pdf_url` |
| `claim_consent_case` | Opens a consent case you were invited to, from the invitation link (`POST /api/v1/consent-cases/claim`) | The same as `get_case` |
| `answer_consent_case` | Accepts or rejects a consent case as the respondent (`POST /api/v1/consent-cases/{id}/accept` or `/reject`) | The same as `get_case` |

Each tool declares its result as an `outputSchema` and returns only the IDs, statuses and links the next step needs; the REST API returns the full objects. `file_case`, `file_consent_case`, `run_simulation`, `respond_to_case` and `answer_consent_case` are annotated as destructive, because a filing reaches the other party once you sign and pay, a simulation award is published, and a submitted round or an answer to a consent case cannot be changed, so clients that honour annotations ask you before running them.

The filing, simulation and response tools also require an `idempotency_key`, sent as the API's `Idempotency-Key`. The assistant picks a new value for each request and sends the same value when it retries one that failed or timed out, so the retry returns the first result instead of filing again. If the first attempt is still running, the tool says to wait a minute and retry with the same key. If the key was already used with different arguments, the tool says the first attempt may have gone through and asks you to check your dashboard before filing with a new key. A retry that includes a file of 8 MiB or more always ends that way, because the file is uploaded again.

Signing, payment and identity verification have no tool. When a filing needs one of them, the tool result carries the web link (`action_url`, for both kinds of case) and the assistant hands it to you.

Documents attached in the chat or given as an HTTPS link are passed as a file object: `download_url` and `file_id` are required (ChatGPT fills them in for attachments; other clients may pass the file name as `file_id`), `file_name` and `mime_type` are optional. When neither the name nor the URL has an accepted extension, the type comes from `mime_type`, then the download's `Content-Type`, then the file's first bytes. Text you paste goes in the tool's text argument instead and is sent as a `.txt` file:

| Tool | File arguments | Text arguments |
| --- | --- | --- |
| `file_case` | `contract_file`, `evidence` | `contract_text`, `evidence_text` |
| `file_consent_case` | `contract_files`, `supporting_documents` | `contract_text`, `supporting_text` |
| `run_simulation` | `contract_file`, `plaintiff_documents`, `respondent_documents`, `plaintiff_rebuttal_documents`, `respondent_rebuttal_documents` | `governing_contract`, and the arguments and rebuttals themselves |
| `respond_to_case` | `evidence`, `evidence_response_files`, `counterclaim_files` | `evidence_text`, and the argument itself |

Contracts may be `.pdf`, `.docx`, `.rtf` or `.txt`; evidence may also be `.jpg`, `.jpeg`, `.png`, `.mp4`, `.mov` or `.avi`. Each file can be up to 100 MiB, and one tool call takes at most 10 files, 256 MiB in total. Downloads reach only public addresses.

Five skills guide the conversation: `file-arbitration-case`, `file-consent-case`, `simulate-arbitration-case`, `respond-to-arbitration-case` and `follow-arbitration-case`.

The server side (authorization server, consent page, MCP endpoint and tools) is in the DecisionLayer application repository, under `app/services/oauth_server.py`, `app/services/mcp_server.py`, `app/services/mcp_tools.py` and `app/routers/oauth.py`.

## Running the tools locally with an API key

For development, this repository also contains a small stdio MCP server (`src/`, bundled to `local/server.mjs`) that offers the first eight tools (account, filing, case status, simulation and feedback), with the same arguments and results, against the public API with an API key instead of a sign-in. The eight tools that carry a case forward are on the hosted server only; with an API key, call the REST API for those. It lives outside the plugin folder, so people who install the plugin never download it, and it is not what the plugin uses.

1. Create a key at `https://www.decisionlayer.ai/settings/api-keys` (or a sandbox test key at `/settings/test-api-keys`; test filings skip signing and payment, contact nobody, and never produce an award, and test keys cannot run simulations).
2. Save it: `export DECISIONLAYER_API_KEY=dvarb_...`, or write it to `~/.config/decisionlayer/api_key`.
3. Clone this repository and point your client at the bundle. Running it needs no `npm install`.

```bash
# Claude Code
claude mcp add decisionlayer-local -e DECISIONLAYER_API_KEY=dvarb_... -- node "$PWD/local/server.mjs"

# Codex
codex mcp add decisionlayer-local --env DECISIONLAYER_API_KEY=dvarb_... -- node "$PWD/local/server.mjs"

# MCP Inspector
npm run inspect
```

Leave the `-e` or `--env` flag out to read the key from the key file instead. The three filing and simulation skills in `plugins/decisionlayer/skills/` work with the local server as well; `respond-to-arbitration-case` and `follow-arbitration-case` need the hosted server.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DECISIONLAYER_API_KEY` | none | Your API key. Takes priority over the key file. |
| `DECISIONLAYER_API_KEY_FILE` | `~/.config/decisionlayer/api_key` | Where to read the key from when the variable is not set |
| `DECISIONLAYER_BASE_URL` | `https://www.decisionlayer.ai` | The DecisionLayer environment, e.g. `https://staging.decisionlayer.ai` |
| `DECISIONLAYER_USER_ID` | your account ID | The value sent in `X-DecisionLayer-User` |

In local mode a file object may give `path`, a file on your computer, instead of `download_url`, and `get_account` also reports `key_mode` (`live` or `test`). Every request identifies itself with `X-DecisionLayer-Client`, `X-DecisionLayer-User` and a matching `User-Agent`; the hosted server does the same.

## Development

```bash
npm install
npm test          # builds the local server, runs its tests against a fake DecisionLayer API, and checks the manifests, skills and doc links
npm run typecheck
npm run inspect   # opens the MCP Inspector against the local server
```

```
.agents/plugins/marketplace.json   marketplace entry for Codex and ChatGPT
.claude-plugin/marketplace.json    marketplace entry for Claude Code
plugins/decisionlayer/
  README.md                        what the plugin does, shown as its listing in the directories
  plugin.json                      plugin manifest
  .codex-plugin/plugin.json        the same manifest in the older layout
  .claude-plugin/plugin.json       the same manifest for Claude Code
  mcp.json                         points Codex at the hosted MCP server
  .mcp.json                        points Claude Code at the hosted MCP server
  skills/                          the five skills and the sample case
  assets/                          logo and icon
clients/                           configurations for Claude Code, Claude Desktop, Cursor, VS Code
local/server.mjs                   the local server for use with an API key (generated by npm run build, committed)
src/                               local server source (TypeScript)
test/                              end-to-end tests of the local server, and packaging checks
.github/workflows/ci.yml           runs the tests on Node 20, 22 and 24, the typecheck, the bundle check and Claude Code's plugin validator
```

`local/server.mjs` is a single bundled file so the local mode runs straight from a clone with no `npm install`. After changing anything in `src/`, run `npm run build` and commit the result. Keep the version in `package.json`, all three `plugin.json` files and `src/config.ts` the same; the tests check all of them. CI fails if the committed bundle differs from what `src/` builds to.

## Review account and sample data

OpenAI's reviewers run the five positive and three negative cases in `extensions["com.openai"].review` of the plugin manifest, signed in as the review account. Two of them need data that a new account does not have, so before a package is submitted the review account must be a party to two sample cases, both built from the made-up dispute in [sample-case.md](plugins/decisionlayer/skills/simulate-arbitration-case/references/sample-case.md):

| Sample case | State the review account must find | Used by |
| --- | --- | --- |
| Waiting for a response | The review account is the respondent (the landlord, Riley Tanaka, in the sample dispute). It has claimed the case and signed the arbitration terms, and the case is waiting for the respondent's first response. The claim carries the sample lease as its contract file, as a .txt or a PDF with a text layer, so `get_case_file` can return it. | "Cases and what changed", "Read a case and respond" |
| Decided | The review account is a party, all rounds are on record, and the award is published. | "Cases and what changed", "Read the award" |

The respond case submits a round, and a round can be submitted once. **Reset the first sample case before every review**, including a second review of the same package: afterwards the case is waiting on identity verification, not on a response. Its expected behavior says what the reviewer sees if the round is already on record, but a fresh case is what demonstrates the tool.

The other three positive cases need nothing prepared: the simulation, the consent case (which the reviewer does not sign or pay for, so no invitation is sent), and the listing, which reports the consent case just created. Run all eight cases as the review account before submitting, and record the walkthrough the manifest's `demo_recording_url` points at from the same cases.

## Scope

This version brings a case and carries it to the award, for either party. It does not sign, pay or verify identity, and it does not claim a case filed against you: those are done by you on the DecisionLayer website. It cannot read a video or a PDF that is only scanned pages, or the files on a consent case. Listing simulations, hosted signing sessions and paging past the 50 most recent cases are in the REST API with an API key; see the [API reference](https://www.decisionlayer.ai/api/docs). Nothing the assistant says is legal advice.

## License

[MIT](LICENSE)
