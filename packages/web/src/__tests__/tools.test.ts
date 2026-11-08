import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Custom tools against a made-up app the dashboard runs: views, watches and operations, the chat
// (with a stand-in claude first on PATH, never the real one), and export and import.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-tools-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-tools-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

// The stand-in claude: keeps its arguments and prompt, answers with a tool.
const fake = fs.mkdtempSync(path.join(os.tmpdir(), "dx-fake-claude-"));
fs.writeFileSync(
  path.join(fake, "fake.cjs"),
  `const fs = require("fs"); const path = require("path"); let input = "";
   process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () => {
     fs.writeFileSync(path.join(__dirname, "input.txt"), input);
     fs.writeFileSync(path.join(__dirname, "args.txt"), process.argv.slice(2).join(" "));
     const bad = fs.existsSync(path.join(__dirname, "bad-once"));
     if (bad) { fs.unlinkSync(path.join(__dirname, "bad-once")); return process.stdout.write('{"reply":"here","tool":{"name":"Oops","kind":"view","source":{"request":{"method":"GET","path":"/api/orders"}},"steps":[{"eval":"x"}]}}'); }
     process.stdout.write("Sure.\\n\`\`\`json\\n" + JSON.stringify({ reply: "A table of the orders.", tool: { name: "Orders table", kind: "view", source: { request: { method: "GET", path: "/api/orders" } }, steps: [{ get: "orders" }], display: { as: "table" } } }) + "\\n\`\`\`\\n");
   });`,
);
if (process.platform === "win32") fs.writeFileSync(path.join(fake, "claude.cmd"), `@"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
else fs.writeFileSync(path.join(fake, "claude"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.cjs" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${fake}${path.delimiter}${process.env.PATH}`;

const app = path.join(root, "shop-website");
fs.mkdirSync(app, { recursive: true });
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "shop-website", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(
  path.join(app, "server.cjs"),
  `const http = require("http");
   let made = 0;
   const json = (r, status, body) => { r.statusCode = status; r.setHeader("content-type", "application/json"); r.end(JSON.stringify(body)); };
   const s = http.createServer((q, r) => {
     let body = ""; q.on("data", (c) => (body += c)); q.on("end", () => {
       if (q.url === "/api/orders") return json(r, 200, { orders: [{ id: 1, customer: "Ada", total: 20, status: "paid" }, { id: 2, customer: "Grace", total: 5, status: "failed" }] });
       if (q.url === "/api/login" && q.method === "POST") return json(r, 200, { token: "t-" + JSON.parse(body).email });
       if (q.url === "/api/orders" && q.method === "POST") return json(r, 405, {});
       if (q.url === "/api/make" && q.method === "POST") { if (q.headers.authorization !== "Bearer t-test@example.com") return json(r, 401, {}); made++; return json(r, 201, { n: JSON.parse(body).n, made }); }
       if (q.url === "/api/boom") return json(r, 500, { error: "boom" });
       r.setHeader("content-type", "text/html"); r.end("<!doctype html><h1>Shop</h1>");
     });
   }).listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port + "/"));`,
);

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;

async function call(p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}
const api = async (p: string, body?: unknown) => {
  const r = await call(p, body);
  assert.ok(r.status < 400, `${p}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

function viaProxy(p: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: dashboard.localDomainsPort, path: p, headers: { host: `shop-website.localhost:${dashboard.localDomainsPort}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  dashboard = await startDashboard({ port: 0 });
  await api("/api/dev/start", { dir: app });
  for (let i = 0; i < 100; i++) {
    const s = (await api("/api/dev")).find((d: { dir: string }) => d.dir === app);
    if (s?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(async () => {
  await api("/api/dev/stop", { dir: app });
  await dashboard.close();
});

const view = {
  name: "Orders by value",
  kind: "view",
  source: { request: { method: "GET", path: "/api/orders" } },
  steps: [{ get: "orders" }, { sort: "total", desc: true }],
  display: { as: "table", columns: [{ field: "customer" }, { field: "total", format: "money" }], highlight: [{ when: { field: "status", is: "failed" }, tone: "danger" }] },
};

test("views ask the dev server dx runs and reshape the answer; saved tools run by id, drafts are checked like them", async () => {
  const first = await api(`/api/tools?dir=${encodeURIComponent(app)}`);
  assert.deepEqual(first.tools, []);
  assert.equal(first.running, true);
  assert.deepEqual(first.efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.ok(first.agents.some((a: { id: string }) => a.id === "claude"), "the stand-in claude counts as installed");

  const saved = await api("/api/tools/save", { dir: app, tool: view });
  const r = await api("/api/tools/run", { dir: app, id: saved.id });
  assert.deepEqual(r.data.map((o: { customer: string }) => o.customer), ["Ada", "Grace"]);
  assert.deepEqual(r.tones, [null, "danger"], "highlights worked out on the server");
  assert.equal(r.meta.status, 200);

  assert.equal((await call("/api/tools/run", { dir: app, tool: { ...view, source: { request: { method: "GET", path: "http://example.com/" } } } })).status, 400, "only paths on the app");
  assert.equal((await call("/api/tools/check", { dir: app, tool: { ...view, steps: [{ eval: "1" }] } })).status, 400);
  assert.equal((await api("/api/tools/check", { dir: app, tool: view })).name, "Orders by value");
  const runs = fs.readFileSync(path.join(home, "runs.jsonl"), "utf8");
  assert.ok(runs.includes('saved the view \\"Orders by value\\"'));
});

test("watches find what matched in the history; operations send requests in order with inputs and saved values", async () => {
  await api("/api/tools/run", { dir: app, tool: { name: "Boom", kind: "view", source: { request: { method: "GET", path: "/api/boom" } } } });
  const w = await api("/api/tools/run", { dir: app, tool: { name: "500s", kind: "watch", match: { status: "5xx" } } });
  assert.equal(w.count, 1);
  assert.equal(w.matches[0].url, "/api/boom");

  const op = {
    name: "Make orders",
    kind: "operation",
    inputs: [{ name: "count", default: "2" }],
    requests: [
      { name: "Log in", method: "POST", path: "/api/login", headers: { "content-type": "application/json" }, body: '{"email":"test@example.com"}', save: { token: "token" }, expect: 200 },
      { name: "Make", method: "POST", path: "/api/make", headers: { authorization: "Bearer {{token}}", "content-type": "application/json" }, body: '{"n": {{i}}}', repeat: "{{count}}", expect: 201 },
    ],
  };
  const r = await api("/api/tools/run", { dir: app, tool: op, inputs: { count: "3" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.steps.map((s: { name: string; status: number }) => [s.name, s.status]), [["Log in", 200], ["Make (1 of 3)", 201], ["Make (2 of 3)", 201], ["Make (3 of 3)", 201]]);
  const stopped = await api("/api/tools/run", { dir: app, tool: { ...op, requests: [{ ...op.requests[1], headers: {} }, op.requests[0]] }, inputs: { count: "1" } });
  assert.match(stopped.stopped, /answered 401, not 201: the rest wasn't sent/);
  assert.equal(stopped.steps.length, 1);
  const tooMany = await api("/api/tools/run", { dir: app, tool: op, inputs: { count: "99" } });
  assert.match(tooMany.stopped, /whole number from 1 to 50/);
});

test("the chat: dx builds the prompt, passes the model and effort, and keeps only a tool that fits", async () => {
  await api("/api/tools/run", { dir: app, id: (await api(`/api/tools?dir=${encodeURIComponent(app)}`)).tools[0].id });
  const r = await api("/api/tools/chat", { dir: app, message: "a table of the orders", model: "sonnet", effort: "low" });
  assert.equal(r.reply, "A table of the orders.");
  assert.equal(r.tool.name, "Orders table");
  assert.equal(fs.readFileSync(path.join(fake, "args.txt"), "utf8"), "-p --max-turns 1 --model sonnet --effort low");
  const prompt = fs.readFileSync(path.join(fake, "input.txt"), "utf8");
  assert.ok(prompt.includes("GET /api/orders"), "the recorded calls are in the prompt");
  assert.ok(prompt.includes("User: a table of the orders"));
  assert.equal((await call("/api/tools/chat", { dir: app, message: "x", model: "sonnet; calc" })).status, 400, "a model that isn't a name is refused");
  // A tool that doesn't fit is sent back once with what was wrong.
  fs.writeFileSync(path.join(fake, "bad-once"), "");
  const again = await api("/api/tools/chat", { dir: app, message: "try" });
  assert.equal(again.tool.name, "Orders table");
  assert.match(fs.readFileSync(path.join(fake, "input.txt"), "utf8"), /Your last answer couldn't be used: step 1: a step is one of/);
  // Long pasted text goes to the agent whole, with the history that repeats it: no limit (over 4 MB here).
  const long = "order line ".repeat(200_000) + "the end";
  await api("/api/tools/chat", { dir: app, message: long, history: [{ role: "user", text: long }, { role: "assistant", text: "ok" }] });
  const sent = fs.readFileSync(path.join(fake, "input.txt"), "utf8");
  assert.ok(sent.includes(`User: ${long}`) && sent.includes(`\nUser: ${long}\nYou: ok`), "nothing is cut");
});

test("export and import: one file of definitions, checked before anything is kept", async () => {
  const file = await api(`/api/tools/export?dir=${encodeURIComponent(app)}`);
  assert.equal(file.format, "dx-tools");
  assert.equal(file.tools.length, 1);
  const check = await api("/api/tools/import/check", { dir: app, file: JSON.stringify(file) });
  assert.deepEqual(check.tools.map((t: { name: string; conflict: boolean }) => [t.name, t.conflict]), [["Orders by value", true]]);
  const done = await api("/api/tools/import", { dir: app, file: JSON.stringify(file), pick: [0] });
  assert.deepEqual(done, { added: 1, replaced: 0 });
  assert.deepEqual((await api(`/api/tools?dir=${encodeURIComponent(app)}`)).tools.map((t: { name: string }) => t.name), ["Orders by value", "Orders by value (2)"]);
  assert.equal((await call("/api/tools/import/check", { dir: app, file: '{"format":"dx-tools","version":1,"tools":[{"name":"x","kind":"view","source":{"request":{"method":"GET","path":"/"}},"code":"alert(1)"}]}' })).status, 400);
});

test("an answer tool changes JSON answers through dx, marked in the history; switched off, it doesn't", async () => {
  const saved = await api("/api/tools/save", { dir: app, tool: { name: "Totals with tax", kind: "answer", target: { method: "GET", path: "/api/orders" }, at: "orders", set: { withTax: { mul: ["total", 1.2] } }, remove: ["status"] } });
  const body = JSON.parse((await viaProxy("/api/orders", { accept: "application/json" })).body);
  assert.deepEqual(body.orders[0], { id: 1, customer: "Ada", total: 20, withTax: 24 });
  const events = await api(`/api/activity?dir=${encodeURIComponent(app)}&since=1h`);
  assert.ok(events.some((e: { url: string; rules?: string[] }) => e.url === "/api/orders" && e.rules?.includes("tool: Totals with tax")), "marked in Activity");
  const preview = await api("/api/tools/run", { dir: app, id: saved.id });
  assert.equal(preview.before.orders[0].status, "paid");
  assert.equal(preview.after.orders[0].withTax, 24);
  await api("/api/tools/save", { dir: app, tool: { ...saved, off: true } });
  assert.equal(JSON.parse((await viaProxy("/api/orders", { accept: "application/json" })).body).orders[0].status, "paid", "off: the answer goes through as it was");
});

test("a page tool reaches the app's page: its checked changes in the page script, its data from dx on the page's own origin", async () => {
  const page = await api("/api/tools/save", { dir: app, tool: { name: "Orders panel", kind: "page", path: "/", changes: [{ panel: { title: "Orders", source: { request: { method: "GET", path: "/api/orders" } }, steps: [{ get: "orders" }, { count: true }], display: { as: "number" } } }, { highlight: { selector: "h1", tone: "ok" } }] } });
  const script = (await viaProxy("/__dx/node_modules/dx-recorder.js")).body;
  assert.match(script, /window\.__dxPageTools = /);
  assert.ok(script.includes(page.id));
  assert.ok(!script.includes('"source"'), "the page gets the changes, never where their data comes from");
  const data = await viaProxy(`/__dx/tools/${page.id}/0`, { "sec-fetch-site": "same-origin" });
  assert.equal(JSON.parse(data.body).data, 2);
  assert.equal((await viaProxy(`/__dx/tools/${page.id}/0`, { "sec-fetch-site": "cross-site" })).status, 403, "never for another site");
  assert.equal((await viaProxy(`/__dx/tools/${page.id}/1`, { "sec-fetch-site": "same-origin" })).status, 404, "a highlight has no data");
  await api("/api/tools/delete", { dir: app, id: page.id });
  assert.ok(!(await viaProxy("/__dx/node_modules/dx-recorder.js")).body.includes("window.__dxPageTools = "), "deleted: gone from the page");
});

test("watches with toast or floppy speak up: the page's alerts and Floppy's line", async () => {
  const start = await api(`/api/tools/alerts?dir=${encodeURIComponent(app)}&after=`);
  assert.deepEqual(start.alerts, [], "the first ask only learns where things stand");
  await api("/api/tools/save", { dir: app, tool: { name: "Server errors", kind: "watch", match: { status: "5xx" }, alert: { toast: true, floppy: true } } });
  await new Promise((r) => setTimeout(r, 20));
  await api("/api/tools/run", { dir: app, tool: { name: "Boom", kind: "view", source: { request: { method: "GET", path: "/api/boom" } } } });
  const { alerts, last } = await api(`/api/tools/alerts?dir=${encodeURIComponent(app)}&after=${start.last}`);
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0].tool, alerts[0].text], ["Server errors", "GET /api/boom → 500"]);
  assert.deepEqual((await api(`/api/tools/alerts?dir=${encodeURIComponent(app)}&after=${last}`)).alerts, [], "said once");
  const snap = await api("/api/floppy");
  assert.deepEqual([snap.alert.tool, snap.alert.text, snap.alert.project], ["Server errors", "GET /api/boom → 500", "shop-website"]);
});

test("dx's state goes out and comes back through the dashboard: the page's preferences without paths, a strict check, an import that can be undone", async () => {
  const state = await api("/api/state/export", { page: { theme: "dark", project: app } });
  assert.equal(state.format, "dx-state");
  assert.deepEqual(state.page, { theme: "dark" }, "a preference holding a path stays here");
  const text = JSON.stringify(state).toLowerCase();
  assert.ok(!text.includes(JSON.stringify(app.toLowerCase()).slice(1, -1)), "no path of this computer");
  assert.ok(state.projects.find((p: { name: string }) => p.name === "shop-website")?.tools?.length);

  const file = JSON.stringify({ ...state, projects: [{ name: "shop-website", tools: [{ name: "From home", kind: "view", source: { request: { method: "GET", path: "/api/orders" } } }] }] });
  const plan = await api("/api/state/import/check", { file });
  assert.equal(plan.projects[0].match.by, "name");
  assert.equal((await call("/api/state/import/check", { file: JSON.stringify({ format: "dx-state", version: 1, projects: [{ name: "x", dir: "C:\\" }] }) })).status, 400);

  const count = async () => (await api(`/api/tools?dir=${encodeURIComponent(app)}`)).tools.length;
  const before = await count();
  const r = await api("/api/state/import", { file, map: { 0: app } });
  assert.deepEqual(r.page, { theme: "dark" });
  assert.equal(await count(), before + 1);
  assert.ok((await api("/api/state/last")).last);
  await api("/api/state/undo", {});
  assert.equal(await count(), before, "undone");

  const away = await api("/api/state/import", { file, map: { 0: os.tmpdir() } });
  assert.deepEqual(away.skipped, ["shop-website"], "only ever a project dx finds here");
  assert.equal(await count(), before);
  await api("/api/state/undo", {});
});
