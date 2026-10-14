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
