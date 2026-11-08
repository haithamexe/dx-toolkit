import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Custom tools: the format a tool must have, the steps that reshape data, watches, keeping them,
// and the file they're exported to and imported from. Our own dx home; nothing runs an AI.
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-tools-test-"));
const core = await import("../index.js");
const { cleanTool, runSteps, matchesWatch, toolPathMatches, recordedData, fillTemplate, pathValue, saveTool, loadTools, deleteTool, exportTools, readToolBundle, importTools, toolsFile, toolPrompt, askAi, cleanAiModel, cleanAiEffort, ToolError } = core;
type Ev = import("../tools/activity.js").ActivityEvent;

const project = fs.mkdtempSync(path.join(os.tmpdir(), "shop-website-"));

const ordersView = {
  name: "Open orders",
  description: "The open orders by customer",
  kind: "view",
  source: { request: { method: "GET", path: "/api/orders?status=open" } },
  steps: [{ get: "data.orders" }, { map: { customer: "customer.name", total: { mul: ["price", "qty"] }, status: "status" } }, { sort: "total", desc: true }],
  display: { as: "table", columns: [{ field: "customer" }, { field: "total", format: "money" }], highlight: [{ when: { field: "status", is: "failed" }, tone: "danger" }] },
};

test("a tool has only the fields its kind has, each of the right shape, and says what's wrong by name", () => {
  const t = cleanTool(ordersView);
  assert.match(t.id, /^[a-f0-9]{12}$/);
  assert.equal(t.kind, "view");
  assert.deepEqual(t.steps?.[1], { map: { customer: "customer.name", total: { mul: ["price", "qty"] }, status: "status" } });

  const bad = (tool: unknown, message: RegExp) => assert.throws(() => cleanTool(tool), (e: Error) => e instanceof ToolError && message.test(e.message));
  bad({ ...ordersView, script: "process.exit()" }, /"script" isn't something a tool can have/);
  bad({ ...ordersView, match: { status: 500 } }, /A view tool doesn't have match/);
  bad({ ...ordersView, steps: [{ eval: "1+1" }] }, /a step is one of/);
  bad({ ...ordersView, steps: [{ map: { x: { exec: "rm" } } }] }, /a value is a path, a number, or one of/);
  bad({ ...ordersView, steps: [{ get: "__proto__.polluted" }] }, /isn't allowed/);
  bad({ ...ordersView, source: { request: { method: "GET", path: "https://example.com/api" } } }, /a path on the app/);
  bad({ ...ordersView, source: { request: { method: "GET", path: "//example.com/api" } } }, /a path on the app/);
  bad({ ...ordersView, source: { request: { method: "GET", path: "/api", headers: { Host: "example.com" } } } }, /"Host" can't be set/);
  bad({ ...ordersView, source: { request: { method: "GET", path: "/api", headers: { "x-a": "1\r\nx-b: 2" } } } }, /can't be sent/);
  bad({ ...ordersView, name: "" }, /name/);
  bad({ ...ordersView, kind: "script" }, /kind is one of view, watch, operation, answer, page, column/);
  bad({ name: "Watch", kind: "watch", match: {} }, /say what to watch for/);
  bad({ name: "Op", kind: "operation", requests: [{ method: "GET", path: "/api", repeat: 500 }] }, /repeat must be a whole number from 1 to 50/);

  const op = cleanTool({ name: "Seed orders", kind: "operation", inputs: [{ name: "count", default: "3" }], requests: [{ method: "POST", path: "/api/orders", repeat: "{{count}}", save: { id: "id" }, expect: 201 }] });
  assert.equal(op.requests?.[0].repeat, "{{count}}", "repeat can be an input");
  const watch = cleanTool({ name: "500s", kind: "watch", match: { status: "5xx" }, alert: { toast: true, floppy: true } });
  assert.deepEqual(watch.alert, { toast: true, floppy: true });
  bad({ name: "500s", kind: "watch", match: { status: "5xx" }, alert: { sound: true } }, /"sound" isn't something/);
});

test("tools that change things: answers, the app's page, dx's Activity column, and pinned views", () => {
  const answer = cleanTool({ name: "Order totals", kind: "answer", target: { method: "GET", path: "/api/orders" }, at: "orders", set: { total: { mul: ["price", "qty"] } }, remove: ["internal"] });
  const data = { orders: [{ price: 2, qty: 3, internal: "x" }, { price: 5, qty: 1 }] };
  assert.deepEqual(core.applyAnswerTool(data, answer), { orders: [{ price: 2, qty: 3, total: 6 }, { price: 5, qty: 1, total: 5 }] });
  assert.deepEqual(core.applyAnswerTool({ a: 1 }, { set: { b: { add: ["a", 1] } } }), { a: 1, b: 2 }, "an object changes itself");
  const bad = (tool: unknown, message: RegExp) => assert.throws(() => cleanTool(tool), (e: Error) => e instanceof ToolError && message.test(e.message));
  bad({ name: "x", kind: "answer", target: { path: "/api" }, set: { "a.b": 1 } }, /can't be a field name/);
  bad({ name: "x", kind: "answer", target: { path: "/api" }, set: { __proto__: 1 } as unknown }, /set names|can't be a field name/);
  bad({ name: "x", kind: "answer", target: { path: "/api" } }, /sets fields \(set\) or takes them out/);
  bad({ name: "x", kind: "answer", target: { path: "/api" }, set: { a: 1 }, source: { request: { path: "/" } } }, /An answer tool doesn't have source/);

  const page = cleanTool({
    name: "Order margins",
    kind: "page",
    path: "/orders",
    changes: [
      { panel: { title: "Open orders", source: { request: { method: "GET", path: "/api/orders" } }, display: { as: "number" } } },
      { column: { table: "table.orders", header: "Margin", source: { recorded: { path: "/api/orders" } }, key: { cell: 0, field: "id" }, value: "margin", format: "money" } },
      { highlight: { selector: "tbody tr", text: "failed", tone: "danger" } },
      { hide: { selector: ".promo" } },
    ],
  });
  assert.equal(page.changes?.length, 4);
  bad({ name: "x", kind: "page", path: "/", changes: [{ panel: { title: "t", source: { request: { method: "POST", path: "/api/reset" } } } }] }, /only asks with GET/);
  bad({ name: "x", kind: "page", path: "/", changes: [{ script: { code: "alert(1)" } }] }, /a change is a panel, section, column, highlight or hide/);
  bad({ name: "x", kind: "page", path: "/", changes: [{ section: { title: "t", at: "main", place: "around", source: { recorded: { path: "/" } } } }] }, /place is before, after or inside/);

  const column = cleanTool({ name: "Last total", kind: "column", endpoint: { path: "/api/orders/*" }, label: "Total", from: "body.total", show: "last", format: "money" });
  assert.equal(column.page, "activity-apis");
  bad({ name: "x", kind: "column", label: "x", from: "headers.cookie", show: "last" }, /from is "status", "ms"/);
  const ev = (url: string, at: number, status: number, body: unknown) => ({ id: at, at: new Date(at).toISOString(), dir: project, project: "shop-website", type: "request", text: "", method: "GET", url, status, ms: at, responseBody: JSON.stringify(body) }) as Ev;
  assert.deepEqual(core.columnValues(column, [ev("/api/orders/2", 2000, 200, { total: 9 }), ev("/api/orders/1", 1000, 200, { total: 4 }), ev("/api/cart", 3000, 200, { total: 1 })]), [{ endpoint: "GET /api/orders/:id", value: 9, calls: 2 }]);
  assert.equal(core.aggregateColumn([3, "4", null, 5], "avg"), 4);
  assert.equal(core.aggregateColumn(["a", "b", "a"], "unique"), "a, b");

  assert.deepEqual(cleanTool({ ...ordersView, pin: ["overview"] }).pin, ["overview"]);
  bad({ ...ordersView, pin: ["sidebar"] }, /pin is \["overview"\]/);
  assert.equal(cleanTool({ ...answer, off: true }).off, true);
});

test("steps reshape data: get, flatten, map, filter, sort, limit, group, count, sum", () => {
  const data = {
    data: {
      orders: [
        { id: 1, customer: { name: "Ada" }, price: 10, qty: 2, status: "paid", lines: [{ sku: "mug" }, { sku: "cap" }] },
        { id: 2, customer: { name: "Grace" }, price: 5, qty: 1, status: "failed", lines: [{ sku: "mug" }] },
        { id: 3, customer: { name: "Linus" }, price: "7.5", qty: 4, status: "paid", lines: [] },
      ],
    },
  };
  const t = cleanTool(ordersView);
  assert.deepEqual(runSteps(data, t.steps), [
    { customer: "Linus", total: 30, status: "paid" },
    { customer: "Ada", total: 20, status: "paid" },
    { customer: "Grace", total: 5, status: "failed" },
  ]);
  const run = (steps: unknown[]) => runSteps(data, cleanTool({ ...ordersView, steps }).steps);
  assert.deepEqual(run([{ get: "data.orders" }, { flatten: "lines" }, { map: { sku: "sku" } }]), [{ sku: "mug" }, { sku: "cap" }, { sku: "mug" }]);
  assert.deepEqual(run([{ get: "data.orders" }, { filter: { all: [{ field: "status", is: "PAID" }, { field: "price", gte: 8 }] } }, { map: { id: "id" } }]), [{ id: 1 }]);
  assert.deepEqual(run([{ get: "data.orders" }, { group: "status", sum: "qty", avg: "price" }]), [
    { key: "paid", count: 2, sum: 6, avg: 8.75 },
    { key: "failed", count: 1, sum: 1, avg: 5 },
  ]);
  assert.equal(run([{ get: "data.orders" }, { count: true }]), 3);
  assert.equal(run([{ get: "data.orders" }, { sum: { mul: ["price", "qty"] } }]), 55);
  assert.deepEqual(run([{ get: "data.orders" }, { limit: 1 }, { map: { who: { concat: [{ upper: "customer.name" }, { value: " (" }, { len: "lines" }, { value: ")" }] }, label: { if: [{ field: "status", is: "failed" }, { value: "!" }, { value: "ok" }] } } }]), [{ who: "ADA (2)", label: "ok" }]);
  assert.equal(pathValue({ a: [{ b: 4 }] }, "a.0.b"), 4);
  assert.equal(pathValue({}, "constructor"), undefined, "never walks into what an object inherits");
});

test("watches match by type, method, path, status and text; recorded sources give the latest answer or calls", () => {
  const ev = (o: Partial<Ev>): Ev => ({ id: 1, at: "2026-11-07T10:00:00.000Z", dir: project, project: "shop-website", type: "request", text: "", ...o }) as Ev;
  assert.equal(toolPathMatches("/api/orders/*", "/api/orders/42?x=1"), true);
  assert.equal(toolPathMatches("/api/orders/:id", "/api/orders/42"), true);
  assert.equal(toolPathMatches("/api/**", "/api/a/b/c"), true);
  assert.equal(toolPathMatches("/api/orders", "/api/orders/42"), false);
  const m = cleanTool({ name: "Checkout failures", kind: "watch", match: { method: "POST", path: "/api/checkout", notStatus: [201] } }).match!;
  assert.equal(matchesWatch(m, ev({ method: "POST", url: "/api/checkout", status: 500 })), true);
  assert.equal(matchesWatch(m, ev({ method: "POST", url: "/api/checkout", status: 201 })), false);
  assert.equal(matchesWatch(m, ev({ method: "GET", url: "/api/checkout", status: 500 })), false);
  assert.equal(matchesWatch({ status: "5xx" }, ev({ url: "/a", status: 503 })), true);
  assert.equal(matchesWatch({ status: "failed" }, ev({ url: "/a", error: "ECONNRESET" })), true);
  assert.equal(matchesWatch({ type: "console", text: "TIMEOUT" }, ev({ type: "console", text: "Request timeout after 30s" })), true);
  assert.equal(matchesWatch({ type: "console", text: "timeout" }, ev({ type: "request", text: "timeout", url: "/a" })), false);

  const events = [
    ev({ id: 1, at: "2026-11-07T10:00:00.000Z", method: "GET", url: "/api/orders/1", status: 200, responseBody: '{"id":1}' }),
    ev({ id: 2, at: "2026-11-07T10:05:00.000Z", method: "GET", url: "http://shop-website.localhost/api/orders/2", status: 404, responseBody: "not found" }),
  ];
  assert.equal(recordedData(events, { path: "/api/orders/*" }), "not found", "the latest answer, as text when it isn't JSON");
  assert.deepEqual((recordedData(events, { path: "/api/orders/*", calls: true, last: 5 }) as { status: number }[]).map((c) => c.status), [404, 200]);
  assert.equal(fillTemplate("Bearer {{token}} {{missing}}", { token: "abc" }), "Bearer abc {{missing}}");
});

test("kept per project, readable only by you; exported as one file and imported strictly", () => {
  const saved = saveTool(project, ordersView);
  const watch = saveTool(project, { name: "500s", kind: "watch", match: { status: "5xx" } });
  assert.deepEqual(loadTools(project).map((t) => t.name), ["Open orders", "500s"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(toolsFile(project)).mode & 0o777, 0o600);
  const renamed = saveTool(project, { ...saved, name: "Open orders by value" });
  assert.equal(renamed.id, saved.id, "saved again under its id");
  assert.equal(renamed.createdAt, saved.createdAt);

  const file = exportTools(project, "shop-website");
  assert.equal(file.format, "dx-tools");
  assert.ok(!JSON.stringify(file).includes(saved.id) && !JSON.stringify(file).includes(project), "no ids or folders in the file");
  const read = readToolBundle(JSON.stringify(file));
  assert.deepEqual(read.tools.map((t) => t.name), ["Open orders by value", "500s"]);
  assert.throws(() => readToolBundle({ ...file, format: "something" }), /isn't a dx tools file/);
  assert.throws(() => readToolBundle({ ...file, version: 2 }), /newer dx/);
  assert.throws(() => readToolBundle({ ...file, extra: 1 }), /"extra" isn't something/);
  assert.throws(() => readToolBundle({ ...file, tools: [file.tools[0], { ...file.tools[1], kind: "script" }] }), /Tool 2 in the file: kind is/);

  // A name that's taken: kept beside it, or replacing it (keeping the one in place's id).
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "todo-app-"));
  saveTool(other, { name: "500s", kind: "watch", match: { status: 500 } });
  assert.deepEqual(importTools(other, read.tools, { pick: [1] }), { added: 1, replaced: 0 });
  assert.deepEqual(loadTools(other).map((t) => t.name), ["500s", "500s (2)"]);
  const before = loadTools(other)[0].id;
  assert.deepEqual(importTools(other, read.tools, { replace: true }), { added: 1, replaced: 1 });
  assert.equal(loadTools(other).find((t) => t.name === "500s")!.id, before);
  assert.deepEqual(loadTools(other).find((t) => t.name === "500s")!.match, { status: "5xx" });

  deleteTool(project, watch.id);
  assert.deepEqual(loadTools(project).map((t) => t.name), ["Open orders by value"]);
  assert.throws(() => deleteTool(project, watch.id), /isn't there any more/);
});

test("the chat's prompt has the format, the project, the tool so far and the conversation", () => {
  const current = cleanTool(ordersView);
  const prompt = toolPrompt({ project: "shop-website", context: "Its API spec: GET /api/orders", current, history: [{ role: "user", text: "a table of orders" }, { role: "assistant", text: "Here it is." }], message: "add the date" });
  for (const part of ['"reply"', "VIEW:", "WATCH:", "OPERATION:", "ANSWER:", "PAGE:", "COLUMN:", "GET /api/orders", '"name":"Open orders"', "User: a table of orders", "You: Here it is.", "User: add the date"]) assert.ok(prompt.includes(part), part);
  assert.ok(!prompt.includes(current.id), "the tool's id isn't sent");
});

test("the model and effort reach Claude Code as fixed arguments, checked first", async () => {
  assert.equal(cleanAiModel("claude-opus-4-1"), "claude-opus-4-1");
  assert.throws(() => cleanAiModel("opus --dangerously-skip-permissions"), /letters, digits/);
  assert.throws(() => cleanAiModel("opus&calc"), /letters, digits/);
  assert.throws(() => cleanAiEffort("extreme"), /Effort is one of/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-fake-claude-"));
  fs.writeFileSync(path.join(dir, "fake.cjs"), `const fs = require("fs"); const path = require("path"); let i = ""; process.stdin.on("data", (d) => (i += d)); process.stdin.on("end", () => { fs.writeFileSync(path.join(__dirname, "args.txt"), process.argv.slice(2).join(" ")); process.stdout.write('{"reply":"ok"}'); });`);
  let cli: string;
  if (process.platform === "win32") {
    cli = path.join(dir, "claude.cmd");
    fs.writeFileSync(cli, `@"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
  } else {
    cli = path.join(dir, "claude");
    fs.writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.cjs" "$@"\n`, { mode: 0o755 });
  }
  const r = await askAi({ tool: "claude", name: "Claude Code", path: cli }, "hello", { model: "opus", effort: "high" });
  assert.equal(r.text, '{"reply":"ok"}');
  assert.equal(fs.readFileSync(path.join(dir, "args.txt"), "utf8"), "-p --max-turns 1 --model opus --effort high");
  await askAi({ tool: "claude", name: "Claude Code", path: cli }, "hello");
  assert.equal(fs.readFileSync(path.join(dir, "args.txt"), "utf8"), "-p --max-turns 1", "nothing added when nothing was chosen");
});

test("in a chat, a tool's credential headers are hidden from the agent and put back in its answer", () => {
  const { hideToolSecrets, restoreToolSecrets } = core;
  const tool = cleanTool({ name: "Mine", kind: "view", source: { request: { method: "GET", path: "/api/me", headers: { Authorization: "Bearer real-token-123", "X-Trace": "on", "X-Api-Key": "{{key}}" } } } });
  const { shown, kept } = hideToolSecrets(tool);
  const h = (t: typeof tool) => (t.source as { request: { headers: Record<string, string> } }).request.headers;
  // Header names are kept in lower case.
  assert.equal(h(shown).authorization, "•••");
  assert.equal(h(shown)["x-trace"], "on");
  assert.equal(h(shown)["x-api-key"], "{{key}}", "an input holds no secret");
  assert.equal(h(tool).authorization, "Bearer real-token-123", "the tool itself is untouched");
  const answer = cleanTool({ ...shown, name: "Mine, renamed" });
  assert.equal(h(restoreToolSecrets(answer, kept)).authorization, "Bearer real-token-123");
});

test("on Windows, a CLI npm installed is found as its .cmd shim, not the extensionless script beside it", async () => {
  const { runnableFirst, commandExists } = core;
  const npm = ["C:/npm/claude", "C:/npm/claude.cmd", "C:/tools/claude.exe"];
  assert.deepEqual(runnableFirst(npm, "win32"), ["C:/npm/claude.cmd", "C:/tools/claude.exe", "C:/npm/claude"]);
  assert.deepEqual(runnableFirst(npm, "linux"), npm, "elsewhere, which's answer as it is");
  if (process.platform !== "win32") return;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "dx-npm-bin-"));
  fs.writeFileSync(path.join(bin, "dx-fake-agent"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(bin, "dx-fake-agent.cmd"), "@echo off\r\n");
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  try {
    assert.equal(await commandExists("dx-fake-agent"), path.join(bin, "dx-fake-agent.cmd"));
  } finally {
    process.env.PATH = before;
  }
});
