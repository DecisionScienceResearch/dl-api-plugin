---
name: file-arbitration-case
description: Bring a dispute to arbitration with DecisionLayer by filing a full case under a contract's arbitration clause. Use when the user wants to start, file, bring or open an arbitration case, sue under an arbitration clause, or is unsure which kind of DecisionLayer case they need.
---

Use this skill when the user wants to bring a case to arbitration with DecisionLayer.

## 1. Pick the kind of case

Ask this first if it is not already clear:

- **Full case**: the user has a contract with an arbitration clause that covers the dispute. The other party does not have to agree again. Continue with this skill.
- **Consent case**: there is no arbitration clause, or the user prefers to invite the other party to agree to arbitrate. Switch to the `file-consent-case` skill.
- **Just trying it out**: switch to the `simulate-arbitration-case` skill. Nothing real is filed.

## 2. Check the setup

Call `get_account`.

- If it fails because the user is not authenticated, tell them to connect DecisionLayer: the plugin opens a DecisionLayer sign-in page in their browser, and they click **Allow**. Never ask for a password or API key in the chat.
- Tell the user which account they are filing as. If the account reports `key_mode: test` (a developer running the plugin locally with a test key), say the filing is a sandbox filing that contacts nobody.

## 3. Collect the case

Everything comes from the user or their documents. Do not invent or guess names, addresses, emails, amounts or facts. If something is missing, ask. Ask for a few things at a time, not one long form.

Required:

| What | Tool field |
| --- | --- |
| The contract with the arbitration clause (.pdf, .docx, .rtf or .txt) | `contract_file` |
| The question the arbitrator should decide, in one or two sentences | `question_for_arbitration` |
| The opening argument: what happened and why the user should win | `argument` |
| Respondent's name and email | `respondent_first_name`, `respondent_last_name`, `respondent_email` |
| Respondent's mailing address | `respondent_street_address`, `respondent_city`, `respondent_state`, `respondent_zipcode` |
| Claimant's mailing address | `claimant_street_address`, `claimant_city`, `claimant_state`, `claimant_zipcode` |

Optional: `financial_demand_usd`, `other_relief`, `evidence_demands`, `arbitration_contract_description` (where the clause is, such as "Section 12"), and `evidence` files.

Details that change what is required:

- **Respondent is a company**: set `respondent_type` to `organization`, put the company name in `respondent_first_name`, and leave the last name out.
- **Who is filing**: `filing_capacity` defaults to `personal`, meaning the account holder is the claimant. If the user files for a company (`organization`) or a client (`attorney`), also collect `claimant_legal_name`, `relationship_to_claimant`, and the filer's own `street_address`, `city`, `state` and `zipcode`.
- **The contract**: use `contract_file.download_url` for a file the user attached or linked, or `contract_file.text` when they pasted the contract into the chat. (`contract_file.path` exists only when a developer runs the plugin locally.)

You may help the user write a clear question and argument from what they tell you. Show them your draft and let them change it; it is filed in their name.

## 4. Confirm before filing

Show a summary: the parties, the question, the amount, the argument, and the files. Say plainly that this is a real filing (or a sandbox filing, if the account is in test mode). Then ask two things and wait for the answers:

1. Do they want to file this now?
2. Do they affirm that the information is accurate and complete?

Only set `claimant_affirmation` to true if the user said so in this conversation.

## 5. File and explain what happens next

Call `file_case`. If the call times out or fails without a clear answer, retry with the same `idempotency_key` so the case is not filed twice.

If the tool returns validation problems, show them to the user, fix them together and file again.

After a **live** filing, give the user the `action_url` and explain that the case is not active until they:

1. sign the arbitration terms,
2. pay the filing fee, and
3. verify their identity.

These three steps happen on the DecisionLayer website, not here. After that, DecisionLayer notifies the respondent.

After a **test** filing, explain that those steps were skipped and no one was contacted.

Give the user the case ID. They can ask for the status later; use `get_case`.

## Limits

- This plugin files cases. It does not submit later-round responses, sign, pay, or act for the respondent.
- Do not give legal advice or predict the outcome. You may explain how DecisionLayer's process works.
