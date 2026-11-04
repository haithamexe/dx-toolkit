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

const { findDashboard } = await import("@dx/web/link");
const { findBrowser } = await import("@dx/core");
const serverScript = fileURLToPath(new URL("../index.js", import.meta.url));
const client = new Client({ name: "dx-test", version: "1.0.0" });

before(async () => {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverScript], env: { ...env, DX_HOME: home } }));
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
  for (const name of ["start_dev_server", "stop_dev_server", "restart_dev_server", "dev_servers", "dev_logs", "dev_errors", "wait_for_rebuild", "check_url", "dx_setup_check", "list_projects", "run_tests", "network_log", "db_query", "activity_log", "replay_visit", "machine_info"]) {
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
