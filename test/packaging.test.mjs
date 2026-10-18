// Static checks on what ships from this repository: the plugin and
// marketplace manifests, the skills, the client configurations and the links
// in the docs. None of them starts the server.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PLUGIN = join(ROOT, "plugins/decisionlayer");
const SKILLS = join(PLUGIN, "skills");

const read = (path) => readFileSync(join(ROOT, path), "utf8");
const readJson = (path) => JSON.parse(read(path));

/** Every file in the repository, relative to its root, except dependencies and git's own. */
function repoFiles(dir = ROOT) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? repoFiles(path) : [relative(ROOT, path)];
  });
}

const skillNames = () =>
  readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

test("every JSON file parses", () => {
  const files = repoFiles().filter((path) => path.endsWith(".json"));
  assert.ok(files.length > 0);
  for (const path of files) assert.doesNotThrow(() => JSON.parse(read(path)), path);
});

test("the plugin manifests stay in sync", () => {
  const portable = readJson("plugins/decisionlayer/plugin.json");
  const legacy = readJson("plugins/decisionlayer/.codex-plugin/plugin.json");
  const claude = readJson("plugins/decisionlayer/.claude-plugin/plugin.json");
  const pkg = readJson("package.json");
  for (const field of ["name", "version", "description"]) {
    assert.equal(legacy[field], portable[field], field);
    assert.equal(claude[field], portable[field], `claude ${field}`);
  }
  assert.equal(portable.version, pkg.version);
  assert.deepEqual(legacy.interface, portable.extensions["com.openai"].interface);
});

test("every client configuration points at the same hosted server", () => {
  const hosted = readJson("plugins/decisionlayer/mcp.json").mcpServers.decisionlayer.url;
  assert.match(hosted, /^https:\/\/www\.decisionlayer\.ai\/mcp$/);
  assert.equal(readJson("plugins/decisionlayer/.mcp.json").mcpServers.decisionlayer.url, hosted);
  assert.equal(readJson("clients/claude-code/.mcp.json").mcpServers.decisionlayer.url, hosted);
  assert.equal(readJson("clients/cursor/mcp.json").mcpServers.decisionlayer.url, hosted);
  assert.equal(readJson("clients/vscode/mcp.json").servers.decisionlayer.url, hosted);
  assert.equal(readJson("clients/claude-desktop/claude_desktop_config.json").mcpServers.decisionlayer.args.at(-1), hosted);
});

test("both marketplaces list the plugin under its manifest's name", () => {
  for (const plugin of readJson(".claude-plugin/marketplace.json").plugins) {
    assert.equal(readJson(join(plugin.source, ".claude-plugin/plugin.json")).name, plugin.name, plugin.source);
  }
  for (const plugin of readJson(".agents/plugins/marketplace.json").plugins) {
    assert.equal(plugin.source.source, "local");
    assert.equal(readJson(join(plugin.source.path, ".codex-plugin/plugin.json")).name, plugin.name, plugin.source.path);
  }
});

test("every path a manifest names exists", () => {
  const codex = readJson("plugins/decisionlayer/.codex-plugin/plugin.json");
  const portable = readJson("plugins/decisionlayer/plugin.json").extensions["com.openai"].interface;
  const local = readJson("plugins/decisionlayer/mcp.local.json").mcpServers.decisionlayer;
  const paths = [
    codex.skills,
    codex.mcpServers,
    codex.interface.composerIcon,
    codex.interface.logo,
    ...codex.interface.screenshots,
    portable.composerIcon,
    portable.logo,
    ...local.args,
  ];
  for (const path of paths) assert.ok(existsSync(join(PLUGIN, path)), path);
});

test("every skill has a valid name matching its folder and a description", () => {
  const names = skillNames();
  assert.ok(names.length > 0);
  for (const skill of names) {
    const text = readFileSync(join(SKILLS, skill, "SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(frontmatter, `${skill}: SKILL.md starts with YAML frontmatter`);
    const fields = Object.fromEntries(frontmatter[1].split("\n").map((line) => line.split(/:\s*(.*)/s).slice(0, 2)));
    assert.equal(fields.name, skill, `${skill}: name matches the folder`);
    assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${skill}: name is lowercase words joined by hyphens`);
    assert.ok(fields.name.length <= 64, `${skill}: name is at most 64 characters`);
    assert.ok(fields.description, `${skill}: has a description`);
    assert.ok(fields.description.length <= 1024, `${skill}: description is at most 1024 characters`);
  }
});

test("every file a skill tells the assistant to read is bundled with it", () => {
  for (const skill of skillNames()) {
    const text = readFileSync(join(SKILLS, skill, "SKILL.md"), "utf8");
    for (const [, path] of text.matchAll(/`((?:references|scripts|assets)\/[^`\s]+)`/g)) {
      assert.ok(existsSync(join(SKILLS, skill, path)), `${skill}: ${path}`);
    }
  }
});

test("relative links in the docs point at files that exist", () => {
  const docs = repoFiles().filter((path) => path.endsWith(".md"));
  assert.ok(docs.length > 0);
  for (const doc of docs) {
    for (const [, target] of read(doc).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      assert.ok(existsSync(join(ROOT, dirname(doc), target.split("#")[0])), `${doc} links to ${target}`);
    }
  }
});

// The Codex and ChatGPT side reads mcp.json through the agent-plugins schema,
// which is closed: a server entry may carry only the fields below. OpenAI adds
// an `extensions` object on each server for the authentication declaration.
const SERVER_FIELDS = {
  "streamable-http": ["type", "url", "headers", "extensions"],
  stdio: ["type", "command", "args", "env", "cwd"],
};

test("the Codex server configurations follow the agent-plugins schema", () => {
  for (const path of ["plugins/decisionlayer/mcp.json", "plugins/decisionlayer/mcp.local.json"]) {
    const config = readJson(path);
    assert.deepEqual(Object.keys(config).sort(), ["$schema", "mcpServers"], path);
    assert.equal(config.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", path);
    for (const [name, server] of Object.entries(config.mcpServers)) {
      const allowed = SERVER_FIELDS[server.type];
      assert.ok(allowed, `${path}: ${name} uses a known transport type, not ${JSON.stringify(server.type)}`);
      for (const field of Object.keys(server)) assert.ok(allowed.includes(field), `${path}: ${name}.${field}`);
    }
  }
});

test("the hosted server is declared to OpenAI as OAuth with dynamic client registration", () => {
  const server = readJson("plugins/decisionlayer/mcp.json").mcpServers.decisionlayer;
  assert.equal(server.type, "streamable-http");
  assert.ok(!("headers" in server), "no headers: the public directory rejects them");
  const auth = server.extensions["com.openai"].auth;
  assert.equal(auth.type, "oauth");
  assert.equal(auth.client.mode, "dcr");
  assert.ok(!("clientId" in auth.client) && !("clientSecret" in auth.client), "no client credentials in the package");
});

test("the listing carries the four HTTPS URLs and the copy limits the public directories require", () => {
  const ui = readJson("plugins/decisionlayer/plugin.json").extensions["com.openai"].interface;
  for (const field of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    assert.match(ui[field] ?? "", /^https:\/\/[^@\s]+$/, field);
  }
  assert.ok(ui.displayName.length <= 30, "displayName is at most 30 characters");
  assert.ok(ui.shortDescription.length <= 30, "shortDescription is at most 30 characters");
  assert.ok(ui.longDescription.length <= 4000, "longDescription is at most 4000 characters");
  assert.ok(ui.developerName.length <= 80, "developerName is at most 80 characters");
});

test("the icon and logo are square and at least 48 pixels", () => {
  for (const asset of ["assets/icon.svg", "assets/logo.svg"]) {
    const svg = readFileSync(join(PLUGIN, asset), "utf8");
    const width = Number(/<svg[^>]*\swidth="(\d+)"/.exec(svg)?.[1]);
    const height = Number(/<svg[^>]*\sheight="(\d+)"/.exec(svg)?.[1]);
    assert.ok(width >= 48 && width === height, `${asset} is ${width}x${height}`);
  }
});

test("the plugin folder has the README the Claude directory shows as its listing", () => {
  const text = readFileSync(join(PLUGIN, "README.md"), "utf8");
  const words = text.replace(/```[\s\S]*?```/g, "").split(/\s+/).filter(Boolean);
  assert.ok(words.length >= 40, `the README has ${words.length} words outside code blocks; the directory needs 40`);
});

test("the plugin folder has no system files", () => {
  const banned = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "__MACOSX"]);
  for (const path of repoFiles(PLUGIN)) {
    for (const part of path.split("/")) assert.ok(!banned.has(part), path);
  }
});
