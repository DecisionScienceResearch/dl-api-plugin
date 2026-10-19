# DecisionLayer

Bring a case to arbitration with [DecisionLayer](https://www.decisionlayer.ai) from a conversation in ChatGPT, Codex or Claude Code.

- **File a full case** under a contract that has an arbitration clause.
- **File a consent case**, where you invite the other party to agree to arbitrate.
- **Simulate a case** first: give both sides of a dispute and get a written award back in a few minutes, with nothing filed and nobody contacted.

## Install

Claude Code:

```bash
claude plugin marketplace add DecisionScienceResearch/dl-api-plugin
claude plugin install decisionlayer@decisionlayer
```

Codex:

```bash
codex plugin marketplace add DecisionScienceResearch/dl-api-plugin
```

then open the plugin list and install **DecisionLayer**. In a new conversation, say:

> Simulate an arbitration case with DecisionLayer using the sample dispute.

## Sign-in, and what happens to your data

The plugin points your client at DecisionLayer's hosted MCP server, `https://www.decisionlayer.ai/mcp`, and runs no code on your computer. The first time it is used, a browser window opens on decisionlayer.ai: sign in or create an account, review what the app will be able to do, and click **Allow**. There is no key to copy and nothing to configure.

Whatever you give the assistant for a filing or a simulation, such as the contract, the arguments, the parties' names and any documents, is first processed by the application you are using (ChatGPT, Codex or Claude) under that application's own privacy terms, which the plugin does not control. The plugin sends DecisionLayer only what the assistant passes to its tools, and DecisionLayer handles that under its [privacy policy](https://www.decisionlayer.ai/privacy). A case filed here is owned by your account and appears on your dashboard, exactly like one filed on the website. A simulation's award is published at a public link for 30 days, so use made-up names when privacy matters. To disconnect, open **Settings › API keys › Connected apps** on decisionlayer.ai.

[Privacy policy](https://www.decisionlayer.ai/privacy) · [Terms of service](https://www.decisionlayer.ai/terms) · [Contact](https://www.decisionlayer.ai/contact)

## What is in the plugin

Eight tools from the hosted server: `get_account`, `get_profile`, `file_case`, `file_consent_case`, `get_case`, `run_simulation`, `get_simulation` and `send_feedback`. Filing a case and running a simulation are marked destructive, so the assistant asks you before it runs them, and every filing carries an idempotency key so a retry never files twice.

Three skills guide the conversation: `file-arbitration-case`, `file-consent-case` and `simulate-arbitration-case`, which ships with a made-up [sample dispute](skills/simulate-arbitration-case/references/sample-case.md) so you can try it without preparing anything.

Filing a full case is limited to approved accounts; consent cases and simulations are open to every account. To request filing access, email casemanager@decisionlayer.ai. Signing, payment and identity verification happen on the DecisionLayer website at the link a tool returns. Nothing the assistant says is legal advice.

A developer alternative that runs the same eight tools on your own machine with a DecisionLayer API key instead of a sign-in lives in the repository, outside this plugin folder; see the [repository README](../../README.md).

[MIT license](../../LICENSE)
