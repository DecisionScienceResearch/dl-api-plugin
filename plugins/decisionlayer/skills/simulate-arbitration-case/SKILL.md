---
name: simulate-arbitration-case
description: Try DecisionLayer without filing anything by simulating an arbitration case and getting an AI-written award. Use when the user wants to test, demo, try out or simulate DecisionLayer arbitration, see how a dispute might be decided, or run the sample case.
---

Use this skill when the user wants to try DecisionLayer or see how a dispute might be decided. A simulation takes both sides of a dispute in one call and returns a written award, usually within a few minutes. Nobody is contacted, nothing is signed and nothing is owed.

## 1. Check the setup

Call `get_account`.

- If it fails because the user is not authenticated, tell them to connect DecisionLayer: the plugin opens a DecisionLayer sign-in page in their browser, and they click **Allow**. Never ask for a password or API key in the chat.
- If the account reports `key_mode: test` (a developer running the plugin locally with a test key), simulations will be refused; point them at the message from the tool.

## 2. Tell the user two things before running

- **The award is published.** The finished award gets a public link that works for 30 days. Anyone with the link can read it. If the user is simulating a real dispute and wants privacy, offer to replace real names and identifying details with made-up ones.
- **Simulations are limited.** Each account has a monthly allowance.

## 3. Get a case to simulate

Either:

- **Use the sample.** If the user just wants to see it work, read `references/sample-case.md` and use it as written. Tell them it is a made-up dispute.
- **Use their own dispute.** Collect:
  - the question to decide (`question_for_arbitration`),
  - both parties' names (`plaintiff_name`, `respondent_name`), and the respondent's email (`respondent_email`) whenever the user has it, since it identifies who the respondent is,
  - the contract, as text in `governing_contract` or a file in `contract_file`,
  - each side's argument (`plaintiff_argument`, `respondent_argument`),
  - optionally rebuttals (`plaintiff_rebuttal`, `respondent_rebuttal`), an amount (`financial_demand_usd`) and non-monetary relief (`other_relief`),
  - optionally evidence files for each part: `plaintiff_documents` and `respondent_documents` for the arguments, `plaintiff_rebuttal_documents` and `respondent_rebuttal_documents` for the rebuttals.

A simulation needs the respondent's side too. If the user only knows their own side, ask what they expect the other party to say. If they want you to draft the other side's best argument, you may, but show it to them first and label it as your draft. Do not invent contract terms or facts the user did not give you.

Use a respondent name of two or more words for a person. A single-word name is treated as an organization.

## 4. Run it

1. Call `run_simulation`. Keep the returned ID.
2. Call `get_simulation` with that ID. It waits up to about 30 seconds per call. If the status is still `processing` or `retrying`, tell the user it is still working and call again. Most simulations finish within a few minutes.
3. If the status is `failed`, show the message and offer to run it again.
4. If `run_simulation` fails with a 429, the account's monthly allowance is used up; the message says so. Do not retry.

## 5. Show the result

When the simulation is ready:

- Summarize who prevailed, what was awarded, and the main reasons, using only what the award says.
- Give the user the `pdf_url` (public link to the award, served for 30 days) and the `page_url` (requires signing in to DecisionLayer). After the 30 days `pdf_url` is null; the award `text` stays available through `get_simulation`.
- Remind them this was a simulation. It is not a binding award and not legal advice.

If they want to bring the dispute for real, offer the `file-arbitration-case` skill (they have an arbitration clause) or the `file-consent-case` skill (they do not).
