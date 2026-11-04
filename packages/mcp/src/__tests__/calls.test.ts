import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-calls-home-"));
const { callRecord, describeCall, recordCall, summarizeArgs } = await import("../calls.js");
const { readRuns } = await import("@dx/core");

const said = (text: string, isError = false) => ({ content: [{ type: "text", text }], isError });

test("a call's record says what the agent did, never what it sent or got back", () => {
  const started = callRecord("start_dev_server", { project: "shop", timeout_seconds: 60 }, said("shop-website: ready at http://localhost:5173"), 4200, "shop-website");
  assert.deepEqual(started, { tool: "mcp.start_dev_server", ok: true, detail: "Started shop-website's dev server", ms: 4200, args: "project=shop timeout_seconds=60", project: "shop-website" });

  // A database query and its rows stay out: only that there was a query, and how long it was.
  const sql = "select email, password_hash from users";
  const q = callRecord("db_query", { project: "shop", query: sql }, said("shop/db (postgres) in 3 ms, 1 row(s):\nemail\tpassword_hash\nalex@example.com\tabc"), 30, "shop-website");
  assert.equal(q.detail, "Queried shop-website's database");
  assert.equal(q.args, `project=shop query=(${sql.length} chars)`);
  assert.ok(!JSON.stringify(q).includes("alex@example.com") && !JSON.stringify(q).includes("password_hash"));
  const qFail = callRecord("db_query", { project: "shop", query: sql }, said(`ERROR: column "secret_token" does not exist in ${sql}`, true), 30, "shop-website");
  assert.equal(qFail.detail, "Queried shop-website's database: failed", "a query's error can echo it back, so nothing of it is kept");

  // Bodies, headers and notes are counted, not kept; credentials in an address are masked.
  const args = summarizeArgs("check_url", { url: "http://localhost:3000/cb?token=abc123&page=2", body: '{"password":"hunter2"}', headers: { authorization: "Bearer xyz" }, browser: true, steps: [{}, {}] });
  assert.equal(args, "url=http://localhost:3000/cb?token=•••&page=2 body=(22 chars) headers=(1) browser steps=[2]");
  assert.ok(!summarizeArgs("leave_note", { project: "shop", note: "the API key is sk-123" }).includes("sk-123"));
  assert.ok(!summarizeArgs("add_log_entry", { text: "salary talk" }).includes("salary"));
  assert.equal(summarizeArgs("list_projects", { query: "shop" }), "query=shop", "a project search is a name, kept");
  assert.equal(summarizeArgs("check_env", { project: "shop" }), "project=shop");
});

test("check_url and run_tests keep their numbers", () => {
  const page = [
    "http://shop.localhost/checkout loaded in headless Edge in 812 ms (HTTP 200): problems below.",
    "",
    "Uncaught exceptions:\n- TypeError: Cannot read properties of null\n    at app.js:3",
    "",
    "Failed requests:\n- GET http://shop.localhost/api/cart → 500",
  ].join("\n");
  assert.equal(describeCall("check_url", { project: "shop", path: "/checkout", browser: true }, true, said(page), "shop-website"), "Loaded /checkout on shop-website: 2 errors");
  const api = "GET http://localhost:5173/api/cart → 500 Internal Server Error in 12 ms\n\nErrors shop-website logged meanwhile:\n- [runtime] TypeError: x\n    at cart.ts:2";
  assert.equal(describeCall("check_url", { url: "http://localhost:5173/api/cart" }, false, said(api, true)), "Checked http://localhost:5173/api/cart: 500, 1 server error");
  assert.equal(describeCall("run_tests", { project: "shop" }, false, said("shop-website: 12 passed, 1 failed in 2.1s (vitest)", true), "shop-website"), "Ran shop-website's tests: 12 passed, 1 failed");
  assert.equal(describeCall("stop_dev_server", { project: "shop" }, true, said("Stopping shop."), "shop-website"), "Stopped shop-website's dev server");
  assert.equal(describeCall("git_stage", { project: "shop" }, true, said("ok"), "shop-website"), "Git: stage in shop-website", "MCP git tools get a sentence of their own");
});

test("records go to runs.jsonl as mcp.<tool> from source mcp", () => {
  recordCall(callRecord("activity_log", { project: "shop", problems: true }, said("…"), 12, "shop-website"));
  const last = readRuns(1)[0];
  assert.equal(last.tool, "mcp.activity_log");
  assert.equal(last.source, "mcp");
  assert.equal(last.project, "shop-website");
  assert.equal(last.detail, "Read shop-website's activity log (problems only)");
  assert.equal(last.args, "project=shop problems");
  assert.equal(last.ms, 12);
  assert.equal(last.ok, true);
});
