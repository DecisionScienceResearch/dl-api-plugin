// End-to-end tests: the bundled MCP server is started over stdio and pointed
// at a fake DecisionLayer API running on localhost.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = new URL("../plugins/decisionlayer/mcp/server.mjs", import.meta.url).pathname;
const ACCOUNT = {
  id: "user_123",
  email: "sam@example.com",
  first_name: "Sam",
  last_name: "Rivera",
  can_file_cases: true,
  created_at: "2026-01-01T00:00:00Z",
};

let api;
let baseUrl;
let requests = [];
let simulationPolls = 0;

async function readForm(req) {
  const request = new Request("http://localhost" + req.url, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half",
  });
  if ((req.headers["content-type"] || "").startsWith("multipart/form-data")) {
    return request.formData();
  }
  return request.text();
}

before(async () => {
  api = createServer(async (req, res) => {
    const body = req.method === "POST" ? await readForm(req) : undefined;
    requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    const send = (status, payload) =>
      res.writeHead(status, { "Content-Type": "application/json", "X-Request-ID": "req_abc" }).end(JSON.stringify(payload));

    if (req.headers.authorization === "Bearer dvarb_bad") {
      return send(401, { error: { status: 401, message: "The API key is not valid.", details: ["Check the key."] } });
    }
    const test = req.headers.authorization.startsWith("Bearer dvarb_test_");
    const canFile = req.headers.authorization !== "Bearer dvarb_nofiling";
    switch (`${req.method} ${req.url}`) {
      case "GET /api/v1/me":
        return send(200, { ...ACCOUNT, can_file_cases: canFile });
      case "POST /api/v1/cases":
        if (!canFile) {
          return send(403, { error: { status: 403, message: "Case filing is limited to approved accounts.", details: [] } });
        }
        if (body.get("respondent_email") === "invalid") {
          return send(422, {
            error: { status: 422, message: "Your request could not be processed.", details: ["Field 'respondent_email' is not a valid email."] },
          });
        }
        if (body.get("respondent_email") === "reused@example.com") {
          return send(409, { error: { status: 409, message: "This Idempotency-Key was already used for a different request.", details: [] } });
        }
        if (body.get("respondent_email") === "running@example.com") {
          return send(409, { error: { status: 409, message: "A request with this Idempotency-Key is still in progress.", details: [] } });
        }
        if (body.get("respondent_email") === "boom@example.com") {
          return send(500, { error: { status: 500, message: "Internal server error.", details: [] } });
        }
        return send(201, {
          case: {
            id: "case_01abc",
            status: test ? "awaiting_response" : "awaiting_signature",
            role: "claimant",
            action_required: !test,
            next_action: test ? null : "sign_terms",
            action_url: test ? null : `${baseUrl}/cases/case_01abc/terms`,
            view_url: `${baseUrl}/cases/case_01abc`,
            test,
          },
          action_url: `${baseUrl}/cases/case_01abc/terms`,
          dashboard_url: `${baseUrl}/dashboard`,
          message: "Case created.",
        });
      case "GET /api/v1/cases/case_01abc":
        return send(200, {
          id: "case_01abc",
          status: "awaiting_response",
          current_turn: "respondent",
          next_round: 1,
          accepted_fields: ["affirmation", "argument", "evidence"],
          role: "claimant",
          action_required: false,
          next_action: null,
          action_url: null,
          view_url: `${baseUrl}/cases/case_01abc`,
          question_for_arbitration: "Must the deposit be returned?",
          financial_demand_usd: "3500.00",
          argument: "The lease ended and the unit was left clean.",
          claimant_email: "sam@example.com",
          respondent_type: "individual",
          respondent_first_name: "Jordan",
          respondent_last_name: "Chen",
          respondent_email: "jordan@example.com",
          signed_at: "2026-10-01T00:00:00Z",
          paid_at: "2026-10-01T00:00:00Z",
          test: false,
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-02T00:00:00Z",
        });
      case "GET /api/v1/cases/case_unclaimed":
        return send(404, { error: { status: 404, message: "Not found.", details: ["Claim the case first."], reason: "not_claimed" } });
      case "GET /api/v1/cases/case_sim1":
        return send(404, { error: { status: 404, message: "Not found.", details: [], reason: "not_found" } });
      case "POST /api/v1/consent-cases":
        return send(201, {
          case: {
            id: "creq_01abc",
            status: test ? "paid" : "ready_to_sign",
            role: "claimant",
            action_required: !test,
            next_action: test ? null : "sign_terms",
            action_url: test ? null : `${baseUrl}/consent/creq_01abc/sign`,
            view_url: `${baseUrl}/consent/creq_01abc`,
            test,
          },
          sign_url: test ? null : `${baseUrl}/consent/creq_01abc/sign`,
          dashboard_url: `${baseUrl}/dashboard`,
        });
      case "GET /api/v1/consent-cases/creq_01abc":
        return send(200, {
          id: "creq_01abc",
          status: "ready_to_sign",
          role: "claimant",
          action_required: true,
          next_action: "sign_terms",
          action_url: `${baseUrl}/sign`,
          view_url: `${baseUrl}/consent/creq_01abc`,
          question_for_arbitration: "Who owes whom for the shared fence?",
          financial_demand_usd: "0.00",
          respondent_type: "organization",
          respondent_first_name: "Acme",
          respondent_last_name: "",
          respondent_email: "legal@acme.example",
          contract_file_paths: ["consent/creq_01abc/contract.pdf"],
          supporting_document_paths: [],
          test: false,
        });
      case "POST /api/v1/simulations":
        return send(201, {
          id: "case_sim1",
          status: "processing",
          page_url: `${baseUrl}/simulation/h/case_sim1`,
          result_url: null,
          message: null,
          created_at: "2026-10-07T16:40:03Z",
        });
      case "GET /api/v1/simulations/case_sim1":
        simulationPolls += 1;
        return send(200, { id: "case_sim1", status: simulationPolls > 1 ? "ready" : "processing", page_url: `${baseUrl}/simulation/h/case_sim1`, result_url: null, message: null });
      case "GET /api/v1/simulations/case_sim1/result":
        return send(200, { id: "case_sim1", case_id: "case_sim1", text: "AWARD: claimant prevails.", published_at: "2026-10-07T16:43:51Z", pdf_url: `${baseUrl}/d/xyz/`, page_url: `${baseUrl}/simulation/h/case_sim1` });
      case "GET /api/v1/simulations/case_sim2":
        return send(200, { id: "case_sim2", status: "ready", page_url: `${baseUrl}/simulation/h/case_sim2`, result_url: null, message: null });
      case "GET /api/v1/simulations/case_sim2/result":
        return send(200, { id: "case_sim2", case_id: "case_sim2", text: "AWARD: respondent prevails.", published_at: "2026-08-01T00:00:00Z", pdf_url: null, page_url: `${baseUrl}/simulation/h/case_sim2` });
      case "POST /api/v1/feedback":
        return send(201, { id: "fb_01abc", received_at: "2026-10-08T12:00:00Z", message: "Thanks, we received your feedback." });
      default:
        return send(404, { error: { status: 404, message: "Not found.", details: [], reason: "not_found" } });
    }
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${api.address().port}`;
});

after(() => api.close());

beforeEach(() => {
  requests = [];
  simulationPolls = 0;
});

async function connect(env) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: {
        PATH: process.env.PATH,
        DECISIONLAYER_BASE_URL: baseUrl,
        DECISIONLAYER_API_KEY_FILE: "/nonexistent",
        ...env,
      },
    }),
  );
  return client;
}

async function call(env, name, args = {}) {
  const client = await connect(env);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

const apiCalls = () => requests.filter((request) => request.path !== "/api/v1/me");

function tempFile(name, contents) {
  const path = join(mkdtempSync(join(tmpdir(), "dl-")), name);
  writeFileSync(path, contents);
  return path;
}

const CASE = {
  question_for_arbitration: "Must the deposit be returned?",
  argument: "The lease ended and the unit was left clean.",
  contract_text: "LEASE. Section 12: disputes go to arbitration.",
  claimant_affirmation: true,
  financial_demand_usd: 3500,
  respondent_first_name: "Jordan",
  respondent_last_name: "Chen",
  respondent_email: "jordan@example.com",
  respondent_street_address: "1 Main St",
  respondent_city: "Austin",
  respondent_state: "TX",
  respondent_zipcode: "78701",
  claimant_street_address: "2 Oak Ave",
  claimant_city: "Austin",
  claimant_state: "TX",
  claimant_zipcode: "78702",
  idempotency_key: "4f9a3c1e-0b7d-4e2a-9c55-1d2e3f4a5b6c",
};

const SIMULATION = {
  question_for_arbitration: "Q",
  plaintiff_name: "Sam Rivera",
  respondent_name: "Jordan Chen",
  plaintiff_argument: "A",
  respondent_argument: "B",
  governing_contract: "Contract text",
  idempotency_key: "sim-key-1",
};

test("lists the tools", async () => {
  const client = await connect({ DECISIONLAYER_API_KEY: "dvarb_live" });
  const { tools } = await client.listTools();
  await client.close();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["file_case", "file_consent_case", "get_account", "get_case", "get_profile", "get_simulation", "run_simulation", "send_feedback"],
  );
});

test("the tools match the hosted server's contract", async () => {
  const client = await connect({ DECISIONLAYER_API_KEY: "dvarb_live" });
  const { tools } = await client.listTools();
  await client.close();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  for (const tool of tools) assert.ok(tool.outputSchema, `${tool.name} declares its output`);

  const writes = ["file_case", "file_consent_case", "run_simulation"];
  for (const name of writes) {
    assert.equal(byName[name].annotations.destructiveHint, true, `${name} is destructive`);
    assert.ok(byName[name].inputSchema.required.includes("idempotency_key"), `${name} requires an idempotency_key`);
  }
  for (const name of ["get_account", "get_profile", "get_case", "get_simulation"]) {
    assert.equal(byName[name].annotations.readOnlyHint, true, `${name} is read-only`);
  }

  // Every file argument is declared as a file param and takes the hosted file object.
  const fileParams = {
    file_case: ["contract_file", "evidence"],
    file_consent_case: ["contract_files", "supporting_documents"],
    run_simulation: ["contract_file", "plaintiff_documents", "respondent_documents", "plaintiff_rebuttal_documents", "respondent_rebuttal_documents"],
  };
  for (const [name, params] of Object.entries(fileParams)) {
    assert.deepEqual(byName[name]._meta["openai/fileParams"], params);
    for (const param of params) {
      const schema = byName[name].inputSchema.properties[param];
      const object = schema.type === "array" ? schema.items : schema;
      assert.deepEqual(Object.keys(object.properties).sort(), ["download_url", "file_id", "file_name", "mime_type", "path"], `${name}.${param}`);
    }
  }
  assert.ok(byName.file_case.inputSchema.properties.contract_text);
  assert.ok(byName.file_case.inputSchema.properties.evidence_text);
  assert.ok(byName.file_consent_case.inputSchema.properties.contract_text);
  assert.ok(byName.file_consent_case.inputSchema.properties.supporting_text);

  assert.equal(byName.get_profile._meta["openai/profile"], true);
  assert.equal(byName.get_account._meta?.["openai/profile"], undefined);
  assert.equal(byName.get_profile.outputSchema.additionalProperties, false);
});

test("get_account reports the account and key mode", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_test_abc" }, "get_account");
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    name: "Sam Rivera",
    email: "sam@example.com",
    can_file_cases: true,
    dashboard_url: `${baseUrl}/dashboard`,
    key_mode: "test",
  });
  assert.match(result.content[0].text, /may file full cases/);
  assert.match(result.content[0].text, /run_simulation needs a live key/);
});

test("get_profile returns only the account's ID, name and email", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "get_profile");
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { id: "user_123", name: "Sam Rivera", email: "sam@example.com" });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test("get_account says when the account is not approved to file full cases", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_nofiling" }, "get_account");
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.can_file_cases, false);
  assert.match(result.content[0].text, /not yet approved to file full cases/);
  assert.match(result.content[0].text, /casemanager@decisionlayer\.ai/);
});

test("every API request identifies the plugin and the user", async () => {
  await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", CASE);
  const [request] = apiCalls();
  assert.equal(request.headers.authorization, "Bearer dvarb_live");
  assert.equal(request.headers["x-decisionlayer-user"], "user_123");
  assert.match(request.headers["x-decisionlayer-client"], /^decisionlayer-chatgpt-plugin\/\d/);
  assert.match(request.headers["user-agent"], /^decisionlayer-chatgpt-plugin\/.*user=user_123/);
});

test("DECISIONLAYER_USER_ID overrides the user identifier", async () => {
  await call({ DECISIONLAYER_API_KEY: "dvarb_live", DECISIONLAYER_USER_ID: "acme-42" }, "file_case", CASE);
  assert.equal(apiCalls()[0].headers["x-decisionlayer-user"], "acme-42");
  assert.equal(requests.length, 1, "no /me lookup is needed");
});

test("file_case sends a multipart filing with the contract and the caller's idempotency key", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", CASE);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /not active yet/);
  assert.deepEqual(result.structuredContent, {
    id: "case_01abc",
    status: "awaiting_signature",
    action_url: `${baseUrl}/cases/case_01abc/terms`,
    dashboard_url: `${baseUrl}/dashboard`,
  });

  const [request] = apiCalls();
  assert.equal(request.path, "/api/v1/cases");
  assert.equal(request.headers["idempotency-key"], CASE.idempotency_key);
  const form = request.body;
  assert.equal(form.get("financial_demand_usd"), "3500.00");
  assert.equal(form.get("claimant_affirmation"), "true");
  assert.equal(form.get("respondent_city"), "Austin");
  assert.equal(form.has("other_relief"), false, "blank optional fields are omitted");
  const contract = form.get("contract_file");
  assert.equal(contract.name, "contract_file.txt");
  assert.match(await contract.text(), /Section 12/);
});

test("file_case sends pasted evidence as a .txt file next to evidence files", async () => {
  const photo = tempFile("photo.png", "\x89PNG\r\n\x1a\nfake");
  await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", {
    ...CASE,
    evidence: [{ path: photo }],
    evidence_text: "From: Jordan\nThe deposit is gone.",
  });
  const evidence = apiCalls()[0].body.getAll("evidence");
  assert.deepEqual(evidence.map((file) => file.name), ["photo.png", "evidence_2.txt"]);
  assert.match(await evidence[1].text(), /The deposit is gone/);
});

test("file_case reads a contract from a local path", async () => {
  const path = tempFile("Lease.pdf", "%PDF-1.4 fake");
  const { contract_text, ...rest } = CASE;
  await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...rest, contract_file: { path } });
  const contract = apiCalls()[0].body.get("contract_file");
  assert.equal(contract.name, "Lease.pdf");
  assert.equal(contract.type, "application/pdf");
});

test("a file without an extension is typed from mime_type, then its leading bytes", async () => {
  const { contract_text, ...rest } = CASE;
  const sniffed = tempFile("lease", "%PDF-1.4 fake");
  await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...rest, contract_file: { path: sniffed } });
  assert.equal(apiCalls()[0].body.get("contract_file").name, "lease.pdf");

  requests = [];
  const declared = tempFile("upload", "{\\rtf1 fake");
  await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", {
    ...rest,
    contract_file: { path: declared, file_id: "file-abc", file_name: "Lease 2026", mime_type: "text/plain; charset=utf-8" },
  });
  const contract = apiCalls()[0].body.get("contract_file");
  assert.equal(contract.name, "Lease 2026.txt");
  assert.equal(contract.type, "text/plain");
});

test("a file name passed as file_id names the file; a ChatGPT file ID does not", async () => {
  const { contract_text, ...rest } = CASE;
  const opaque = tempFile("123", "Plain text with no telling bytes");
  await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...rest, contract_file: { path: opaque, file_id: "contract.txt" } });
  assert.equal(apiCalls()[0].body.get("contract_file").name, "contract.txt");

  requests = [];
  const sniffed = tempFile("lease", "%PDF-1.4 fake");
  await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...rest, contract_file: { path: sniffed, file_id: "file-abc123" } });
  assert.equal(apiCalls()[0].body.get("contract_file").name, "lease.pdf");
});

test("file_case rejects unsupported file types before calling the API", async () => {
  const path = tempFile("lease.exe", "x");
  const { contract_text, ...rest } = CASE;
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...rest, contract_file: { path } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not an accepted file type/);
  assert.equal(apiCalls().length, 0);
});

test("file_case needs exactly one of contract_file and contract_text", async () => {
  const path = tempFile("Lease.pdf", "%PDF-1.4 fake");
  const { contract_text, ...rest } = CASE;
  for (const args of [rest, { ...CASE, contract_file: { path } }]) {
    const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exactly one of contract_file or contract_text/);
  }
  assert.equal(apiCalls().length, 0);
});

test("download_url must be https and reach a public address", async () => {
  const { contract_text, ...rest } = CASE;
  const cases = [
    [`${baseUrl}/lease.pdf`, /must use https/],
    ["https://127.0.0.1/lease.pdf", /not a public address/],
    ["https://localhost/lease.pdf", /not a public address/],
    ["https://[::1]/lease.pdf", /not a public address/],
  ];
  for (const [download_url, error] of cases) {
    const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", {
      ...rest,
      contract_file: { download_url, file_id: "lease.pdf" },
    });
    assert.equal(result.isError, true, download_url);
    assert.match(result.content[0].text, error, download_url);
  }
  assert.equal(apiCalls().length, 0);
});

test("one call accepts at most 10 files", async () => {
  const path = tempFile("receipt.txt", "Receipt");
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", {
    ...CASE,
    evidence: Array.from({ length: 10 }, () => ({ path })),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Too many files: 11 were provided/);
  assert.equal(apiCalls().length, 0);
});

test("the write tools refuse a call without an idempotency_key", async () => {
  const { idempotency_key, ...rest } = CASE;
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", rest);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /idempotency_key/);
  assert.equal(apiCalls().length, 0);
});

test("a refused idempotency key says what the retry means", async () => {
  const reused = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...CASE, respondent_email: "reused@example.com" });
  assert.equal(reused.isError, true);
  assert.match(reused.content[0].text, /first attempt may have gone through/);
  assert.match(reused.content[0].text, /dashboard at http:\/\/127\.0\.0\.1:\d+\/dashboard/);

  const running = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...CASE, respondent_email: "running@example.com" });
  assert.equal(running.isError, true);
  assert.match(running.content[0].text, /still running\. Wait a minute/);
});

test("file_case refuses to file without the user's affirmation", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...CASE, claimant_affirmation: false });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not filed/);
  assert.equal(apiCalls().length, 0);
});

test("file_case reports a test filing as a sandbox case", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_test_abc" }, "file_case", CASE);
  assert.match(result.content[0].text, /^Test case case_01abc filed/);
  assert.match(result.content[0].text, /waiting on the respondent/);
});

test("file_case explains a 403 from an account that may not file", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_nofiling" }, "file_case", CASE);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DecisionLayer error 403/);
  assert.match(result.content[0].text, /approved account/);
  assert.match(result.content[0].text, /casemanager@decisionlayer\.ai/);
});

test("API validation errors are passed through with their details", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...CASE, respondent_email: "invalid" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DecisionLayer error 422/);
  assert.match(result.content[0].text, /respondent_email/);
  assert.match(result.content[0].text, /Reference: req_abc/);
});

test("an API server error says to try again later", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...CASE, respondent_email: "boom@example.com" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DecisionLayer error 500/);
  assert.match(result.content[0].text, /Try again in a few minutes/);
});

const CONSENT = {
  question_for_arbitration: "Who owes whom for the shared fence?",
  financial_demand_usd: "1200.50",
  respondent_first_name: "Jordan",
  respondent_last_name: "Chen",
  respondent_email: "jordan@example.com",
  idempotency_key: "consent-key-1",
};

test("file_consent_case creates a consent case and returns the sign link as action_url", async () => {
  const invoice = tempFile("Invoice.pdf", "%PDF-1.4 invoice");
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_consent_case", {
    ...CONSENT,
    contract_text: "We agree to split the fence.",
    supporting_documents: [{ path: invoice }],
    supporting_text: "Invoice #2",
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /sign and pay at .*creq_01abc\/sign/);
  assert.deepEqual(result.structuredContent, {
    id: "creq_01abc",
    status: "ready_to_sign",
    action_url: `${baseUrl}/consent/creq_01abc/sign`,
    dashboard_url: `${baseUrl}/dashboard`,
  });
  const [request] = apiCalls();
  assert.equal(request.path, "/api/v1/consent-cases");
  assert.equal(request.headers["idempotency-key"], "consent-key-1");
  assert.match(request.headers["content-type"], /^multipart\/form-data/);
  assert.equal(request.body.get("financial_demand_usd"), "1200.50");
  assert.deepEqual(request.body.getAll("contract_files").map((file) => file.name), ["contract_files.txt"]);
  assert.deepEqual(
    request.body.getAll("supporting_documents").map((file) => file.name),
    ["Invoice.pdf", "supporting_documents_2.txt"],
  );
});

test("file_consent_case with a test key points at the dashboard", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_test_abc" }, "file_consent_case", CONSENT);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /^Test consent case creq_01abc created \(paid\)/);
  assert.equal(result.structuredContent.action_url, `${baseUrl}/dashboard`);
});

test("get_case routes creq_ IDs to the consent endpoint", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "get_case", { case_id: "creq_01abc" });
  assert.match(result.content[0].text, /ready_to_sign.*sign_terms/);
  assert.match(result.content[0].text, /Case page: .*\/consent\/creq_01abc/);
  assert.equal(result.structuredContent.respondent_name, "Acme");
  assert.equal(result.structuredContent.financial_demand_usd, "0.00");
});

test("get_case says whose turn it is on a case awaiting a response", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "get_case", { case_id: "case_01abc" });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /case_01abc is awaiting_response and the user is the claimant/);
  assert.match(result.content[0].text, /respondent's turn to respond \(round 1\)/);
  assert.match(result.content[0].text, /Nothing is required from the user/);
  assert.deepEqual(result.structuredContent, {
    id: "case_01abc",
    status: "awaiting_response",
    role: "claimant",
    current_turn: "respondent",
    action_required: false,
    view_url: `${baseUrl}/cases/case_01abc`,
    question_for_arbitration: "Must the deposit be returned?",
    financial_demand_usd: "3500.00",
    respondent_name: "Jordan Chen",
  });
});

test("get_case explains the API's reason for a 404", async () => {
  const unclaimed = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "get_case", { case_id: "case_unclaimed" });
  assert.equal(unclaimed.isError, true);
  assert.match(unclaimed.content[0].text, /has not claimed this case yet/);

  const simulation = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "get_case", { case_id: "case_sim1" });
  assert.equal(simulation.isError, true);
  assert.match(simulation.content[0].text, /use get_simulation/);
});

test("run_simulation with a test key is stopped with guidance", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_test_abc" }, "run_simulation", SIMULATION);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /need a live API key/);
  assert.equal(apiCalls().length, 0);
});

test("run_simulation then get_simulation returns the award", async () => {
  const client = await connect({ DECISIONLAYER_API_KEY: "dvarb_live" });
  const started = await client.callTool({ name: "run_simulation", arguments: SIMULATION });
  assert.deepEqual(started.structuredContent, {
    id: "case_sim1",
    status: "processing",
    page_url: `${baseUrl}/simulation/h/case_sim1`,
  });
  const [request] = apiCalls();
  assert.equal(request.headers["idempotency-key"], "sim-key-1");
  assert.equal(request.body.get("governing_contract"), "Contract text");

  const award = await client.callTool({ name: "get_simulation", arguments: { simulation_id: "case_sim1", wait_seconds: 10 } });
  await client.close();
  assert.equal(award.structuredContent.status, "ready");
  assert.match(award.structuredContent.text, /claimant prevails/);
  assert.match(award.content[0].text, /Award PDF: .*\/d\/xyz\//);
  assert.equal(award.structuredContent.pdf_url, `${baseUrl}/d/xyz/`);
});

test("run_simulation sends the respondent's email and rebuttal evidence", async () => {
  const file = (name) => ({ path: tempFile(name, `${name} contents`) });
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "run_simulation", {
    ...SIMULATION,
    respondent_email: "jordan@example.com",
    plaintiff_rebuttal: "A2",
    respondent_rebuttal: "B2",
    plaintiff_documents: [file("receipt.txt")],
    plaintiff_rebuttal_documents: [file("photo-log.txt")],
    respondent_rebuttal_documents: [file("invoice.txt"), file("email.txt")],
  });
  assert.equal(result.isError, undefined);
  const form = apiCalls()[0].body;
  assert.equal(form.get("respondent_email"), "jordan@example.com");
  assert.equal(form.get("plaintiff_rebuttal"), "A2");
  assert.deepEqual(form.getAll("plaintiff_documents").map((file) => file.name), ["receipt.txt"]);
  assert.deepEqual(form.getAll("plaintiff_rebuttal_documents").map((file) => file.name), ["photo-log.txt"]);
  assert.deepEqual(form.getAll("respondent_rebuttal_documents").map((file) => file.name), ["invoice.txt", "email.txt"]);
});

test("get_simulation still returns the award text after the public PDF expires", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "get_simulation", { simulation_id: "case_sim2", wait_seconds: 0 });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /public award PDF has expired/);
  assert.match(result.content[0].text, /simulation page is at .*\/simulation\/h\/case_sim2 \(sign-in required\)/);
  assert.match(result.structuredContent.text, /respondent prevails/);
  assert.equal("pdf_url" in result.structuredContent, false);
});

test("send_feedback posts a note that names the plugin", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "send_feedback", {
    message: "file_case rejected a .docx contract that opens fine in Word.",
    category: "bug",
    case_id: "CASE_01ABC",
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /^Feedback fb_01abc recorded/);
  assert.deepEqual(result.structuredContent, { id: "fb_01abc" });
  const [request] = apiCalls();
  assert.equal(request.path, "/api/v1/feedback");
  assert.match(request.headers["content-type"], /^application\/json/);
  const body = JSON.parse(request.body);
  assert.equal(body.message, "file_case rejected a .docx contract that opens fine in Word.");
  assert.equal(body.category, "bug");
  assert.equal(body.case_id, "case_01abc");
  assert.match(body.client, /^decisionlayer-chatgpt-plugin\/\d.* \(stdio\)$/);
});

test("a missing key explains how to set one up", async () => {
  const result = await call({}, "get_account");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No DecisionLayer API key is configured/);
  assert.match(result.content[0].text, /settings\/api-keys/);
  assert.equal(requests.length, 0);
});

test("the key can come from a key file", async () => {
  const keyFile = join(mkdtempSync(join(tmpdir(), "dl-")), "api_key");
  writeFileSync(keyFile, "dvarb_live\n");
  const result = await call({ DECISIONLAYER_API_KEY_FILE: keyFile }, "get_account");
  assert.equal(result.structuredContent.key_mode, "live");
});

test("an invalid key is reported clearly", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_bad" }, "get_account");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DecisionLayer error 401/);
});

test("the plugin manifests stay in sync", () => {
  const root = new URL("../plugins/decisionlayer/", import.meta.url);
  const portable = JSON.parse(readFileSync(new URL("plugin.json", root)));
  const legacy = JSON.parse(readFileSync(new URL(".codex-plugin/plugin.json", root)));
  const claude = JSON.parse(readFileSync(new URL(".claude-plugin/plugin.json", root)));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  for (const field of ["name", "version", "description"]) {
    assert.equal(legacy[field], portable[field], field);
    assert.equal(claude[field], portable[field], `claude ${field}`);
  }
  assert.equal(portable.version, pkg.version);
  assert.deepEqual(legacy.interface, portable.extensions["com.openai"].interface);
});

test("every client configuration points at the same hosted server", () => {
  const root = new URL("../", import.meta.url);
  const read = (path) => JSON.parse(readFileSync(new URL(path, root)));
  const hosted = read("plugins/decisionlayer/mcp.json").mcpServers.decisionlayer.url;
  assert.match(hosted, /^https:\/\/www\.decisionlayer\.ai\/mcp$/);
  assert.equal(read("plugins/decisionlayer/.mcp.json").mcpServers.decisionlayer.url, hosted);
  assert.equal(read("clients/claude-code/.mcp.json").mcpServers.decisionlayer.url, hosted);
  assert.equal(read("clients/cursor/mcp.json").mcpServers.decisionlayer.url, hosted);
  assert.equal(read("clients/vscode/mcp.json").servers.decisionlayer.url, hosted);
  assert.equal(read("clients/claude-desktop/claude_desktop_config.json").mcpServers.decisionlayer.args.at(-1), hosted);
  const marketplace = read(".claude-plugin/marketplace.json");
  assert.equal(marketplace.plugins[0].source, "./plugins/decisionlayer");
});
