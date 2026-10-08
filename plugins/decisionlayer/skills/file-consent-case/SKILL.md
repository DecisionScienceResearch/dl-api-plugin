---
name: file-consent-case
description: Start a DecisionLayer consent case, where both parties agree to send a dispute to arbitration without needing an existing arbitration clause. Use when the user wants a consent case, wants to invite the other side to arbitrate, or has a dispute but no contract with an arbitration clause.
---

Use this skill when the user wants to bring a consent case with DecisionLayer. In a consent case the user proposes arbitration and the other party is invited to accept. If the user already has a contract with an arbitration clause and does not want to wait for agreement, use the `file-arbitration-case` skill instead.

## 1. Check the setup

Call `get_account`.

- If it fails because the user is not authenticated, tell them to connect DecisionLayer: the plugin opens a DecisionLayer sign-in page in their browser, and they click **Allow**. Never ask for a password or API key in the chat.
- Tell the user which account they are filing as. If the account reports `key_mode: test` (a developer running the plugin locally with a test key), say the filing is a sandbox filing that contacts nobody.

## 2. Collect the case

Everything comes from the user. Do not invent names, emails, amounts or facts.

Required:

| What | Tool field |
| --- | --- |
| The question the arbitrator should decide | `question_for_arbitration` |
| The other party's name | `respondent_first_name`, `respondent_last_name` |
| The other party's email | `respondent_email` |

Optional: `financial_demand_usd`, `other_relief`, `contract_files` and `supporting_documents`.

Details that change what is required:

- **The other party is a company**: set `respondent_type` to `organization` and put the company name in `respondent_first_name`. A contact person can go in `respondent_contact_first_name` and `respondent_contact_last_name`.
- **The user files for a company**: set `claimant_type` to `organization`, put the company name in `claimant_first_name`, and collect `claimant_contact_first_name` and `claimant_contact_last_name`.
- The claimant's name and email default to the account's. The respondent's email must be different from the claimant's.
- For documents, use `download_url` for a file the user attached or linked, or `text` for pasted content.

## 3. Confirm before filing

Show a summary: both parties, the question, the amount, and any files. Say plainly that this is a real filing and that the other party will be emailed an invitation once the user has signed and paid (unless the account is in test mode). Ask whether to go ahead, and wait for a yes.

## 4. File and explain what happens next

Call `file_consent_case`. If the call times out or fails without a clear answer, retry with the same `idempotency_key` and the same arguments. A 409 on the retry means the first attempt is still running: wait a minute and retry again.

After a **live** filing, give the user the `sign_url` and explain:

1. They sign and pay on the DecisionLayer website.
2. DecisionLayer then emails the other party an invitation.
3. The case goes ahead only if the other party accepts and signs.

After a **test** filing, the case comes back with status `paid` and no `sign_url`: signing and payment were recorded for the user and no email was sent.

Give the user the case ID (it starts with `creq_`) and the `view_url` of the case page. Use `get_case` if they ask for the status later. `fully_executed` is the final status, reached once both parties have signed; a consent case keeps its `creq_` ID and does not turn into a `case_` case.

## Limits

- This plugin creates the consent case. It does not sign, pay, or accept on the other party's behalf.
- Do not give legal advice or predict the outcome.
