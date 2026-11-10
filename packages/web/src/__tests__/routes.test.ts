import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The dashboard's route tables become one map, and a route that two tables both answer is an error.
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-routes-home-"));
const { apiRoutes, mergeRoutes } = await import("../api.js");
const { trimJobs } = await import("../jobs.js");

test("every route in the dashboard is in one table, and shaped like METHOD /api/path", () => {
  const routes = apiRoutes();
  const keys = Object.keys(routes);
  assert.ok(keys.length > 150, `${keys.length} routes`);
  assert.deepEqual(keys.filter((k) => !/^(GET|POST) \/api\/[\w/-]+$/.test(k)), []);
  assert.ok(keys.includes("GET /api/agents") && keys.includes("POST /api/dev-tools/run"), "the newer tables are in");
});

test("a route in two tables fails loudly, naming both", () => {
  const h = () => null;
  assert.throws(() => mergeRoutes({ first: { "GET /api/x": h }, second: { "GET /api/x": h } }), /"GET \/api\/x" is in two route tables: first and second/);
  assert.deepEqual(Object.keys(mergeRoutes({ a: { "GET /api/x": h }, b: { "GET /api/y": h } })), ["GET /api/x", "GET /api/y"]);
  assert.equal(mergeRoutes({ a: {} })["constructor"], undefined, "no inherited keys answer a request");
});

test("old finished jobs go past the cap; a running one never does", () => {
  const jobs = new Map<string, { done: boolean }>([["a", { done: true }], ["b", { done: false }], ["c", { done: true }], ["d", { done: false }]]);
  trimJobs(jobs, 2, (j) => j.done);
  assert.deepEqual([...jobs.keys()], ["b", "d"]);
  trimJobs(jobs, 0, (j) => j.done);
  assert.deepEqual([...jobs.keys()], ["b", "d"], "running jobs stay even over the cap");
});
