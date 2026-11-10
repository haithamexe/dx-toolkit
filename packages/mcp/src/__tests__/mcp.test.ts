import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// An AI tool talking to dx's MCP server for real: the server starts a background dashboard,
// which runs a tiny app. A dx home and projects folder of our own keep real data out of it, and
// autoConnectAi: false keeps the background dashboard from touching this computer's AI tools.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-mcp-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-mcp-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const app = path.join(root, "tiny-shop");
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "tiny-shop", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(
  path.join(app, "server.cjs"),
  `const http = require("http");
   function total(cart) { return cart.items.length; }
   const s = http.createServer((q, r) => {
     if (q.url === "/checkout") {
       try { total(undefined); } catch (e) { console.error(e.stack); }
       r.statusCode = 500;
       return r.end("Internal Server Error");
     }
     if (q.url === "/broken") {
       r.setHeader("content-type", "text/html");
       return r.end("<!doctype html><title>Cart</title><p>Cart</p><script>fetch('/checkout'); setTimeout(() => { null.items; }, 30);</script>");
     }
     if (q.url === "/reload") {
       console.log("[vite] page reload server.cjs");
       return r.end("ok");
     }
     r.setHeader("content-type", "text/html");
     r.end("<!doctype html><title>Tiny shop</title><h1>Welcome</h1>");
   }).listen(0, "127.0.0.1", () => console.log("  Local:   http://localhost:" + s.address().port + "/"));`,
);

// Claude Code's folder for the agents resource: made up, so no real session is read.
const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "dx-mcp-claude-"));
const { findDashboard } = await import("@dx/web/link");
const { findBrowser } = await import("@dx/core");
const serverScript = fileURLToPath(new URL("../index.js", import.meta.url));
const client = new Client({ name: "dx-test", version: "1.0.0" });

before(async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverScript], env: { ...env, DX_HOME: home, CLAUDE_CONFIG_DIR: claudeHome } }));
});

after(async () => {
  await client.close();
  const dashboard = await findDashboard();
  if (dashboard) await dashboard.post("/api/shutdown").catch(() => undefined);
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
}

test("lists the running-app tools next to the others", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of ["start_dev_server", "stop_dev_server", "restart_dev_server", "dev_servers", "dev_logs", "dev_errors", "wait_for_rebuild", "check_url", "dx_setup_check", "list_projects", "run_tests", "network_log", "db_query", "activity_log", "replay_visit", "machine_info", "api_map", "mock_server"]) {
    assert.ok(names.includes(name), name);
  }
});

test("an agent runs the app, finds an error through a request, and sees it cleared after a reload", async () => {
  const started = await call("start_dev_server", { project: "tiny-shop", timeout_seconds: 60 });
  assert.equal(started.isError, false, started.text);
  assert.match(started.text, /tiny-shop: ready at http:\/\/localhost:\d+/);
  assert.match(started.text, /started by an AI agent/);
  assert.match(started.text, /No errors\./);
  assert.match(started.text, /The user can watch it in the dx dashboard: http:\/\/127\.0\.0\.1:\d+\//);

  const home = await call("check_url", { project: "tiny-shop" });
  assert.equal(home.isError, false, home.text);
  assert.match(home.text, /→ 200 OK/);
  assert.match(home.text, /Title: Tiny shop/);

  const checkout = await call("check_url", { project: "tiny-shop", path: "/checkout" });
  assert.equal(checkout.isError, true, "a 500 is reported as an error");
  assert.match(checkout.text, /→ 500/);
  assert.match(checkout.text, /\[runtime\] TypeError: Cannot read properties of undefined \(reading 'items'\) at .*server\.cjs:2:\d+/);

  const errors = await call("dev_errors", { project: "tiny-shop" });
  assert.match(errors.text, /TypeError/);

  const servers = await call("dev_servers");
  assert.match(servers.text, /tiny-shop: ready .*started by an AI agent.*1 error/);

  await call("check_url", { project: "tiny-shop", path: "/reload" });
  const rebuilt = await call("wait_for_rebuild", { project: "tiny-shop", timeout_seconds: 10 });
  assert.match(rebuilt.text, /No errors\./, rebuilt.text);
  assert.match(rebuilt.text, /page reload/);

  const logs = await call("dev_logs", { project: "tiny-shop", since_line: 0 });
  assert.match(logs.text, /\[dx\] \$ npm run dev/);

  // A page that answers 200 and still breaks in the browser. CI runners have Chrome; skip without one.
  if (findBrowser()) {
    const page = await call("check_url", { project: "tiny-shop", path: "/broken", browser: true });
    assert.match(page.text, /loaded in headless \w+/, page.text);
    assert.match(page.text, /Uncaught exceptions:\n- TypeError: Cannot read properties of null \(reading 'items'\)/, page.text);
    // Loaded through tiny-shop.localhost, so the request is in the network log too.
    assert.match(page.text, /Failed requests:\n- GET http:\/\/tiny-shop\.localhost:\d+\/checkout → 500/, page.text);
    const log = await call("network_log", { project: "tiny-shop" });
    assert.match(log.text, /GET \/checkout → 500/, log.text);
    // The same load in the activity history, with the browser's exception from the recorder script.
    // The page sends its events itself, a moment after they happen: give a slow machine a few seconds.
    let activity = await call("activity_log", { project: "tiny-shop", problems: true, since: "10m" });
    for (let i = 0; i < 20 && !/Uncaught TypeError/.test(activity.text); i++) {
      await new Promise((r) => setTimeout(r, 250));
      activity = await call("activity_log", { project: "tiny-shop", problems: true, since: "10m" });
    }
    assert.equal(activity.isError, false, activity.text);
    assert.match(activity.text, /request GET \/checkout → 500/, activity.text);
    assert.match(activity.text, /srv err TypeError: Cannot read properties of undefined \(reading 'items'\)/, "the server's error too");
    assert.match(activity.text, /error {3}Uncaught TypeError: Cannot read properties of null \(reading 'items'\)/, activity.text);
    const again = await call("activity_log", { project: "tiny-shop", problems: true });
    assert.match(again.text, /^Nothing new recorded for tiny-shop/, "only what's new the second time");
    assert.match(page.text, /Errors tiny-shop logged meanwhile:\n- \[runtime\] TypeError/, "the server's side of the same page load");
    assert.match(page.text, /Visible text:\nCart/);
  }

  const stopped = await call("stop_dev_server", { project: "tiny-shop" });
  assert.match(stopped.text, /Stopping tiny-shop/);
});

test("an agent leaves a note, reads it back, and checks the project's .env", async () => {
  fs.writeFileSync(path.join(app, ".env.example"), "PORT=3000\nSTRIPE_KEY=\n");
  fs.writeFileSync(path.join(app, ".env"), "PORT=4000\n");

  const left = await call("leave_note", { project: "tiny-shop", note: "Checkout fixed; next: the empty-cart page" });
  assert.equal(left.isError, false, left.text);
  const back = await call("resume_project", { project: "tiny-shop" });
  assert.match(back.text, /Note left .* by an AI agent:\nCheckout fixed; next: the empty-cart page/);
  assert.match(back.text, /running dev/, "start_dev_server recorded what ran");

  const env = await call("check_env", { project: "tiny-shop" });
  assert.match(env.text, /Not set in any \.env file: STRIPE_KEY/);

  const unsaved = await call("unsaved_work");
  assert.match(unsaved.text, /Everything is committed and pushed/, "the test projects aren't git repositories");

  // Every call above is in the run log for the AI lane, without the note's text or the .env's values.
  const runs = fs
    .readFileSync(path.join(home, "runs.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { tool: string; source: string; ok: boolean; detail?: string; project?: string; args?: string; ms?: number });
  const calls = runs.filter((r) => r.tool.startsWith("mcp."));
  for (const tool of ["start_dev_server", "check_url", "dev_errors", "stop_dev_server", "leave_note", "resume_project", "check_env", "unsaved_work"]) {
    assert.ok(calls.some((r) => r.tool === `mcp.${tool}`), `${tool} is recorded`);
  }
  assert.ok(calls.every((r) => r.source === "mcp" && typeof r.ms === "number"));
  const note = calls.find((r) => r.tool === "mcp.leave_note")!;
  assert.deepEqual([note.detail, note.project, note.args, note.ok], ["Left a note on tiny-shop", "tiny-shop", "project=tiny-shop note=(41 chars)", true]);
  assert.ok(!JSON.stringify(calls).includes("empty-cart") && !JSON.stringify(calls).includes("PORT=4000"));
  const checkout = calls.find((r) => r.tool === "mcp.check_url" && r.args?.includes("path=/checkout"));
  assert.equal(checkout?.detail, "Checked /checkout on tiny-shop: 500, 1 server error");
  assert.equal(checkout?.ok, false);
});

test("an agent joins two repositories into a stack with set_stack, then runs it", async () => {
  for (const [name, code] of [
    ["pair-api", `require("http").createServer((q, r) => r.end("api")).listen(0, "127.0.0.1", function () { console.log("API on http://localhost:" + this.address().port); });`],
    ["pair-web", `require("http").createServer((q, r) => r.end("web")).listen(0, "127.0.0.1", function () { console.log("  Local: http://localhost:" + this.address().port + "/"); });`],
  ]) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, "package.json"), JSON.stringify({ name, scripts: { dev: "node server.cjs" } }));
    fs.writeFileSync(path.join(root, name, "server.cjs"), code);
  }
  const set = await call("set_stack", {
    project: "pair-web",
    services: [
      { name: "web", command: "npm run dev", depends_on: ["api"] },
      { name: "api", project: "../pair-api" },
    ],
  });
  assert.equal(set.isError, false, set.text);
  assert.match(set.text, /now starts as: api → web/);

  const started = await call("start_dev_server", { project: "pair-web", timeout_seconds: 60 });
  assert.equal(started.isError, false, started.text);
  assert.match(started.text, /pair-web: ready .*a stack of 2 services, found from \.devrc\.json/);
  assert.match(started.text, /- api \(backend\): ready at http:\/\/localhost:\d+ \(also http:\/\/api\.pair-web\.localhost:\d+\)/);
  assert.match(started.text, /- web \(frontend\): ready/);

  const page = await call("check_url", { url: "http://api.pair-web.localhost/" });
  assert.equal(page.isError, false, page.text);
  assert.match(page.text, /Body starts:\napi/);

  await call("stop_dev_server", { project: "pair-web" });
  const removed = await call("set_stack", { project: "pair-web", services: [] });
  assert.match(removed.text, /Removed the stack/);
});

test("clear answers for unknown projects and outside addresses", async () => {
  const unknown = await call("start_dev_server", { project: "no-such-thing" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No project matches "no-such-thing"/);
  const outside = await call("check_url", { url: "https://example.com/" });
  assert.equal(outside.isError, true);
  assert.match(outside.text, /Only http:\/\/localhost/);
});

test("machine_info: an agent sees what a project needs from this computer", async () => {
  fs.mkdirSync(path.join(home, "cache"), { recursive: true });
  fs.writeFileSync(path.join(home, "cache", "latest-versions.json"), JSON.stringify({ at: Date.now(), cycles: {}, npm: {}, github: {} }));
  const r = await call("machine_info", { part: "projects", project: "tiny-shop" });
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text);
  assert.equal(out.projects[0].project, "tiny-shop");
  assert.ok(out.projects[0].needs.some((n: { tool: string; ok: boolean }) => n.tool === "node" && n.ok));
  assert.equal((await call("machine_info", { project: "no-such-project" })).isError, true);
});

test("the whole dashboard through dx_actions, dx_do and dx_do_risky: risky actions only through the tool that asks", async () => {
  const { tools } = await client.listTools();
  const risky = tools.find((t) => t.name === "dx_do_risky");
  assert.equal(risky?.annotations?.destructiveHint, true, "the client asks the user before each risky call");
  assert.equal(tools.find((t) => t.name === "dx_do")?.annotations?.destructiveHint, false);

  const groups = JSON.parse((await call("dx_actions")).text);
  assert.ok(groups.groups.git && groups.groups.chaos);
  const gitActions = JSON.parse((await call("dx_actions", { group: "git" })).text) as { action: string; risky?: string }[];
  assert.ok(gitActions.some((a) => a.action === "git.commit"));
  assert.ok(gitActions.find((a) => a.action === "git.push")?.risky);

  const list = JSON.parse((await call("dx_do", { action: "run.list" })).text);
  assert.ok(Array.isArray(list));
  const project = await call("dx_do", { action: "env.project", input: { dir: app } });
  assert.ok(!project.isError, project.text);

  const refused = await call("dx_do", { action: "env.read", input: { dir: app, name: ".env" } });
  assert.ok(refused.isError && /dx_do_risky/.test(refused.text), "a risky action isn't done by dx_do");
  const notRisky = await call("dx_do_risky", { action: "git.status", input: { dir: app } });
  assert.ok(notRisky.isError && /call dx_do/.test(notRisky.text));
  const missing = await call("dx_do", { action: "git.status", input: {} });
  assert.ok(missing.isError && /needs dir/.test(missing.text));
  const unknown = await call("dx_do", { action: "rm.everything" });
  assert.ok(unknown.isError && /no action/.test(unknown.text));
  const outside = await call("dx_do", { action: "env.project", input: { dir: os.tmpdir() } });
  assert.ok(outside.isError, "only projects dx knows, as on the page");
});

test("resources: projects, the catalog, agents and one project, readable without a tool call", async () => {
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  for (const uri of ["dx://projects", "dx://actions", "dx://agents"]) assert.ok(uris.includes(uri), uri);
  assert.ok(uris.includes("dx://project/tiny-shop"), "each project is listed through the template");
  const read = async (uri: string) => JSON.parse(((await client.readResource({ uri })).contents[0] as { text: string }).text);
  assert.ok((await read("dx://projects")).some((p: { name: string }) => p.name === "tiny-shop"));
  const catalog = await read("dx://actions");
  assert.ok(catalog.actions.length > 150 && catalog.groups.agents && catalog.groups.dev);
  assert.ok(catalog.actions.find((a: { action: string }) => a.action === "git.push").risky);
  assert.deepEqual((await read("dx://agents")).agents, [], "none in a Claude folder with no sessions");
  const one = await read("dx://project/tiny-shop");
  assert.deepEqual([one.name, one.devCommand, one.dashboardRunning === true || one.dashboardRunning === false], ["tiny-shop", "npm run dev", true]);
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.ok(resourceTemplates.some((t) => t.uriTemplate === "dx://project/{project}"));
  await assert.rejects(client.readResource({ uri: "dx://project/no-such-project" }), /No project matches/);
});

test("prompts: ready-made requests with the project filled in, and its name completed as you type", async () => {
  const { prompts } = await client.listPrompts();
  for (const name of ["fix_errors", "ship_check", "understand_project", "break_it", "whats_running"]) assert.ok(prompts.some((p) => p.name === name), name);
  const got = await client.getPrompt({ name: "ship_check", arguments: { project: "tiny-shop" } });
  const text = (got.messages[0].content as { text: string }).text;
  assert.ok(text.includes("tiny-shop") && text.includes("unsaved_work") && text.includes("run_tests"));
  const done = await client.complete({ ref: { type: "ref/prompt", name: "fix_errors" }, argument: { name: "project", value: "tin" } });
  assert.deepEqual(done.completion.values, ["tiny-shop"]);
});

test("dx_do answers with structured content as well as text; the dev tools are there, and say so when dx's source isn't a project", async () => {
  const raw = (await client.callTool({ name: "dx_do", arguments: { action: "run.list" } })) as { structuredContent?: { action: string; result: unknown }; content: { text: string }[] };
  assert.deepEqual([raw.structuredContent?.action, Array.isArray(raw.structuredContent?.result)], ["run.list", true]);
  assert.deepEqual(JSON.parse(raw.content[0].text), raw.structuredContent?.result, "the same result");
  const info = JSON.parse((await call("dx_do", { action: "dev.info" })).text);
  assert.equal(info.repository, null);
  assert.match(info.hint, /isn't one of your projects/);
  assert.ok((await call("dx_do", { action: "dev.build" })).isError, "no source, no build");
  const write = await call("dx_do", { action: "dev.write", input: { file: "x.ts", content: "" } });
  assert.ok(write.isError && /dx_do_risky/.test(write.text), "writing is risky: only through the tool that asks");
  const agents = JSON.parse((await call("dx_do", { action: "agents.list" })).text);
  assert.deepEqual(agents.agents, []);
});

test("tool descriptions stay short enough for an agent to read all 51, and come in the same order every time", async () => {
  const first = (await client.listTools()).tools;
  const second = (await client.listTools()).tools;
  assert.deepEqual(first.map((t) => t.name), second.map((t) => t.name), "a fixed order, so a client can cache the list");
  const long = first.filter((t) => (t.description ?? "").length > 520).map((t) => `${t.name} (${t.description?.length})`);
  assert.deepEqual(long, [], "put the detail in the parameters' descriptions, and the when-to-use sentence first");
  assert.ok(first.every((t) => (t.description ?? "").length > 40), "none left too thin to say when to use it");
});

test("every client is told when to prefer dx's tools, and the ones allowed without asking exist and change nothing risky", async () => {
  const instructions = client.getInstructions() ?? "";
  for (const word of ["start_dev_server", "run_tests", "dx_verify", "dx_status", "dx_do_risky"]) assert.ok(instructions.includes(word), word);
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const { DX_ALLOWED_TOOLS } = await import("@dx/core");
  for (const t of DX_ALLOWED_TOOLS) {
    assert.ok(byName.has(t), `${t} is allowed in a project's Claude settings but isn't a tool`);
    assert.notEqual(byName.get(t)?.annotations?.destructiveHint, true, `${t} can be destructive: it should ask`);
  }
});

test("dx_status says where a project stands in one call, and dx_verify gives one verdict with only what failed", { skip: findBrowser() ? false : "no Chrome, Edge, Chromium or Brave here" }, async () => {
  // Earlier tests may have left the app running with an error: start from nothing.
  await call("stop_dev_server", { project: "tiny-shop" });
  const before = await call("dx_status", { project: "tiny-shop" });
  assert.ok(before.text.includes("tiny-shop") && /Not running/.test(before.text) && /Tests: none run through dx yet/.test(before.text), before.text);
  assert.ok((await call("dx_status", { project: "no-such-project-xyz" })).isError);

  const started = await call("start_dev_server", { project: "tiny-shop" });
  assert.ok(!started.isError, started.text);
  try {
    const running = await call("dx_status", { project: "tiny-shop" });
    assert.match(running.text, /tiny-shop: ready|running/i);
    assert.match(running.text, /No errors\./);

    const good = await call("dx_verify", { project: "tiny-shop", path: "/" });
    assert.ok(!good.isError, good.text);
    assert.match(good.text, /tiny-shop: verified/);
    assert.match(good.text, /No tests found to run/, "a project with no tests says so instead of failing");

    const bad = await call("dx_verify", { project: "tiny-shop", path: "/broken", skip_tests: true });
    assert.ok(bad.isError, "a page that throws is not verified");
    assert.match(bad.text, /not verified, 1 problem/);
    assert.match(bad.text, /Cannot read properties of null|items/);
  } finally {
    await call("stop_dev_server", { project: "tiny-shop" });
  }
});
