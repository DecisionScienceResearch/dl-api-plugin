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
    switch (`${req.method} ${req.url}`) {
      case "GET /api/v1/me":
        return send(200, ACCOUNT);
      case "POST /api/v1/cases":
        if (body.get("respondent_email") === "invalid") {
          return send(422, {
            error: { status: 422, message: "Your request could not be processed.", details: ["Field 'respondent_email' is not a valid email."] },
          });
        }
        return send(201, {
          case: { id: "case_01abc", status: test ? "awaiting_response" : "awaiting_signature", test },
          action_url: `${baseUrl}/cases/case_01abc/terms`,
          dashboard_url: `${baseUrl}/dashboard`,
          message: "Case created.",
        });
      case "POST /api/v1/consent-cases":
        return send(201, {
          case: { id: "creq_01abc", status: "ready_to_sign", test: false },
          sign_url: `${baseUrl}/consent/creq_01abc/sign`,
          dashboard_url: `${baseUrl}/dashboard`,
        });
      case "GET /api/v1/consent-cases/creq_01abc":
        return send(200, { id: "creq_01abc", status: "ready_to_sign", action_required: true, next_action: "sign_terms", action_url: `${baseUrl}/sign` });
      case "POST /api/v1/simulations":
        return send(201, { id: "case_sim1", status: "processing", page_url: `${baseUrl}/simulation/h/case_sim1` });
      case "GET /api/v1/simulations/case_sim1":
        simulationPolls += 1;
        return send(200, { id: "case_sim1", status: simulationPolls > 1 ? "ready" : "processing" });
      case "GET /api/v1/simulations/case_sim1/result":
        return send(200, { id: "case_sim1", text: "AWARD: claimant prevails.", pdf_url: `${baseUrl}/d/xyz/`, page_url: `${baseUrl}/simulation/h/case_sim1` });
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

const CASE = {
  question_for_arbitration: "Must the deposit be returned?",
  argument: "The lease ended and the unit was left clean.",
  contract_file: { text: "LEASE. Section 12: disputes go to arbitration." },
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
};

test("lists the tools", async () => {
  const client = await connect({ DECISIONLAYER_API_KEY: "dvarb_live" });
  const { tools } = await client.listTools();
  await client.close();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["file_case", "file_consent_case", "get_account", "get_case", "get_simulation", "run_simulation"],
  );
});

test("get_account reports the account and key mode", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_test_abc" }, "get_account");
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.key_mode, "test");
  assert.equal(result.structuredContent.account.email, "sam@example.com");
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

test("file_case sends a multipart filing with the contract and an idempotency key", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", CASE);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /not active yet/);
  assert.equal(result.structuredContent.case.id, "case_01abc");

  const [request] = apiCalls();
  assert.equal(request.path, "/api/v1/cases");
  assert.match(request.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  const form = request.body;
  assert.equal(form.get("financial_demand_usd"), "3500.00");
  assert.equal(form.get("claimant_affirmation"), "true");
  assert.equal(form.get("respondent_city"), "Austin");
  assert.equal(form.has("other_relief"), false, "blank optional fields are omitted");
  const contract = form.get("contract_file");
  assert.equal(contract.name, "contract_file.txt");
  assert.match(await contract.text(), /Section 12/);
});

test("file_case reads a contract from a local path", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "dl-")), "Lease.pdf");
  writeFileSync(path, "%PDF-1.4 fake");
  await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...CASE, contract_file: { path } });
  const contract = apiCalls()[0].body.get("contract_file");
  assert.equal(contract.name, "Lease.pdf");
  assert.equal(contract.type, "application/pdf");
});

test("file_case rejects unsupported file types before calling the API", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "dl-")), "lease.exe");
  writeFileSync(path, "x");
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...CASE, contract_file: { path } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not an accepted file type/);
  assert.equal(apiCalls().length, 0);
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
});

test("API validation errors are passed through with their details", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_case", { ...CASE, respondent_email: "invalid" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DecisionLayer error 422/);
  assert.match(result.content[0].text, /respondent_email/);
  assert.match(result.content[0].text, /Request ID: req_abc/);
});

test("file_consent_case creates a consent case and returns the sign link", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "file_consent_case", {
    question_for_arbitration: "Who owes whom for the shared fence?",
    financial_demand_usd: "1200.50",
    respondent_first_name: "Jordan",
    respondent_last_name: "Chen",
    respondent_email: "jordan@example.com",
    supporting_documents: [{ text: "Invoice #1" }, { text: "Invoice #2" }],
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /creq_01abc\/sign/);
  const [request] = apiCalls();
  assert.equal(request.path, "/api/v1/consent-cases");
  assert.match(request.headers["content-type"], /^multipart\/form-data/);
  assert.equal(request.body.get("financial_demand_usd"), "1200.50");
  assert.deepEqual(
    request.body.getAll("supporting_documents").map((file) => file.name),
    ["supporting_documents_1.txt", "supporting_documents_2.txt"],
  );
});

test("get_case routes creq_ IDs to the consent endpoint", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_live" }, "get_case", { case_id: "creq_01abc" });
  assert.match(result.content[0].text, /ready_to_sign.*sign_terms/);
});

test("run_simulation with a test key is stopped with guidance", async () => {
  const result = await call({ DECISIONLAYER_API_KEY: "dvarb_test_abc" }, "run_simulation", {
    question_for_arbitration: "Q",
    plaintiff_name: "Sam Rivera",
    respondent_name: "Jordan Chen",
    plaintiff_argument: "A",
    respondent_argument: "B",
    governing_contract: "Contract text",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /need a live API key/);
  assert.equal(apiCalls().length, 0);
});

test("run_simulation then get_simulation returns the award", async () => {
  const client = await connect({ DECISIONLAYER_API_KEY: "dvarb_live" });
  const started = await client.callTool({
    name: "run_simulation",
    arguments: {
      question_for_arbitration: "Q",
      plaintiff_name: "Sam Rivera",
      respondent_name: "Jordan Chen",
      plaintiff_argument: "A",
      respondent_argument: "B",
      governing_contract: "Contract text",
    },
  });
  assert.equal(started.structuredContent.id, "case_sim1");
  const form = apiCalls()[0].body;
  assert.equal(form.get("governing_contract"), "Contract text");

  const award = await client.callTool({ name: "get_simulation", arguments: { simulation_id: "case_sim1", wait_seconds: 10 } });
  await client.close();
  assert.equal(award.structuredContent.status, "ready");
  assert.match(award.structuredContent.text, /claimant prevails/);
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

test("the two plugin manifests stay in sync", () => {
  const root = new URL("../plugins/decisionlayer/", import.meta.url);
  const portable = JSON.parse(readFileSync(new URL("plugin.json", root)));
  const legacy = JSON.parse(readFileSync(new URL(".codex-plugin/plugin.json", root)));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  for (const field of ["name", "version", "description"]) assert.equal(legacy[field], portable[field], field);
  assert.equal(portable.version, pkg.version);
  assert.deepEqual(legacy.interface, portable.extensions["com.openai"].interface);
});
