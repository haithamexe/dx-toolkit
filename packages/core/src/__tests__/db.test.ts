import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-db-test-"));
const { checkReadOnly, findDatabases, kindOfImage, queryDatabase, splitRedisCommand } = await import("../tools/db.js");

test("only reading statements get through", () => {
  const ok = (sql: string) => assert.ok("sql" in checkReadOnly(sql), sql);
  const no = (sql: string, why: RegExp) => {
    const r = checkReadOnly(sql);
    assert.ok("error" in r && why.test(r.error), `${sql} → ${JSON.stringify(r)}`);
  };
  ok("select * from orders");
  ok("SELECT id FROM orders WHERE status = 'update' -- a comment");
  ok('select "delete_at" from users;');
  ok("with recent as (select * from orders limit 5) select * from recent");
  ok("explain select * from orders");
  ok("select replace(name, 'a', 'b') from users");
  ok("show tables");
  no("delete from orders", /Only reading/);
  no("select 1; drop table orders", /One statement/);
  no("with gone as (delete from orders returning *) select * from gone", /"delete" changes/);
  no("explain analyze select 1", /EXPLAIN ANALYZE/);
  no("select * from orders for update", /"update" changes/);
  no("  ", /empty/);
});

test("tells databases apart by image and reads Redis commands", () => {
  assert.equal(kindOfImage("postgres:16-alpine"), "postgres");
  assert.equal(kindOfImage("docker.io/library/mariadb:11"), "mysql");
  assert.equal(kindOfImage("bitnami/redis"), "redis");
  assert.equal(kindOfImage("node:22"), undefined);
  assert.deepEqual(splitRedisCommand(`HGET "user:1 profile" name`), ["HGET", "user:1 profile", "name"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-db-compose-"));
  fs.writeFileSync(path.join(dir, "compose.yaml"), "services:\n  db:\n    image: postgres:16\n  api:\n    build: .\n  cache:\n    image: redis:7\n");
  assert.deepEqual(findDatabases({ dir }).map((d) => [d.service, d.kind]), [["db", "postgres"], ["cache", "redis"]]);
});

// A real Postgres in Docker: on Linux CI, where Docker is there. Elsewhere it's skipped.
const docker = process.platform === "linux" && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-db-real-"));
const compose = (...args: string[]) => execFileSync("docker", ["compose", ...args], { cwd: dir, stdio: "pipe", encoding: "utf8" });
after(() => {
  if (docker) spawnSync("docker", ["compose", "down", "-v"], { cwd: dir, stdio: "ignore" });
});

test("queries a real Postgres, and the session can't write", { skip: docker ? false : "needs Docker on Linux" }, async () => {
  fs.writeFileSync(path.join(dir, "compose.yaml"), `name: dx-db-test-${process.pid}\nservices:\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_USER: shop\n      POSTGRES_PASSWORD: devpass\n      POSTGRES_DB: shop\n`);
  compose("up", "-d");
  for (let i = 0; i < 60; i++) {
    // Over TCP: during first-time setup the image runs a temporary server on its socket only.
    if (spawnSync("docker", ["compose", "exec", "-T", "db", "pg_isready", "-h", "127.0.0.1", "-U", "shop"], { cwd: dir, stdio: "ignore" }).status === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  compose("exec", "-T", "db", "psql", "-U", "shop", "-d", "shop", "-c", "CREATE TABLE orders (id serial primary key, item text); INSERT INTO orders (item) VALUES ('cart');");
  const project = { name: "shop", dir };
  const tables = await queryDatabase(project, {});
  assert.deepEqual(tables.rows, [["public", "orders", "BASE TABLE"]]);
  const rows = await queryDatabase(project, { query: "select id, item from orders" });
  assert.deepEqual(rows.columns, ["id", "item"]);
  assert.deepEqual(rows.rows, [["1", "cart"]]);
  await assert.rejects(queryDatabase(project, { query: "select nextval('orders_id_seq')" }), /read-only transaction/);
});
