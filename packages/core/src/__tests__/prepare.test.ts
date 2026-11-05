import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-prepare-test-"));
const { planPrepare, runPrepare, isLocalDatabase, forgetPrepared } = await import("../index.js");

function project(files: Record<string, string>, name = "shop-website") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
  return { dir, name, packageManager: "npm" as const };
}
const step = (steps: Array<{ id: string }>, id: string) => steps.find((s) => s.id === id) as any;
const pkg = (extra: object = {}) => JSON.stringify({ name: "shop-website", scripts: { dev: "vite" }, ...extra });

test("packages: installed when node_modules is missing, and again when the lock file changes", () => {
  assert.equal(step(planPrepare(project({ "package.json": pkg() })), "install:."), undefined, "no dependencies: nothing to install");
  const p = project({ "package.json": pkg({ dependencies: { vite: "7" } }), "package-lock.json": '{"v":1}' });
  assert.equal(step(planPrepare(p), "install:.").status, "todo");
  assert.match(step(planPrepare(p), "install:.").why, /node_modules is missing/);
  assert.equal(step(planPrepare(p), "install:.").command, "npm install");

  // Installed after the lock file was written: dx counts it as installed and remembers the lock.
  fs.mkdirSync(path.join(p.dir, "node_modules", "vite"), { recursive: true });
  fs.writeFileSync(path.join(p.dir, "node_modules", ".package-lock.json"), "{}");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(p.dir, "node_modules", ".package-lock.json"), later, later);
  assert.equal(step(planPrepare(p), "install:.").status, "ok");
  assert.equal(step(planPrepare(p), "install:.").status, "ok", "remembered");

  fs.writeFileSync(path.join(p.dir, "package-lock.json"), '{"v":2}');
  const again = step(planPrepare(p), "install:.");
  assert.equal(again.status, "todo");
  assert.match(again.why, /package-lock\.json changed/);
  assert.equal(step(planPrepare(p, { force: true }), "install:.").status, "todo");
});

test(".env: made from the example when it's missing; values the example has and .env doesn't are a warning", () => {
  const p = project({ "package.json": pkg(), ".env.example": "API_URL=\nPORT=3000\n" });
  const env = step(planPrepare(p), "env");
  assert.deepEqual([env.status, env.action, env.blocking], ["todo", "env", false]);
  fs.writeFileSync(path.join(p.dir, ".env"), "PORT=3000\n");
  const warn = step(planPrepare(p), "env");
  assert.equal(warn.status, "warn");
  assert.match(warn.why, /API_URL is in \.env\.example but not in \.env/);
});

test("migrations: run for a database on this computer, only when they changed; never against another one, never a resetting script", () => {
  const files = {
    "package.json": pkg({ dependencies: { "@prisma/client": "5" } }),
    "prisma/schema.prisma": 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }',
    "prisma/migrations/20260101_init/migration.sql": "CREATE TABLE a (id int);",
    ".env": "DATABASE_URL=postgresql://dev:dev@localhost:5432/shop\n",
  };
  const p = project(files);
  const plan = planPrepare(p);
  assert.equal(step(plan, "prisma-generate").status, "todo", "the client isn't generated yet");
  const migrate = step(plan, "migrate");
  assert.deepEqual([migrate.status, migrate.command, migrate.phase], ["todo", "npx prisma migrate deploy", "before"]);
  assert.equal(step(planPrepare(p, { docker: true }), "migrate").phase, "db", "in a stack with Docker, after the databases are up");

  const remote = project({ ...files, ".env": "DATABASE_URL=postgresql://admin:x@prod-db.example.com:5432/shop\n" });
  const skipped = step(planPrepare(remote), "migrate");
  assert.equal(skipped.status, "skip");
  assert.match(skipped.why, /prod-db\.example\.com, not on this computer/);

  const resetting = project({ "package.json": pkg({ scripts: { dev: "vite", "db:migrate": "prisma migrate reset --force && prisma db seed" } }) });
  const unsafe = step(planPrepare(resetting), "migrate");
  assert.equal(unsafe.status, "skip");
  assert.match(unsafe.why, /resets, drops or seeds/);

  const django = project({ "manage.py": "", "shop/migrations/0001_initial.py": "", ".env": "DB_HOST=db\n" }, "api-gateway");
  assert.match(step(planPrepare(django), "migrate").command, /manage\.py migrate --noinput/);

  assert.equal(isLocalDatabase("postgresql://u:p@127.0.0.1/x"), true);
  assert.equal(isLocalDatabase("mysql://u:p@db:3306/x"), true, "a Docker service name");
  assert.equal(isLocalDatabase("file:./dev.db"), true);
  assert.equal(isLocalDatabase("postgresql://u:p@abc.supabase.co/x"), false);
});

test("workspace packages the app imports from a build folder that isn't built yet are built first", () => {
  const p = project({
    "package.json": pkg({ workspaces: ["packages/*"] }),
    "package-lock.json": "{}",
    "packages/ui/package.json": JSON.stringify({ name: "@shop/ui", main: "dist/index.js", scripts: { build: "tsc" } }),
    "packages/utils/package.json": JSON.stringify({ name: "@shop/utils", main: "src/index.ts", scripts: { build: "tsc" } }),
  });
  const builds = planPrepare(p).filter((s) => s.id.startsWith("build:"));
  assert.deepEqual(builds.map((s) => [s.id, s.command]), [["build:@shop/ui", "npm run build -w @shop/ui"]]);
  fs.mkdirSync(path.join(p.dir, "packages/ui/dist"), { recursive: true });
  fs.writeFileSync(path.join(p.dir, "packages/ui/dist/index.js"), "");
  assert.equal(planPrepare(p).filter((s) => s.id.startsWith("build:")).length, 0, "built: nothing to do");
});

test(".devrc.json: steps of the project's own, or none at all", () => {
  const p = project({ "package.json": pkg(), ".devrc.json": JSON.stringify({ prepare: ["node -e \"console.log('codegen')\"", { run: "node seed.js", after: "db", title: "Seed" }] }) });
  const custom = planPrepare(p).filter((s) => s.id.startsWith("custom-"));
  assert.deepEqual(custom.map((s) => [s.title, s.phase]), [["node -e \"console.log('codegen')\"", "before"], ["Seed", "db"]]);
  const off = project({ "package.json": pkg(), ".devrc.json": JSON.stringify({ prepare: false }) });
  assert.deepEqual(planPrepare(off), []);
});

test("running: output line by line, .env created, remembered once done; a failing step stops the rest with its fix", async () => {
  const p = project({
    "package.json": pkg(),
    ".env.example": "PORT=3000\n",
    ".devrc.json": JSON.stringify({ prepare: ["node -e \"console.log('generated')\"", "node -e \"console.log('Error: cannot reach the schema registry');console.log('bye');process.exit(3)\"", "node -e \"console.log('never')\""] }),
  });
  forgetPrepared(p.dir);
  // node_modules is missing; keep the install out of this test.
  fs.mkdirSync(path.join(p.dir, "node_modules", "x"), { recursive: true });
  const steps = planPrepare(p).filter((s) => s.id !== "install:." && s.id !== "port");
  const log: string[] = [];
  const r = await runPrepare(steps, p.dir, "before", { log: (l) => log.push(l) });
  assert.equal(r.ok, false);
  assert.equal(r.failed?.id, "custom-1");
  assert.equal(r.failed?.output, "Error: cannot reach the schema registry", "the line that says what went wrong, not the last one");
  assert.ok(r.failed?.fix, "a custom step says what to do next");
  assert.ok(fs.existsSync(path.join(p.dir, ".env")), ".env made from the example");
  assert.ok(log.includes("generated"), "the step's own output");
  assert.ok(log.some((l) => /✗ .*exited with 3/.test(l)));
  assert.ok(!log.includes("never"), "nothing after a failed step");
  assert.deepEqual(steps.map((s) => s.status), ["done", "done", "failed", "todo"]);
});
