import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiError, DecisionLayerClient, type Account, type FilePart } from "./api.js";
import {
  isTestKey,
  KEYS_PAGE_PATH,
  missingKeyMessage,
  PLUGIN_VERSION,
  TEST_KEYS_PAGE_PATH,
  type Config,
} from "./config.js";
import {
  CONTRACT_EXTENSIONS,
  EVIDENCE_EXTENSIONS,
  fileInputSchema,
  InputError,
  resolveFile,
  type FileInput,
} from "./files.js";

const INSTRUCTIONS =
  "Brings disputes to DecisionLayer arbitration. Call get_account first to confirm the API key works and whether it is a live or test key. " +
  "Never invent facts, names, addresses or amounts: ask the user. Before file_case or file_consent_case with a live key, show the user a summary and get an explicit yes; " +
  "a live filing is real and contacts the other party. Simulation awards are published at a public link.";

const money = z
  .union([z.string(), z.number()])
  .optional()
  .describe("Amount demanded in US dollars, e.g. \"3500.00\". Omit or use 0 when no money is sought.");

const idempotencyKey = z
  .string()
  .max(255)
  .optional()
  .describe("Reuse the same value when retrying a call that failed or timed out, so nothing is filed twice.");

const partyType = z.enum(["individual", "organization"]).optional();

function moneyString(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? value.toFixed(2) : value;
}

function ok(summary: string, data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function describeError(error: unknown, config: Config): string {
  if (error instanceof InputError) return error.message;
  if (error instanceof ApiError) {
    const lines = [error.status ? `DecisionLayer error ${error.status}: ${error.message}` : error.message];
    for (const detail of error.details) lines.push(`- ${detail}`);
    if (error.status === 401) {
      lines.push(`Check the API key, or create a new one at ${config.baseUrl}${KEYS_PAGE_PATH}.`);
    }
    if (error.requestId) lines.push(`Request ID: ${error.requestId}`);
    return lines.join("\n");
  }
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

export function createServer(config: Config): McpServer {
  const server = new McpServer(
    { name: "decisionlayer", version: PLUGIN_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const testKey = config.apiKey ? isTestKey(config.apiKey) : false;

  /** Runs a tool body with an API client, turning every failure into a readable tool error. */
  async function run(body: (client: DecisionLayerClient) => Promise<CallToolResult>): Promise<CallToolResult> {
    if (!config.apiKey) return fail(missingKeyMessage(config.baseUrl, config.transport));
    try {
      return await body(new DecisionLayerClient(config, config.apiKey));
    } catch (error) {
      return fail(describeError(error, config));
    }
  }

  async function resolveParts(
    groups: { field: string; ticketField: string; inputs: FileInput[]; allowed: string[] }[],
  ): Promise<FilePart[]> {
    const parts: FilePart[] = [];
    for (const { field, ticketField, inputs, allowed } of groups) {
      for (const [index, input] of inputs.entries()) {
        const file = await resolveFile(input, {
          label: inputs.length > 1 ? `${field}[${index}]` : field,
          allowed,
          transport: config.transport,
          defaultName: inputs.length > 1 ? `${field}_${index + 1}` : field,
        });
        parts.push({ field, ticketField, file });
      }
    }
    return parts;
  }

  server.registerTool(
    "get_account",
    {
      title: "Check DecisionLayer account",
      description:
        "Use this first, and whenever the user asks whether the plugin is set up. Confirms the API key works and returns the account it belongs to, " +
        "whether it is a live or sandbox test key, and which DecisionLayer environment is in use.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { "openai/profile": true },
    },
    () =>
      run(async (client) => {
        const account = await client.get<Account>("/me");
        const mode = testKey ? "test" : "live";
        return ok(
          `Connected as ${account.first_name} ${account.last_name} <${account.email}> with a ${mode} key on ${config.baseUrl}.`,
          {
            account,
            key_mode: mode,
            base_url: config.baseUrl,
            notes: testKey
              ? "Test key: filings skip signing, payment and identity checks, send no email, and never produce an award. run_simulation needs a live key."
              : `Live key: filings are real. For a sandbox, create a test key at ${config.baseUrl}${TEST_KEYS_PAGE_PATH}.`,
          },
        );
      }),
  );

  server.registerTool(
    "file_case",
    {
      title: "File an arbitration case",
      description:
        "Use this to bring a full arbitration case under a contract that has an arbitration clause. The other party does not need to agree first. " +
        "The claimant is the API key's account. With a live key this is a real filing: the user must then sign, pay the filing fee and verify identity at the returned action_url. " +
        "Only call after the user has reviewed a summary and confirmed.",
      inputSchema: {
        question_for_arbitration: z.string().min(1).describe("The question the arbitrator is asked to decide."),
        argument: z.string().min(1).describe("The claimant's opening argument: the facts and why they should win."),
        contract_file: fileInputSchema.describe(
          "The contract containing the arbitration clause (.pdf, .docx, .rtf or .txt). Provide exactly one of path, download_url or text.",
        ),
        claimant_affirmation: z
          .boolean()
          .describe("True only if the user has affirmed the information is accurate and complete. Ask them; do not assume."),
        financial_demand_usd: money,
        other_relief: z.string().optional().describe("Non-monetary relief sought."),
        evidence_demands: z.string().optional().describe("Evidence the claimant asks the respondent to produce."),
        arbitration_contract_description: z
          .string()
          .optional()
          .describe("Where the arbitration clause is in the contract, e.g. \"Section 12\"."),
        respondent_type: partyType.describe("Defaults to individual."),
        respondent_first_name: z.string().min(1).max(100).describe("First name, or the organization's name."),
        respondent_last_name: z.string().max(100).optional().describe("Required unless the respondent is an organization."),
        respondent_email: z.string().describe("Where the respondent is notified."),
        respondent_street_address: z.string().min(1).max(255),
        respondent_street_address_2: z.string().max(255).optional(),
        respondent_city: z.string().min(1).max(100),
        respondent_state: z.string().min(1).max(100),
        respondent_zipcode: z.string().min(1).max(20),
        claimant_street_address: z.string().min(1).max(255),
        claimant_street_address_2: z.string().max(255).optional(),
        claimant_city: z.string().min(1).max(100),
        claimant_state: z.string().min(1).max(100),
        claimant_zipcode: z.string().min(1).max(20),
        filing_capacity: z
          .enum(["personal", "organization", "attorney"])
          .optional()
          .describe("Who is filing: the claimant themselves (personal, default), an organization's representative, or an attorney."),
        claimant_legal_name: z
          .string()
          .max(255)
          .optional()
          .describe("Required for organization or attorney filings. Defaults to the account holder's name for personal filings."),
        relationship_to_claimant: z
          .string()
          .max(255)
          .optional()
          .describe("Required for organization or attorney filings, e.g. \"General Counsel\" or \"Attorney\"."),
        title: z.string().max(100).optional().describe("The filer's job title."),
        first_name: z.string().max(100).optional().describe("Filer's first name. Defaults to the account's."),
        last_name: z.string().max(100).optional().describe("Filer's last name. Defaults to the account's."),
        email_address: z.string().optional().describe("Filer's email. Defaults to the account's."),
        street_address: z
          .string()
          .max(255)
          .optional()
          .describe("Filer's own address. Required for organization or attorney filings; defaults to the claimant address otherwise."),
        street_address_2: z.string().max(255).optional(),
        city: z.string().max(100).optional(),
        state: z.string().max(100).optional(),
        zipcode: z.string().max(20).optional(),
        evidence: z.array(fileInputSchema).max(20).optional().describe("Supporting evidence files."),
        idempotency_key: idempotencyKey,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { "openai/fileParams": ["contract_file"] },
    },
    ({ contract_file, evidence, claimant_affirmation, financial_demand_usd, idempotency_key, ...fields }) =>
      run(async (client) => {
        if (!claimant_affirmation) {
          throw new InputError(
            "The case was not filed. Ask the user to affirm that the information is accurate and complete, then call again with claimant_affirmation=true.",
          );
        }
        const parts = await resolveParts([
          { field: "contract_file", ticketField: "contract_file_ticket", inputs: [contract_file], allowed: CONTRACT_EXTENSIONS },
          { field: "evidence", ticketField: "evidence_tickets", inputs: evidence ?? [], allowed: EVIDENCE_EXTENSIONS },
        ]);
        const result = await client.postForm<any>(
          "/cases",
          { ...fields, financial_demand_usd: moneyString(financial_demand_usd), claimant_affirmation: "true" },
          parts,
          idempotency_key,
        );
        const summary = result.case?.test
          ? `Test case ${result.case.id} filed. Signing, payment and identity checks were skipped and no email was sent. It is now waiting on the respondent.`
          : `Case ${result.case?.id} filed. It is not active yet: the user must sign the arbitration terms, pay the filing fee and verify their identity at ${result.action_url}`;
        return ok(summary, result);
      }),
  );

  server.registerTool(
    "file_consent_case",
    {
      title: "File a consent case",
      description:
        "Use this to bring a consent case: both parties agree to submit a dispute to arbitration, so no pre-existing arbitration clause is needed. " +
        "The claimant is the API key's account. With a live key this is a real filing: the user signs and pays at the returned sign_url, then the respondent is emailed an invitation to accept. " +
        "Only call after the user has reviewed a summary and confirmed.",
      inputSchema: {
        question_for_arbitration: z.string().min(1).describe("The question the arbitrator is asked to decide."),
        financial_demand_usd: money,
        other_relief: z.string().optional().describe("Non-monetary relief sought."),
        respondent_type: partyType.describe("Defaults to individual."),
        respondent_first_name: z.string().min(1).max(100).describe("First name, or the organization's name."),
        respondent_last_name: z.string().max(100).optional().describe("Required unless the respondent is an organization."),
        respondent_email: z.string().describe("Must differ from the claimant's email."),
        respondent_contact_first_name: z.string().max(100).optional().describe("Contact person at a respondent organization."),
        respondent_contact_last_name: z.string().max(100).optional(),
        claimant_type: partyType.describe("Defaults to individual."),
        claimant_first_name: z.string().max(100).optional().describe("First name or organization name. Defaults to the account's."),
        claimant_last_name: z.string().max(100).optional().describe("Defaults to the account's."),
        claimant_email: z.string().optional().describe("Defaults to the account's."),
        claimant_contact_first_name: z.string().max(100).optional().describe("Required when the claimant is an organization."),
        claimant_contact_last_name: z.string().max(100).optional().describe("Required when the claimant is an organization."),
        contract_files: z.array(fileInputSchema).max(20).optional().describe("Optional contracts related to the dispute (.pdf, .docx, .rtf, .txt)."),
        supporting_documents: z.array(fileInputSchema).max(20).optional().describe("Optional supporting documents."),
        idempotency_key: idempotencyKey,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ contract_files, supporting_documents, financial_demand_usd, idempotency_key, ...fields }) =>
      run(async (client) => {
        const parts = await resolveParts([
          { field: "contract_files", ticketField: "contract_files_tickets", inputs: contract_files ?? [], allowed: CONTRACT_EXTENSIONS },
          {
            field: "supporting_documents",
            ticketField: "supporting_documents_tickets",
            inputs: supporting_documents ?? [],
            allowed: EVIDENCE_EXTENSIONS,
          },
        ]);
        const result = await client.postForm<any>(
          "/consent-cases",
          { ...fields, financial_demand_usd: moneyString(financial_demand_usd) },
          parts,
          idempotency_key,
        );
        const summary = result.case?.test
          ? `Test consent case ${result.case.id} created. Signing and payment were skipped and no email was sent.`
          : `Consent case ${result.case?.id} created. The respondent is not invited yet: the user must sign and pay at ${result.sign_url ?? result.dashboard_url}`;
        return ok(summary, result);
      }),
  );

  server.registerTool(
    "get_case",
    {
      title: "Check a case",
      description:
        "Use this to check the status of a case or consent case the user filed, and what they need to do next. Accepts IDs starting with case_ or creq_.",
      inputSchema: {
        case_id: z.string().regex(/^(case|creq)_[a-z0-9]+$/i, "Expected an ID starting with case_ or creq_."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ case_id }) =>
      run(async (client) => {
        const id = case_id.toLowerCase();
        const record = await client.get<any>(`/${id.startsWith("creq_") ? "consent-cases" : "cases"}/${id}`);
        const next = record.action_required
          ? `Next step for the user: ${record.next_action} at ${record.action_url}`
          : "Nothing is required from the user right now.";
        return ok(`${id} is ${record.status}. ${next}`, record);
      }),
  );

  server.registerTool(
    "run_simulation",
    {
      title: "Simulate a case",
      description:
        "Use this to try DecisionLayer without filing anything real. Give both sides of a dispute in one call and an AI arbitrator writes an award, usually within a few minutes. " +
        "Nobody is contacted and nothing is owed. Requires a live (non-test) API key and counts against a monthly simulation limit. " +
        "The finished award is published at a public link for 30 days, so tell the user before running and avoid real names if they want privacy. Then poll get_simulation.",
      inputSchema: {
        question_for_arbitration: z.string().min(1).describe("The question the arbitrator is asked to decide."),
        plaintiff_name: z.string().min(1).describe("The claimant's name."),
        respondent_name: z.string().min(1).describe("A single word is treated as an organization; several words as a person's name."),
        plaintiff_argument: z.string().min(1).describe("The claimant's opening argument."),
        respondent_argument: z.string().min(1).describe("The respondent's answer."),
        plaintiff_rebuttal: z.string().optional(),
        respondent_rebuttal: z.string().optional(),
        governing_contract: z.string().optional().describe("The contract text. Provide this or contract_file."),
        contract_file: fileInputSchema.optional().describe("The contract as a file. Provide this or governing_contract."),
        financial_demand_usd: money,
        other_relief: z.string().optional(),
        plaintiff_documents: z.array(fileInputSchema).max(20).optional().describe("Claimant's evidence."),
        respondent_documents: z.array(fileInputSchema).max(20).optional().describe("Respondent's evidence."),
        idempotency_key: idempotencyKey,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { "openai/fileParams": ["contract_file"] },
    },
    ({ contract_file, plaintiff_documents, respondent_documents, financial_demand_usd, idempotency_key, ...fields }) =>
      run(async (client) => {
        if (testKey) {
          throw new InputError(
            `Simulations need a live API key, and this is a test key. Create a live key at ${config.baseUrl}${KEYS_PAGE_PATH}. ` +
              "Running a simulation with a live key files nothing real.",
          );
        }
        if (!fields.governing_contract && !contract_file) {
          throw new InputError("Provide the contract as governing_contract text or as contract_file.");
        }
        const parts = await resolveParts([
          { field: "contract_file", ticketField: "contract_file_ticket", inputs: contract_file ? [contract_file] : [], allowed: CONTRACT_EXTENSIONS },
          {
            field: "plaintiff_documents",
            ticketField: "plaintiff_documents_tickets",
            inputs: plaintiff_documents ?? [],
            allowed: EVIDENCE_EXTENSIONS,
          },
          {
            field: "respondent_documents",
            ticketField: "respondent_documents_tickets",
            inputs: respondent_documents ?? [],
            allowed: EVIDENCE_EXTENSIONS,
          },
        ]);
        const result = await client.postForm<any>(
          "/simulations",
          { ...fields, financial_demand_usd: moneyString(financial_demand_usd) },
          parts,
          idempotency_key,
        );
        return ok(
          `Simulation ${result.id} started (${result.status}). Call get_simulation with this ID to wait for the award.`,
          result,
        );
      }),
  );

  server.registerTool(
    "get_simulation",
    {
      title: "Get a simulation's award",
      description:
        "Use this after run_simulation. Waits briefly for the simulation to finish and returns the award text and links when ready. " +
        "If it is still processing, call again.",
      inputSchema: {
        simulation_id: z.string().regex(/^case_[a-z0-9]+$/i, "Expected an ID starting with case_."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("How long to wait for the award before returning. Defaults to 30."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ simulation_id, wait_seconds }) =>
      run(async (client) => {
        const id = simulation_id.toLowerCase();
        const deadline = Date.now() + (wait_seconds ?? 30) * 1000;
        let simulation = await client.get<any>(`/simulations/${id}`);
        while (simulation.status !== "ready" && simulation.status !== "failed" && Date.now() + 5000 <= deadline) {
          await new Promise((done) => setTimeout(done, 5000));
          simulation = await client.get<any>(`/simulations/${id}`);
        }
        if (simulation.status === "failed") {
          return fail(`Simulation ${id} failed: ${simulation.message || "no reason was given."}`);
        }
        if (simulation.status !== "ready") {
          return ok(`Simulation ${id} is still ${simulation.status}. Call get_simulation again in a moment.`, simulation);
        }
        const result = await client.get<any>(`/simulations/${id}/result`);
        return ok(`Simulation ${id} is ready. Award PDF: ${result.pdf_url}`, { status: "ready", ...result });
      }),
  );

  return server;
}
