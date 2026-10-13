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
  AttachmentBudget,
  CONTRACT_EXTENSIONS,
  EVIDENCE_EXTENSIONS,
  fileInputSchema,
  InputError,
  resolveFile,
  type FileInput,
  type FileSource,
} from "./files.js";

// The tools mirror DecisionLayer's hosted MCP server: the same names,
// arguments and results, so an agent written against one works with the
// other. This server adds what only makes sense with an API key on the user's
// own computer: `path` file inputs, the key's live/test mode, and guidance for
// test keys.

/** Where an account asks to be approved for filing full cases. */
export const FILING_ACCESS_EMAIL = "casemanager@decisionlayer.ai";

const INSTRUCTIONS =
  "Brings disputes to DecisionLayer arbitration for the user. Call get_account first: it confirms the API key works, whether it is a live or test key, " +
  "and whether the account may file full cases (can_file_cases; consent cases and simulations never need that). " +
  "Never invent facts, names, addresses or amounts: ask the user. Before file_case or file_consent_case, show the user a summary and get an explicit yes; " +
  "with a live key a filing is real, and once the user signs and pays at the link it returns, the other party is notified. " +
  "Before run_simulation, tell the user that the award is published at a public link for 30 days and that the run counts against the account's monthly allowance. " +
  "Signing, payment and identity verification happen on the DecisionLayer website: hand the user the link a tool returns. " +
  "If a tool fails in a way you cannot resolve, or the user wants to tell DecisionLayer something, offer to send a short report with send_feedback. " +
  "Show the user the message and send it only if they agree; it carries their name and email.";

const TRY_LATER =
  "Try again in a few minutes. If it keeps failing, offer to report it with send_feedback, including the reference.";

const money = z
  .union([z.string(), z.number()])
  .optional()
  .describe("Amount demanded in US dollars, e.g. \"3500.00\". Omit or use 0 when no money is sought.");

// The write tools take the key as a required argument: a key made up inside the
// tool would be lost with a timed-out call, and the retry would file again.
const idempotencyKey = z
  .string()
  .min(1)
  .max(255)
  .describe(
    "A new unique value, such as a UUID, for this request. If the call fails or times out, retry with the same value and the same arguments: " +
      "the first result comes back instead of a second one being created. Use a new value only for a new request.",
  );

const files = (description: string) => z.array(fileInputSchema).max(10).optional().describe(description);

const partyType = z.enum(["individual", "organization"]).optional();

const caseId = z.string().regex(/^(case|creq)_[a-z0-9]+$/i, "Expected an ID starting with case_ or creq_.");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
// Filings and simulations cannot be taken back: a filing reaches the other
// party once the user signs and pays, and a simulation award is published at
// a public link. destructiveHint asks the client to confirm with the user.
const IRREVERSIBLE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

// What the tools return: the fields the next step needs, with no timestamps,
// storage paths or other internal detail. Each is the tool's outputSchema.

const accountOutput = {
  name: z.string(),
  email: z.string(),
  can_file_cases: z.boolean().describe("Whether file_case is allowed. file_consent_case does not need it."),
  dashboard_url: z.string().describe("Where the user sees their cases and simulations."),
  key_mode: z.enum(["live", "test"]).describe("Whether the API key is a live key or a sandbox test key."),
};

const profileOutput = z
  .object({
    id: z.string().describe("The DecisionLayer user ID. It never changes."),
    name: z.string().optional(),
    email: z.string().optional(),
  })
  .strict();

const filedOutput = {
  id: z.string().describe("case_ for a case, creq_ for a consent case."),
  status: z.string(),
  action_url: z
    .string()
    .describe("Give this link to the user. Nothing goes to the other party until the user signs and pays there."),
  dashboard_url: z.string(),
};

const caseOutput = {
  id: z.string(),
  status: z.string(),
  role: z.string().describe("The user's side: claimant or respondent."),
  current_turn: z.string().optional().describe("claimant or respondent, when a response is due."),
  action_required: z.boolean().describe("Whether the user has something to do now."),
  next_action: z.string().optional(),
  action_url: z.string().optional().describe("Where the user takes the next action."),
  view_url: z.string().describe("The case page on DecisionLayer."),
  question_for_arbitration: z.string(),
  financial_demand_usd: z.string().optional(),
  respondent_name: z.string(),
};

const simulationOutput = {
  id: z.string(),
  status: z.string().describe("processing, retrying, ready or failed."),
  page_url: z.string().describe("The simulation page on DecisionLayer."),
  text: z.string().optional().describe("The award, once ready."),
  pdf_url: z
    .string()
    .optional()
    .describe("The public award PDF. Served for 30 days after the award is published; absent after that."),
};

const feedbackOutput = { id: z.string().describe("The feedback ID, fb_...") };

/** Explanations for the machine-readable `reason` the API puts on some errors. */
const REASON_HINTS: Record<string, string> = {
  not_claimed:
    "The respondent has not claimed this case yet. They claim it on the DecisionLayer website with the verification code from the notice email.",
  not_a_party: "The connected account is not a party to this case.",
  not_published: "The award has not been published yet.",
};

function moneyString(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" ? value.toFixed(2) : value;
}

/** Leaves out empty fields, as the declared output schemas expect. */
function compact(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null));
}

/** A summary for the assistant, plus the result as text and as data. */
function ok(summary: string, data: Record<string, unknown>): CallToolResult {
  const result = compact(data);
  return {
    content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(result, null, 2)}` }],
    structuredContent: result,
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
    if (error.requestId) lines.push(`Reference: ${error.requestId}`);
    if (error.status >= 500) lines.push(TRY_LATER);
    return lines.join("\n");
  }
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/** Adds a detail to an API error on its way up, so the user sees what to do about it. */
function explain(error: unknown, status: number, detail: string): never {
  if (error instanceof ApiError && error.status === status) error.details.push(detail);
  throw error;
}

/** A file argument's files plus any text pasted for the same field. */
function withText(inputs: FileInput[] | undefined, text: string | undefined): FileSource[] {
  return [...(inputs ?? []), ...(text?.trim() ? [text] : [])];
}

export function createServer(config: Config): McpServer {
  const server = new McpServer(
    { name: "decisionlayer", version: PLUGIN_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const testKey = config.apiKey ? isTestKey(config.apiKey) : false;
  const dashboardUrl = `${config.baseUrl}/dashboard`;

  /** Runs a tool body with an API client, turning every failure into a readable tool error. */
  async function run(body: (client: DecisionLayerClient) => Promise<CallToolResult>): Promise<CallToolResult> {
    if (!config.apiKey) return fail(missingKeyMessage(config.baseUrl, config.transport));
    try {
      return await body(new DecisionLayerClient(config, config.apiKey));
    } catch (error) {
      return fail(describeError(error, config));
    }
  }

  /** Reads every file a call names, under one budget for the whole call. */
  async function resolveParts(
    groups: { field: string; ticketField: string; inputs: FileSource[]; allowed: string[] }[],
  ): Promise<FilePart[]> {
    const budget = new AttachmentBudget(groups.reduce((count, group) => count + group.inputs.length, 0));
    const parts: FilePart[] = [];
    for (const { field, ticketField, inputs, allowed } of groups) {
      for (const [index, input] of inputs.entries()) {
        const file = await resolveFile(input, {
          label: inputs.length > 1 ? `${field}[${index}]` : field,
          allowed,
          transport: config.transport,
          defaultName: inputs.length > 1 ? `${field}_${index + 1}` : field,
          budget,
        });
        parts.push({ field, ticketField, file });
      }
    }
    return parts;
  }

  /** A repeatable evidence-file group, named after its multipart field. */
  const documents = (field: string, inputs: FileSource[]) => ({
    field,
    ticketField: `${field}_tickets`,
    inputs,
    allowed: EVIDENCE_EXTENSIONS,
  });

  server.registerTool(
    "get_account",
    {
      title: "Check DecisionLayer account",
      description:
        "Use this first, and whenever the user asks whether the plugin is set up. Returns the DecisionLayer account the API key belongs to, " +
        "whether it may file cases, and whether the key is a live or sandbox test key.",
      inputSchema: {},
      outputSchema: accountOutput,
      annotations: READ_ONLY,
    },
    () =>
      run(async (client) => {
        const account = await client.get<Account>("/me");
        const name = `${account.first_name} ${account.last_name}`.trim();
        const mode = testKey ? "test" : "live";
        const filing = account.can_file_cases
          ? "The account may file full cases."
          : `The account is not yet approved to file full cases, so file_case would be refused. Consent cases and simulations do not need approval. To request filing access, email ${FILING_ACCESS_EMAIL}.`;
        const notes = testKey
          ? "Test key: filings skip signing, payment and identity checks, send no email, and never produce an award. run_simulation needs a live key."
          : `Live key: filings are real. For a sandbox, create a test key at ${config.baseUrl}${TEST_KEYS_PAGE_PATH}.`;
        return ok(`Connected as ${name} <${account.email}> with a ${mode} key on ${config.baseUrl}. ${filing} ${notes}`, {
          name,
          email: account.email,
          can_file_cases: account.can_file_cases,
          dashboard_url: dashboardUrl,
          key_mode: mode,
        });
      }),
  );

  server.registerTool(
    "get_profile",
    {
      title: "DecisionLayer profile",
      description:
        "Returns the ID, name and email of the DecisionLayer account the API key belongs to, so the client can tell connected accounts apart. " +
        "To check whether the account may file cases, use get_account.",
      inputSchema: {},
      outputSchema: profileOutput,
      annotations: READ_ONLY,
      _meta: { "openai/profile": true },
    },
    () =>
      run(async (client) => {
        const account = await client.get<Account>("/me");
        const name = `${account.first_name} ${account.last_name}`.trim();
        const profile = compact({ id: account.id, name: name || undefined, email: account.email });
        return { content: [{ type: "text", text: JSON.stringify(profile) }], structuredContent: profile };
      }),
  );

  server.registerTool(
    "file_case",
    {
      title: "File an arbitration case",
      description:
        "Use this to bring a full arbitration case under a contract that has an arbitration clause. The other party does not need to agree first. " +
        "The claimant is the API key's account, which must be approved to file (get_account reports can_file_cases). " +
        "With a live key this is a real filing: the user must then sign, pay the filing fee and verify identity at the returned action_url. " +
        "Only call after the user has reviewed a summary and confirmed.",
      inputSchema: {
        question_for_arbitration: z.string().min(1).describe("The question the arbitrator is asked to decide."),
        argument: z.string().min(1).describe("The claimant's opening argument: the facts and why they should win."),
        contract_file: fileInputSchema
          .optional()
          .describe("The contract containing the arbitration clause (.pdf, .docx, .rtf or .txt). Provide this or contract_text."),
        contract_text: z
          .string()
          .optional()
          .describe(
            "The contract's full text, when the user pasted it instead of attaching a file. Sent as a .txt file. Provide this or contract_file.",
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
        evidence: files("Supporting evidence files."),
        evidence_text: z
          .string()
          .optional()
          .describe("Evidence the user pasted as text, such as an email thread. Sent as a .txt file alongside any evidence files."),
        idempotency_key: idempotencyKey,
      },
      outputSchema: filedOutput,
      annotations: IRREVERSIBLE,
      _meta: { "openai/fileParams": ["contract_file", "evidence"] },
    },
    ({ contract_file, contract_text, evidence, evidence_text, claimant_affirmation, financial_demand_usd, idempotency_key, ...fields }) =>
      run(async (client) => {
        if (!claimant_affirmation) {
          throw new InputError(
            "The case was not filed. Ask the user to affirm that the information is accurate and complete, then call again with claimant_affirmation=true.",
          );
        }
        const contract = withText(contract_file ? [contract_file] : [], contract_text);
        if (contract.length !== 1) {
          throw new InputError("Provide the contract as exactly one of contract_file or contract_text.");
        }
        const parts = await resolveParts([
          { field: "contract_file", ticketField: "contract_file_ticket", inputs: contract, allowed: CONTRACT_EXTENSIONS },
          documents("evidence", withText(evidence, evidence_text)),
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
        const record = result.case;
        const summary = record.test
          ? `Test case ${record.id} filed. Signing, payment and identity checks were skipped and no email was sent. It is now waiting on the respondent's first response.`
          : `Case ${record.id} filed. It is not active yet: the user must sign the arbitration terms, pay the filing fee and verify their identity at ${result.action_url}`;
        return ok(summary, {
          id: record.id,
          status: record.status,
          action_url: result.action_url,
          dashboard_url: result.dashboard_url,
        });
      }),
  );

  server.registerTool(
    "file_consent_case",
    {
      title: "File a consent case",
      description:
        "Use this to bring a consent case: both parties agree to submit a dispute to arbitration, so no pre-existing arbitration clause is needed and no filing approval is required. " +
        "The claimant is the API key's account. With a live key this is a real filing: the user signs and pays at the returned action_url, then the respondent is emailed an invitation to accept. " +
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
        contract_files: files("Optional contracts related to the dispute (.pdf, .docx, .rtf, .txt)."),
        contract_text: z
          .string()
          .optional()
          .describe("A contract the user pasted as text. Sent as a .txt file alongside any contract_files."),
        supporting_documents: files("Optional supporting documents."),
        supporting_text: z
          .string()
          .optional()
          .describe(
            "Supporting material the user pasted as text, such as an email thread. Sent as a .txt file alongside any supporting_documents.",
          ),
        idempotency_key: idempotencyKey,
      },
      outputSchema: filedOutput,
      annotations: IRREVERSIBLE,
      _meta: { "openai/fileParams": ["contract_files", "supporting_documents"] },
    },
    ({ contract_files, contract_text, supporting_documents, supporting_text, financial_demand_usd, idempotency_key, ...fields }) =>
      run(async (client) => {
        const parts = await resolveParts([
          {
            field: "contract_files",
            ticketField: "contract_files_tickets",
            inputs: withText(contract_files, contract_text),
            allowed: CONTRACT_EXTENSIONS,
          },
          documents("supporting_documents", withText(supporting_documents, supporting_text)),
        ]);
        const result = await client.postForm<any>(
          "/consent-cases",
          { ...fields, financial_demand_usd: moneyString(financial_demand_usd) },
          parts,
          idempotency_key,
        );
        const record = result.case;
        // The API calls the claimant's signing link sign_url; a test filing has none.
        const actionUrl = result.sign_url || result.dashboard_url;
        const summary = record.test
          ? `Test consent case ${record.id} created (${record.status}). Signing and payment were recorded for the user and no email was sent.`
          : `Consent case ${record.id} created. The respondent is not invited yet: the user must sign and pay at ${actionUrl}`;
        return ok(summary, {
          id: record.id,
          status: record.status,
          action_url: actionUrl,
          dashboard_url: result.dashboard_url,
        });
      }),
  );

  server.registerTool(
    "get_case",
    {
      title: "Check a case",
      description:
        "Use this to check the status of a case or consent case the user is a party to, whose turn it is, and what they need to do next. " +
        "Accepts IDs starting with case_ or creq_. Simulations have their own tool, get_simulation.",
      inputSchema: { case_id: caseId.describe("A case ID (case_...) or consent case ID (creq_...).") },
      outputSchema: caseOutput,
      annotations: READ_ONLY,
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
        if (record.current_turn) {
          parts.push(`It is the ${record.current_turn}'s turn to respond${record.next_round ? ` (round ${record.next_round})` : ""}.`);
        }
        parts.push(
          record.action_required
            ? `Next step for the user: ${record.next_action} at ${record.action_url}`
            : "Nothing is required from the user right now.",
        );
        if (record.view_url) parts.push(`Case page: ${record.view_url}`);
        return ok(parts.join(" "), {
          id: record.id,
          status: record.status,
          role: record.role,
          current_turn: record.current_turn,
          action_required: record.action_required,
          next_action: record.next_action,
          action_url: record.action_url,
          view_url: record.view_url,
          question_for_arbitration: record.question_for_arbitration,
          financial_demand_usd: moneyString(record.financial_demand_usd),
          respondent_name: `${record.respondent_first_name} ${record.respondent_last_name ?? ""}`.trim(),
        });
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
          .describe("The respondent's email address. It identifies who the respondent is, so include it whenever the user has it. Nobody is emailed."),
        plaintiff_argument: z.string().min(1).describe("The claimant's opening argument."),
        respondent_argument: z.string().min(1).describe("The respondent's answer."),
        plaintiff_rebuttal: z.string().optional(),
        respondent_rebuttal: z.string().optional(),
        governing_contract: z.string().optional().describe("The contract text. Provide this or contract_file."),
        contract_file: fileInputSchema.optional().describe("The contract as a file. Provide this or governing_contract."),
        financial_demand_usd: money,
        other_relief: z.string().optional(),
        plaintiff_documents: files("Claimant's evidence."),
        respondent_documents: files("Respondent's evidence."),
        plaintiff_rebuttal_documents: files("Evidence for the claimant's rebuttal."),
        respondent_rebuttal_documents: files("Evidence for the respondent's rebuttal."),
        idempotency_key: idempotencyKey,
      },
      outputSchema: simulationOutput,
      annotations: IRREVERSIBLE,
      _meta: {
        "openai/fileParams": [
          "contract_file",
          "plaintiff_documents",
          "respondent_documents",
          "plaintiff_rebuttal_documents",
          "respondent_rebuttal_documents",
        ],
      },
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
          documents("plaintiff_documents", plaintiff_documents ?? []),
          documents("respondent_documents", respondent_documents ?? []),
          documents("plaintiff_rebuttal_documents", plaintiff_rebuttal_documents ?? []),
          documents("respondent_rebuttal_documents", respondent_rebuttal_documents ?? []),
        ]);
        const result = await client.postForm<any>(
          "/simulations",
          { ...fields, financial_demand_usd: moneyString(financial_demand_usd) },
          parts,
          idempotency_key,
        );
        return ok(`Simulation ${result.id} started (${result.status}). Call get_simulation with this ID to wait for the award.`, {
          id: result.id,
          status: result.status,
          page_url: result.page_url,
        });
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
        simulation_id: z
          .string()
          .regex(/^case_[a-z0-9]+$/i, "Expected an ID starting with case_.")
          .describe("The ID returned by run_simulation (case_...)."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("How long to wait for the award before returning. Defaults to 30."),
      },
      outputSchema: simulationOutput,
      annotations: READ_ONLY,
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
          return ok(`Simulation ${id} is still ${simulation.status}. Call get_simulation again in a moment.`, {
            id: simulation.id,
            status: simulation.status,
            page_url: simulation.page_url,
          });
        }
        const result = await client.get<any>(`/simulations/${id}/result`);
        const award = result.pdf_url
          ? `Award PDF: ${result.pdf_url}`
          : "The public award PDF has expired; it is served for 30 days after the award is published. " +
            `The award text is below, and the simulation page is at ${result.page_url} (sign-in required).`;
        return ok(`Simulation ${id} is ready. ${award}`, {
          id,
          status: "ready",
          page_url: result.page_url,
          text: result.text,
          pdf_url: result.pdf_url,
        });
      }),
  );

  server.registerTool(
    "send_feedback",
    {
      title: "Send feedback to DecisionLayer",
      description:
        "Use this to tell the DecisionLayer team about a problem with these tools, a confusing step, a missing feature, or something that worked well. " +
        "The message is sent with the user's name and email, so show the user what you will send and call this only after they agree. " +
        "Offer it when a tool call failed in a way you could not resolve, or when the user asks to pass something along. " +
        "One short message per call; include the case ID when it concerns a case. The team reads every message. " +
        "It is not a support chat: nobody replies through this tool.",
      inputSchema: {
        message: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            "What happened or what would help, in the user's or your own words. Include the tool name and the error text when reporting a failure. Up to 4000 characters.",
          ),
        category: z.enum(["bug", "idea", "praise", "other"]).optional().describe("bug, idea, praise, or other. Defaults to other."),
        case_id: caseId.optional().describe("A case_ or creq_ ID the feedback is about, if any."),
      },
      outputSchema: feedbackOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ message, category, case_id }) =>
      run(async (client) => {
        if (!message.trim()) throw new InputError("Feedback message must not be empty.");
        const result = await client.postJson<{ id: string; received_at: string; message: string }>("/feedback", {
          message,
          category: category ?? "other",
          case_id: case_id?.toLowerCase() ?? null,
          client: client.clientLabel,
        });
        return ok(
          `Feedback ${result.id} recorded. Thank the user; the team reads every message but does not reply through this tool.`,
          { id: result.id },
        );
      }),
  );

  return server;
}
