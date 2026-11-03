import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// A dx home of our own: autoConnectAiTools reads and writes the config.
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-ai-home-"));
const { autoConnectAiTools, connectAiTools, disconnectAiTools, listAiTools } = await import("../tools/aiSetup.js");
const { detectProjectRoots, loadConfig, saveConfig } = await import("../config.js");
type AiEnv = import("../tools/aiSetup.js").AiEnv;

/** A pretend computer: a home folder, an app-data folder, a built MCP server and a fake `claude` CLI. */
function machine(installed: { claudeCode?: boolean; desktop?: boolean; cursor?: boolean; vscode?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-ai-"));
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  const script = path.join(root, "dx", "packages", "mcp", "dist", "index.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "// mcp server");
  if (installed.desktop) fs.mkdirSync(path.join(appData, "Claude"), { recursive: true });
  if (installed.cursor) fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  if (installed.vscode) fs.mkdirSync(path.join(appData, "Code", "User"), { recursive: true });
  const calls: string[][] = [];
  const env: AiEnv = {
    home,
    appData,
    platform: process.platform,
    node: process.execPath,
    script,
    hasClaudeCli: async () => !!installed.claudeCode,
    // Behaves like `claude mcp add/remove -s user`: edits ~/.claude.json.
    claudeCli: async (args) => {
      calls.push(args);
      const file = path.join(home, ".claude.json");
      const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      json.mcpServers ??= {};
      if (args[1] === "add") json.mcpServers.dx = { type: "stdio", command: args[6], args: [args[7]] };
      if (args[1] === "remove") delete json.mcpServers.dx;
      fs.writeFileSync(file, JSON.stringify(json));
      return { ok: true, output: "" };
    },
  };
  return { env, home, appData, calls };
}

test("finds installed tools and connects dx to each, keeping their other servers", async () => {
  const { env, home, appData, calls } = machine({ claudeCode: true, desktop: true, cursor: true });
  const desktopFile = path.join(appData, "Claude", "claude_desktop_config.json");
  fs.writeFileSync(desktopFile, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));

  const before = await listAiTools(env);
  assert.deepEqual(before.filter((t) => t.installed).map((t) => t.id).sort(), ["claude-code", "claude-desktop", "cursor"]);
  assert.ok(before.every((t) => !t.connected));

  const results = await connectAiTools(undefined, env);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.deepEqual(results.map((r) => r.id).sort(), ["claude-code", "claude-desktop", "cursor"]);
  assert.deepEqual(calls[0], ["mcp", "add", "-s", "user", "dx", "--", env.node, env.script]);

  const desktop = JSON.parse(fs.readFileSync(desktopFile, "utf8"));
  assert.deepEqual(desktop.mcpServers.dx, { command: env.node, args: [env.script] });
  assert.equal(desktop.mcpServers.other.command, "x", "other servers stay");
  assert.equal(desktop.theme, "dark", "other settings stay");
  assert.ok(fs.existsSync(`${desktopFile}.dx-backup`), "the original is backed up once");

  const cursor = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursor.mcpServers.dx.args[0], env.script);

  const after = await listAiTools(env);
  assert.ok(after.filter((t) => t.installed).every((t) => t.connected && t.current));
  assert.ok((await connectAiTools(undefined, env)).every((r) => r.message === "already connected"));
});

test("VS Code: its own key and type, and a file with comments and trailing commas", async () => {
  const { env, appData } = machine({ vscode: true });
  const file = path.join(appData, "Code", "User", "mcp.json");
  fs.writeFileSync(file, '{\n  // my servers\n  "servers": {\n    "github": { "type": "http", "url": "https://x" },\n  },\n}\n');
  const [r] = await connectAiTools(["vscode"], env);
  assert.equal(r.ok, true, r.message);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(json.servers.dx, { type: "stdio", command: env.node, args: [env.script] });
  assert.equal(json.servers.github.url, "https://x");
});

test("an entry pointing at an old copy of dx is shown as outdated and replaced", async () => {
  const { env, home } = machine({ cursor: true });
  const file = path.join(home, ".cursor", "mcp.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { dx: { command: "node", args: ["/old/place/index.js"] } } }));
  const cursor = (await listAiTools(env)).find((t) => t.id === "cursor")!;
  assert.equal(cursor.connected, true);
  assert.equal(cursor.current, false);
  const [r] = await connectAiTools(["cursor"], env);
  assert.equal(r.message, "updated to this copy of dx");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.dx.args[0], env.script);
});

test("disconnect removes only dx", async () => {
  const { env, home } = machine({ cursor: true, claudeCode: true });
  await connectAiTools(undefined, env);
  const file = path.join(home, ".cursor", "mcp.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.mcpServers.mine = { command: "y" };
  fs.writeFileSync(file, JSON.stringify(json));
  const results = await disconnectAiTools(undefined, env);
  assert.deepEqual(results.map((r) => r.id).sort(), ["claude-code", "cursor"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers), ["mine"]);
  assert.ok((await listAiTools(env)).every((t) => !t.connected));
});

test("a file that isn't JSON is left alone, with a clear message", async () => {
  const { env, home } = machine({ cursor: true });
  const file = path.join(home, ".cursor", "mcp.json");
  fs.writeFileSync(file, "{ not json");
  const [r] = await connectAiTools(["cursor"], env);
  assert.equal(r.ok, false);
  assert.match(r.message, /isn't valid JSON, so dx left it alone/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
});

test("automatic connection: new tools once, never again after you disconnect, and off with autoConnectAi: false", async () => {
  saveConfig({ ...loadConfig(), aiToolsSeen: undefined, autoConnectAi: undefined });
  const { env, home } = machine({ cursor: true });
  assert.deepEqual((await autoConnectAiTools(env)).map((r) => r.id), ["cursor"]);
  assert.deepEqual(loadConfig().aiToolsSeen, ["cursor"]);

  await disconnectAiTools(["cursor"], env);
  assert.deepEqual(await autoConnectAiTools(env), [], "a tool you disconnected stays disconnected");

  fs.mkdirSync(path.join(env.appData, "Claude"), { recursive: true });
  saveConfig({ ...loadConfig(), autoConnectAi: false });
  assert.deepEqual(await autoConnectAiTools(env), [], "turned off");
  saveConfig({ ...loadConfig(), autoConnectAi: true });
  assert.deepEqual((await autoConnectAiTools(env)).map((r) => r.id), ["claude-desktop"], "a newly installed tool is connected");
  assert.ok(!fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8").includes('"dx"'));
});

test("first run finds the usual code folders", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-roots-"));
  fs.mkdirSync(path.join(home, "code"));
  fs.mkdirSync(path.join(home, "Documents", "GitHub"), { recursive: true });
  fs.writeFileSync(path.join(home, "dev"), "a file, not a folder");
  const roots = detectProjectRoots(home).map((r) => path.relative(fs.realpathSync.native(home), r));
  assert.deepEqual(roots, ["code", path.join("Documents", "GitHub")]);
});
