import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Queries per request: statements read from a Postgres log and MySQL's slow log table, values taken
// out, each matched to the request it ran in, and what's worth fixing. Plus a real Postgres in Docker.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-queries-home-"));
process.env.DX_HOME = home;
const { shapeSql, parsePostgresLog, parseMysqlSlowLog, attributeQueries, eventsSince, queryFindings, setQueryLog, queryLogState, queryReport, readQueries, QUERY_LIMITS } = await import("../tools/querylog.js");
const { databaseLog, findDatabases } = await import("../tools/db.js");
type Ev = import("../tools/activity.js").ActivityEvent;

test("values never stay in a statement", () => {
  assert.equal(shapeSql("SELECT * FROM users WHERE email = 'ada@example.com' AND id = 42 LIMIT 10"), "SELECT * FROM users WHERE email = ? AND id = ? LIMIT ?");
  assert.equal(shapeSql('SELECT "public"."orders"."id" FROM "public"."orders" WHERE "userId" = $1 OFFSET $2'), 'SELECT "public"."orders"."id" FROM "public"."orders" WHERE "userId" = ? OFFSET ?');
  assert.equal(shapeSql("select * from t where id in (1, 2, 3) and ok = true"), "select * from t where id in (?…) and ok = ?");
  assert.equal(shapeSql("INSERT INTO items (a, b) VALUES (1, 'x'), (2, 'y''s')"), "INSERT INTO items (a, b) VALUES (?…)…");
  assert.equal(shapeSql("SELECT col2, t1.x FROM t1 -- note 'secret'\nWHERE x > 3.5e2"), "SELECT col2, t1.x FROM t1 WHERE x > ?");
});

test("a Postgres log gives each statement once, with when it started and how long it took", () => {
  const log = [
    "2026-11-05T10:00:00.120000000Z 2026-11-05 10:00:00.120 UTC [41] LOG:  duration: 0.512 ms  parse <unnamed>: SELECT * FROM orders WHERE user_id = $1",
    "2026-11-05T10:00:00.121000000Z 2026-11-05 10:00:00.121 UTC [41] LOG:  duration: 0.105 ms  bind <unnamed>: SELECT * FROM orders WHERE user_id = $1",
    "2026-11-05T10:00:00.122000000Z 2026-11-05 10:00:00.122 UTC [41] DETAIL:  parameters: $1 = '7'",
    "2026-11-05T10:00:00.130000000Z 2026-11-05 10:00:00.130 UTC [41] LOG:  duration: 8.000 ms  execute <unnamed>: SELECT * FROM orders WHERE user_id = $1",
    "2026-11-05T10:00:00.131000000Z 2026-11-05 10:00:00.131 UTC [41] DETAIL:  parameters: $1 = 'secret-value'",
    "2026-11-05T10:00:01.000000000Z 2026-11-05 10:00:01.000 UTC [42] LOG:  duration: 1.250 ms  statement: SELECT name",
    "2026-11-05T10:00:01.000000000Z 	FROM products",
    "2026-11-05T10:00:01.000000000Z 	WHERE price > 10",
    "2026-11-05T10:00:01.500000000Z 2026-11-05 10:00:01.500 UTC [42] LOG:  duration: 0.010 ms  statement: BEGIN",
    "2026-11-05T10:00:02.000000000Z 2026-11-05 10:00:02.000 UTC [1] LOG:  checkpoint starting: time",
  ].join("\n");
  const q = parsePostgresLog(log);
  assert.deepEqual(q.map((x) => [x.shape, x.ms]), [["SELECT * FROM orders WHERE user_id = ?", 8], ["SELECT name FROM products WHERE price > ?", 1.25]]);
  assert.equal(q[0].at, Date.parse("2026-11-05T10:00:00.130Z") - 8);
  assert.ok(!JSON.stringify(q).includes("secret-value"));
});

test("MySQL's slow log rows read the same way", () => {
  const q = parseMysqlSlowLog(["1793872800.250000\t0.004000\t12\tSELECT * FROM users WHERE id = 5", "1793872800.300000\t0.000100\t12\tSET GLOBAL slow_query_log = 1", "not a row"].join("\n"));
  assert.deepEqual(q, [{ at: 1793872800250 - 4, ms: 4, shape: "SELECT * FROM users WHERE id = ?", conn: "12" }]);
});

let id = 0;
const req = (at: number, url: string, ms: number, method = "GET"): Ev => ({ id: ++id, at: new Date(at).toISOString(), dir: "/x", project: "shop-website", type: "request", text: "", url, method, status: 200, ms, from: "proxy" });

test("a request still being answered when logging came on counts; one that had ended doesn't", () => {
  const since = "2026-11-06T15:11:23.520Z";
  const t = Date.parse(since);
  // CI once saw this: the request started 4 ms before logging was on and ran all its statements after.
  const inFlight = req(t - 4, "/api/orders", 1477);
  const ended = req(t - 500, "/api/old", 20);
  const later = req(t + 50, "/api/new", 10);
  assert.deepEqual(eventsSince([inFlight, ended, later], since).map((e) => e.url), ["/api/orders", "/api/new"]);
  const loop = Array.from({ length: 11 }, (_, i) => ({ at: t + 181 + i * 96, ms: 1, shape: "SELECT name FROM items WHERE order_id = ?", conn: String(107 + i * 7) }));
  const { requests, outside } = attributeQueries(eventsSince([inFlight], since), loop);
  assert.equal(outside, 0);
  assert.equal(requests[0]?.queries, 11);
});

test("calls a page sends together: the slow one doesn't take the quick one's queries", () => {
  const t = Date.parse("2026-11-05T11:00:00Z");
  const events = [req(t, "/api/lists", 47), req(t + 1, "/api/stats", 330)];
  const queries = [
    { at: t + 3, ms: 2, shape: "SELECT id, name FROM lists" },
    ...Array.from({ length: 14 }, (_, i) => ({ at: t + 6 + i * 2, ms: 0.1, shape: "SELECT id, title FROM items WHERE list_id = ?" })),
    { at: t + 5, ms: 300, shape: "SELECT count(*), pg_sleep(?) FROM items" },
  ];
  const { requests } = attributeQueries(events, queries);
  const byPath = Object.fromEntries(requests.map((r) => [r.path, r]));
  assert.equal(byPath["/api/lists"].queries, 15);
  assert.equal(byPath["/api/lists"].repeated?.count, 14);
  assert.equal(byPath["/api/stats"].queries, 1);
  assert.equal(byPath["/api/stats"].slowest?.ms, 300);
});

test("a loop on one connection stays together, also when the database's clock is a little off", () => {
  const t = Date.parse("2026-11-05T12:00:00Z");
  // The page's own load ends just before its list call starts; the database's clock is 12 ms behind.
  const events = [{ ...req(t - 30, "/", 28), type: "page" as const }, req(t, "/api/lists", 40)];
  const skew = -12;
  const loop = Array.from({ length: 14 }, (_, i) => ({ at: t + 3 + i * 2 + skew, ms: 0.5, shape: "SELECT id, title FROM items WHERE list_id = ?", conn: "87" }));
  const { requests } = attributeQueries(events, loop, 5);
  assert.deepEqual(requests.map((r) => [r.path, r.queries]), [["/api/lists", 14]]);
});

test("each statement goes to the request answering it; the tighter one when two overlap", () => {
  const t = Date.parse("2026-11-05T10:00:00Z");
  const events = [req(t, "/api/orders", 100), req(t + 50, "/api/me", 20), req(t + 1000, "/api/orders/9", 400)];
  const queries = [
    ...Array.from({ length: 12 }, (_, i) => ({ at: t + 1 + i, ms: 1, shape: "SELECT * FROM items WHERE order_id = ?" })),
    { at: t + 55, ms: 2, shape: "SELECT * FROM users WHERE id = ?" },
    { at: t + 1005, ms: 350, shape: "SELECT * FROM orders WHERE id = ?" },
    { at: t + 5000, ms: 1, shape: "SELECT ?" },
  ];
  const { requests, outside } = attributeQueries(events, queries);
  assert.equal(outside, 1);
  const byPath = Object.fromEntries(requests.map((r) => [r.path, r]));
  assert.equal(byPath["/api/orders"].queries, 12);
  assert.equal(byPath["/api/orders"].repeated?.count, 12);
  assert.equal(byPath["/api/me"].queries, 1);
  assert.equal(byPath["/api/orders/:id"].slowest?.ms, 350);
  const f = queryFindings(requests);
  assert.deepEqual(f.map((x) => [x.kind, x.text]), [["n+1", "GET /api/orders runs the same query 12 times"], ["slow", "A query took 350 ms in GET /api/orders/:id"]]);
  assert.equal(QUERY_LIMITS.repeat, 10);
});

test("without a database in docker-compose it says so", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-queries-none-"));
  await assert.rejects(setQueryLog({ name: "todo-app", dir }, true), /no Postgres or MySQL/);
  assert.equal(queryLogState(dir), undefined);
  const r = await queryReport({ name: "todo-app", dir }, []);
  assert.equal(r.on, false);
  assert.match(r.note ?? "", /aren't being logged/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A real Postgres in Docker: on Linux CI, where Docker is there (or DX_TEST_DOCKER=1). Elsewhere it's skipped.
const docker = (process.platform === "linux" || process.env.DX_TEST_DOCKER === "1") && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-queries-real-"));
after(() => {
  if (docker) spawnSync("docker", ["compose", "down", "-v"], { cwd: dir, stdio: "ignore" });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("a real Postgres: logging on, statements matched to requests, and back off", { skip: docker ? false : "needs Docker on Linux" }, async () => {
  fs.writeFileSync(path.join(dir, "compose.yaml"), `name: dx-queries-test-${process.pid}\nservices:\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_USER: shop\n      POSTGRES_PASSWORD: devpass\n      POSTGRES_DB: shop\n`);
  const compose = (...args: string[]) => execFileSync("docker", ["compose", ...args], { cwd: dir, stdio: "pipe", encoding: "utf8" });
  compose("up", "-d");
  for (let i = 0; i < 60; i++) {
    if (spawnSync("docker", ["compose", "exec", "-T", "db", "pg_isready", "-h", "127.0.0.1", "-U", "shop"], { cwd: dir, stdio: "ignore" }).status === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const psql = (sql: string) => compose("exec", "-T", "db", "psql", "-U", "shop", "-d", "shop", "-Atc", sql).trim();
  psql("CREATE TABLE items (id serial primary key, order_id int, name text)");
  const project = { name: "shop", dir };
  const state = await setQueryLog(project, true);
  assert.equal(state?.service, "db");
  assert.equal(psql("SHOW log_min_duration_statement"), "0");
  // A request, and the N+1 it causes while it's being answered.
  const start = Date.now();
  for (let i = 0; i < 11; i++) psql(`SELECT name FROM items WHERE order_id = ${i}`);
  const ms = Date.now() - start + 200;
  const events = [{ ...req(start - 100, "/api/orders", ms), dir }];
  // Docker's log can take a moment to have the lines: read until the statements are there.
  let r = await queryReport(project, events);
  for (let i = 0; i < 30 && (r.requests[0]?.queries ?? 0) < 11; i++) {
    await new Promise((res) => setTimeout(res, 500));
    r = await queryReport(project, events);
  }
  assert.equal(r.on, true);
  const orders = r.requests.find((x) => x.path === "/api/orders");
  if (!orders || orders.queries < 11) {
    // What was read, to tell a log that didn't have the lines from lines that didn't match.
    const { queries } = await readQueries(project, r.since!);
    const log = await databaseLog(findDatabases(project)[0], r.since!);
    assert.fail(JSON.stringify({ window: [events[0].at, ms], since: r.since, read: r.queries, outside: r.outside, first: queries.slice(0, 3), logLines: log.split("\n").length, logStart: log.slice(0, 600) }));
  }
  assert.equal(orders!.repeated?.shape, "SELECT name FROM items WHERE order_id = ?");
  assert.equal(r.findings[0]?.kind, "n+1");
  await setQueryLog(project, false);
  assert.equal(queryLogState(dir), undefined);
  assert.notEqual(psql("SHOW log_min_duration_statement"), "0");
});
