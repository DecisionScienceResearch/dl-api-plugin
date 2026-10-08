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

/** Where an account asks to be approved for filing full cases. */
export const FILING_ACCESS_EMAIL = "casemanager@decisionlayer.ai";

const INSTRUCTIONS =
  "Brings disputes to DecisionLayer arbitration. Call get_account first to confirm the API key works, whether it is a live or test key, " +
  "and whether the account may file full cases (can_file_cases; consent cases and simulations never need that). " +
  "Never invent facts, names, addresses or amounts: ask the user. Before file_case or file_consent_case with a live key, show the user a summary and get an explicit yes; " +
  "a live filing is real and contacts the other party. Before run_simulation, tell the user that the award is published at a public link for 30 days " +
  "and that the run counts against the account's monthly allowance. Signing, payment and identity verification happen on the DecisionLayer website: " +
  "hand the user the link a tool returns. When a tool call fails or a field is confusing, send_feedback tells the DecisionLayer team.";

const money = z
  .union([z.string(), z.number()])
  .optional()
  .describe("Amount demanded in US dollars, e.g. \"3500.00\". Omit or use 0 when no money is sought.");

const idempotencyKey = z
  .string()
  .max(255)
  .optional()
  .describe(
    "Reuse the same value when retrying a call that failed or timed out, so nothing is filed twice. " +
      "The retry must send the same arguments; a retry made while the first attempt is still running returns 409 for about a minute.",
  );

const partyType = z.enum(["individual", "organization"]).optional();

const caseId = z.string().regex(/^(case|creq)_[a-z0-9]+$/i, "Expected an ID starting with case_ or creq_.");

/** Explanations for the machine-readable `reason` the API puts on some errors. */
const REASON_HINTS: Record<string, string> = {
  not_claimed:
    "The respondent has not claimed this case yet. They claim it on the DecisionLayer website with the verification code from the notice email.",
  not_a_party: "The connected account is not a party to this case.",
  not_published: "The award has not been published yet.",
};

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
    if (error.reason && REASON_HINTS[error.reason]) lines.push(REASON_HINTS[error.reason]);
    if (error.status === 401) {
      lines.push(`Check the API key, or create a new one at ${config.baseUrl}${KEYS_PAGE_PATH}.`);
    }
    if (error.status === 409) {
      lines.push(
        "If this was a retry, the first attempt may still be running: wait a minute, then call again with the same idempotency_key and the same arguments.",
      );
    }
    if (error.requestId) lines.push(`Request ID: ${error.requestId}`);
    return lines.join("\n");
  }
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/** Adds a detail to an API error on its way up, so the user sees what to do about it. */
function explain(error: unknown, status: number, detail: string): never {
  if (error instanceof ApiError && error.status === status) error.details.push(detail);
  throw error;
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

  /** A repeatable evidence-file group, named after its multipart field. */
  const documents = (field: string, inputs: FileInput[] | undefined) => ({
    field,
    ticketField: `${field}_tickets`,
    inputs: inputs ?? [],
    allowed: EVIDENCE_EXTENSIONS,
  });

  server.registerTool(
    "get_account",
    {
      title: "Check DecisionLayer account",
      description:
        "Use this first, and whenever the user asks whether the plugin is set up. Confirms the API key works and returns the account it belongs to, " +
        "whether it is a live or sandbox test key, whether the account may file full cases (can_file_cases), and which DecisionLayer environment is in use.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { "openai/profile": true },
    },
    () =>
      run(async (client) => {
        const account = await client.get<Account>("/me");
        const mode = testKey ? "test" : "live";
        const filing = account.can_file_cases
          ? "The account may file full cases."
          : `The account is not yet approved to file full cases, so file_case would be refused. Consent cases and simulations do not need approval. To request filing access, email ${FILING_ACCESS_EMAIL}.`;
        return ok(
          `Connected as ${account.first_name} ${account.last_name} <${account.email}> with a ${mode} key on ${config.baseUrl}. ${filing}`,
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
        "The claimant is the API key's account, which must be approved to file (get_account reports can_file_cases). " +
        "With a live key this is a real filing: the user must then sign, pay the filing fee and verify identity, starting at the returned action_url. " +
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
          .describe("Required for organization or attorney filings. For personal filings it defaults to the account holder's name."),
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
        const result = await client
          .postForm<any>(
            "/cases",
            { ...fields, financial_demand_usd: moneyString(financial_demand_usd), claimant_affirmation: "true" },
            parts,
            idempotency_key,
          )
          .catch((error) =>
            explain(
              error,
              403,
              `Filing a full case needs an approved account; get_account reports this as can_file_cases. Consent cases and simulations do not need approval. To request filing access, email ${FILING_ACCESS_EMAIL}.`,
            ),
          );
        const record = result.case ?? {};
        const summary = record.test
          ? `Test case ${record.id} filed. Signing, payment and identity checks were skipped and no email was sent. It is now waiting on the respondent's first response.`
          : `Case ${record.id} filed (${record.status}). It is not active yet: the user must sign the arbitration terms, pay the filing fee and verify their identity, starting at ${result.action_url}`;
        return ok(record.view_url ? `${summary}\nCase page: ${record.view_url}` : summary, result);
      }),
  );

  server.registerTool(
    "file_consent_case",
    {
      title: "File a consent case",
      description:
        "Use this to bring a consent case: both parties agree to submit a dispute to arbitration, so no pre-existing arbitration clause is needed and no filing approval is required. " +
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
          documents("supporting_documents", supporting_documents),
        ]);
        const result = await client.postForm<any>(
          "/consent-cases",
          { ...fields, financial_demand_usd: moneyString(financial_demand_usd) },
          parts,
          idempotency_key,
        );
        const record = result.case ?? {};
        const summary = record.test
          ? `Test consent case ${record.id} created. Signing and payment were skipped and no email was sent.`
          : `Consent case ${record.id} created (${record.status}). The respondent is not invited yet: the user must sign and pay at ${result.sign_url ?? record.action_url ?? result.dashboard_url}`;
        return ok(record.view_url ? `${summary}\nCase page: ${record.view_url}` : summary, result);
      }),
  );

  server.registerTool(
    "get_case",
    {
      title: "Check a case",
      description:
        "Use this to check the status of a case or consent case the user is a party to, whose turn it is, and what they need to do next. " +
        "Accepts IDs starting with case_ or creq_. Simulations have their own tool, get_simulation.",
      inputSchema: { case_id: caseId },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ case_id }) =>
      run(async (client) => {
        const id = case_id.toLowerCase();
        const consent = id.startsWith("creq_");
        const record = await client
          .get<any>(`/${consent ? "consent-cases" : "cases"}/${id}`)
          .catch((error) =>
            explain(
              error,
              404,
              consent ? "Check the ID on the user's dashboard." : "Simulation IDs also start with case_: if this is a simulation, use get_simulation.",
            ),
          );
        const parts = [`${id} is ${record.status}${record.role ? ` and the user is the ${record.role}` : ""}.`];
        if (record.status === "awaiting_response" && record.current_turn) {
          parts.push(`It is the ${record.current_turn}'s turn${record.next_round ? ` (round ${record.next_round})` : ""}.`);
        }
        parts.push(
          record.action_required
            ? `Next step for the user: ${record.next_action} at ${record.action_url}`
            : "Nothing is required from the user right now.",
        );
        if (record.view_url) parts.push(`Case page: ${record.view_url}`);
        return ok(parts.join(" "), record);
      }),
  );

  server.registerTool(
    "run_simulation",
    {
      title: "Simulate a case",
      description:
        "Use this to try DecisionLayer without filing anything real. Give both sides of a dispute in one call and an AI arbitrator writes an award, usually within a few minutes. " +
        "Nobody is contacted and nothing is owed. Requires a live (non-test) API key and counts against the account's monthly allowance (a 429 says when it is used up). " +
        "The finished award is published at a public link for 30 days, so tell the user before running and avoid real names if they want privacy. Then poll get_simulation.",
      inputSchema: {
        question_for_arbitration: z.string().min(1).describe("The question the arbitrator is asked to decide."),
        plaintiff_name: z.string().min(1).describe("The claimant's name."),
        respondent_name: z.string().min(1).describe("A single word is treated as an organization; several words as a person's name."),
        respondent_email: z
          .string()
          .optional()
          .describe("The respondent's email address. It identifies who the respondent is, so include it whenever the user has it."),
        plaintiff_argument: z.string().min(1).describe("The claimant's opening argument."),
        respondent_argument: z.string().min(1).describe("The respondent's answer."),
        plaintiff_rebuttal: z.string().optional(),
        respondent_rebuttal: z.string().optional(),
        governing_contract: z.string().optional().describe("The contract text. Provide this or contract_file."),
        contract_file: fileInputSchema.optional().describe("The contract as a file. Provide this or governing_contract."),
        financial_demand_usd: money,
        other_relief: z.string().optional(),
        plaintiff_documents: z.array(fileInputSchema).max(20).optional().describe("Evidence for the claimant's opening argument."),
        respondent_documents: z.array(fileInputSchema).max(20).optional().describe("Evidence for the respondent's answer."),
        plaintiff_rebuttal_documents: z.array(fileInputSchema).max(20).optional().describe("Evidence for the claimant's rebuttal."),
        respondent_rebuttal_documents: z.array(fileInputSchema).max(20).optional().describe("Evidence for the respondent's rebuttal."),
        idempotency_key: idempotencyKey,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { "openai/fileParams": ["contract_file"] },
    },
    ({
      contract_file,
      plaintiff_documents,
      respondent_documents,
      plaintiff_rebuttal_documents,
      respondent_rebuttal_documents,
      financial_demand_usd,
      idempotency_key,
      ...fields
    }) =>
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
          documents("plaintiff_documents", plaintiff_documents),
          documents("respondent_documents", respondent_documents),
          documents("plaintiff_rebuttal_documents", plaintiff_rebuttal_documents),
          documents("respondent_rebuttal_documents", respondent_rebuttal_documents),
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
        "If it is still processing or retrying, call again.",
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
        const pdf = result.pdf_url
          ? `Award PDF (public for 30 days): ${result.pdf_url}`
          : "The public PDF link has expired; the award text is still in the result.";
        return ok(`Simulation ${id} is ready. ${pdf}`, { status: "ready", ...result });
      }),
  );

  server.registerTool(
    "send_feedback",
    {
      title: "Send feedback to DecisionLayer",
      description:
        "Use this to tell the DecisionLayer team about a problem or an idea: a tool call that failed, a confusing field, a missing step, or something that worked well. " +
        "Describe what was attempted and what happened; do not include the user's documents or personal details. The note is tied to the connected account so the team can follow up. " +
        "Tell the user that feedback was sent.",
      inputSchema: {
        message: z.string().min(1).max(4000).describe("What went wrong, what was confusing, or what would help."),
        category: z.enum(["bug", "idea", "praise", "other"]).optional().describe("Defaults to other."),
        case_id: caseId.optional().describe("The case_ or creq_ ID the feedback is about, if any."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ message, category, case_id }) =>
      run(async (client) => {
        const result = await client.postJson<{ id: string; received_at: string; message: string }>("/feedback", {
          message,
          category: category ?? "other",
          case_id: case_id?.toLowerCase() ?? null,
          client: client.clientLabel,
        });
        return ok(`Feedback ${result.id} was sent to the DecisionLayer team.`, result);
      }),
  );

  return server;
}
