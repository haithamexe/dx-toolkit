import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordRun } from "../runs.js";
import { findDatabases, runSceneSql } from "./db.js";
import { parseDotenv } from "./envcheck.js";
import { databaseUrl, isLocalDatabase } from "./prepare.js";
import type { Project } from "./projects.js";
import type { Column, DataSchema, Rows, Scene, Table } from "./seeddata.js";
import { fillOrder, saveScene } from "./seeddata.js";

/**
 * Putting a scene into a project's development database, and saving what's there as one. Only a
 * database on this computer: a Prisma project's DATABASE_URL must be localhost, a Docker service
 * name or SQLite (the same guard as migrations), and a SQL project's database is the Postgres or
 * MySQL its docker-compose runs. Before a scene goes in, the data that's there is saved as a
 * backup scene, so loading is never a loss.
 */

export interface DataTarget {
  ok: boolean;
  /** "prisma" (through the project's own Prisma client) or "docker" (the compose database's client). */
  how?: "prisma" | "docker";
  /** Where it goes, in words: "SQLite file ./dev.db", "Postgres at localhost:5432", "the db container". */
  where?: string;
  /** Why it can't be loaded here. */
  why?: string;
}

export function dataTarget(project: Pick<Project, "dir" | "name">, schema: DataSchema): DataTarget {
  if (schema.source === "prisma") {
    if (schema.provider === "mongodb") return { ok: false, why: "MongoDB schemas aren't supported yet." };
    try {
      createRequire(path.join(project.dir, "package.json")).resolve("@prisma/client");
    } catch {
      return { ok: false, why: "@prisma/client isn't installed in the project. Run it once (dx prepares it), or npm install." };
    }
    const url = databaseUrl(project.dir);
    if (!url) return { ok: false, why: "No DATABASE_URL in .env, so there's no database to fill." };
    if (!isLocalDatabase(url)) return { ok: false, why: `The database in .env is at ${hostOf(url)}, not on this computer, so dx leaves it alone.` };
    return { ok: true, how: "prisma", where: /^file:|sqlite/i.test(url) ? `SQLite ${url.replace(/^file:/, "")}` : `${schema.provider ?? "the database"} at ${hostOf(url)}` };
  }
  const db = findDatabases(project).find((d) => d.kind === "postgres" || d.kind === "mysql");
  if (!db) return { ok: false, why: "A SQL schema without Prisma needs its Postgres or MySQL in docker-compose; SQLite without Prisma isn't supported yet." };
  return { ok: true, how: "docker", where: `${db.kind === "postgres" ? "Postgres" : "MySQL"} in the ${db.service} container` };
}

function hostOf(url: string): string {
  try {
    const u = new URL(url.replace(/^([a-z+]+):\/\//i, "http://"));
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return "another address";
  }
}

// ------------------------------------------------------------------ Prisma

// Runs in the project's folder with its own @prisma/client: deletes and refills every model in
// one transaction, or reads them all. Data comes from a file dx wrote; nothing from a request.
const PRISMA_RUNNER = `
const fs = require("fs");
const [, , mode, specFile, outFile] = process.argv;
const { PrismaClient } = require(require.resolve("@prisma/client", { paths: [process.cwd()] }));
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
const db = new PrismaClient();
const key = (m) => m.charAt(0).toLowerCase() + m.slice(1);
(async () => {
  if (mode === "dump") {
    const rows = {};
    for (const m of spec.order) rows[m] = await db[key(m)].findMany({ select: Object.fromEntries(spec.scalars[m].map((f) => [f, true])), take: 5000 });
    fs.writeFileSync(outFile, JSON.stringify(rows, (k, v) => (typeof v === "bigint" ? Number(v) : v && v.constructor && v.constructor.name === "Decimal" ? Number(v) : v)));
  } else {
    await db.$transaction(async (tx) => {
      for (const m of [...spec.order].reverse()) await tx[key(m)].deleteMany({});
      for (const m of spec.order) {
        const data = spec.rows[m] || [];
        if (!data.length) continue;
        if (spec.oneByOne) { for (const d of data) await tx[key(m)].create({ data: d }); }
        else await tx[key(m)].createMany({ data });
      }
    }, { timeout: 180000, maxWait: 30000 });
    for (const s of spec.after || []) { try { await db.$executeRawUnsafe(s); } catch (e) {} }
  }
  await db.$disconnect();
})().catch(async (e) => {
  const msg = String((e && e.message) || e).split("\\n").map((l) => l.trim()).filter(Boolean);
  console.error(msg.slice(-2).join(" "));
  try { await db.$disconnect(); } catch {}
  process.exit(1);
});
`;

function runNode(dir: string, args: string[], timeoutMs = 240_000): Promise<{ ok: boolean; err: string }> {
  // The project's .env, under what's already set (Prisma reads it too; this covers other places).
  const env: Record<string, string> = {};
  for (const f of [".env", ".env.local", ".env.development"]) {
    try {
      for (const [k, v] of parseDotenv(fs.readFileSync(path.join(dir, f), "utf8"))) env[k] ??= v;
    } catch {
      // no such file
    }
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: dir, env: { ...env, ...process.env }, windowsHide: true });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.stdout.resume();
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, err: err.trim().split("\n").slice(-2).join(" ").slice(0, 500) });
    });
    child.on("error", (e) => resolve({ ok: false, err: e.message }));
  });
}

function scalarsOf(schema: DataSchema): Record<string, string[]> {
  return Object.fromEntries(schema.tables.map((t) => [t.name, t.columns.filter((c) => c.type !== "bytes").map((c) => c.name)]));
}

/** Statements that move autoincrement counters past the ids a scene used (Postgres keeps them apart from the rows). */
function sequenceFixes(schema: DataSchema, quote: (s: string) => string): string[] {
  if (schema.provider && schema.provider !== "postgresql" && schema.provider !== "cockroachdb") return [];
  return schema.tables.flatMap((t) =>
    t.columns
      .filter((c) => c.generated === "autoincrement")
      .map((c) => `SELECT setval(pg_get_serial_sequence('${quote(t.dbName).replace(/'/g, "''")}', '${c.dbName.replace(/'/g, "''")}'), COALESCE((SELECT MAX(${quote(c.dbName)}) FROM ${quote(t.dbName)}), 1))`),
  );
}

async function prismaRun(project: Pick<Project, "dir">, mode: "load" | "dump", spec: object): Promise<unknown> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dx-data-"));
  try {
    const runner = path.join(work, "runner.cjs");
    const specFile = path.join(work, "spec.json");
    const outFile = path.join(work, "out.json");
    fs.writeFileSync(runner, PRISMA_RUNNER);
    fs.writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600 });
    let r = await runNode(project.dir, [runner, mode, specFile, outFile]);
    // SQLite (and older Prisma) has no createMany: one by one instead.
    if (!r.ok && mode === "load" && /createMany|is not a function|not supported/i.test(r.err)) {
      fs.writeFileSync(specFile, JSON.stringify({ ...spec, oneByOne: true }), { mode: 0o600 });
      r = await runNode(project.dir, [runner, mode, specFile, outFile]);
    }
    if (!r.ok) throw new Error(r.err || "The Prisma client stopped with an error.");
    return mode === "dump" ? JSON.parse(fs.readFileSync(outFile, "utf8")) : undefined;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ SQL through the container

function literal(v: unknown, c: Column | undefined, mysql: boolean): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  let s = typeof v === "string" ? v : JSON.stringify(v);
  if (c?.type === "date" && mysql && /^\d{4}-\d\d-\d\dT/.test(s)) s = s.replace("T", " ").slice(0, 19);
  if (mysql) s = s.replace(/\\/g, "\\\\");
  return `'${s.replace(/'/g, "''")}'`;
}

function sqlLoad(schema: DataSchema, rows: Rows, mysql: boolean): string {
  const q = (s: string) => (mysql ? `\`${s.replace(/`/g, "``")}\`` : `"${s.replace(/"/g, '""')}"`);
  const order = fillOrder(schema.tables);
  const byName = new Map(schema.tables.map((t) => [t.name, t]));
  const out: string[] = mysql ? ["SET FOREIGN_KEY_CHECKS=0;", "START TRANSACTION;"] : ["BEGIN;"];
  if (mysql) for (const n of [...order].reverse()) out.push(`DELETE FROM ${q(byName.get(n)!.dbName)};`);
  else out.push(`TRUNCATE ${order.map((n) => q(byName.get(n)!.dbName)).join(", ")} RESTART IDENTITY CASCADE;`);
  for (const n of order) {
    const t = byName.get(n)!;
    const list = rows[n] ?? [];
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      const cols = t.columns.filter((c) => chunk.some((r) => c.name in r));
      if (!cols.length) continue;
      out.push(`INSERT INTO ${q(t.dbName)} (${cols.map((c) => q(c.dbName)).join(", ")}) VALUES\n${chunk.map((r) => `(${cols.map((c) => literal(r[c.name], c, mysql)).join(", ")})`).join(",\n")};`);
    }
  }
  if (!mysql) out.push(...sequenceFixes({ ...schema, provider: "postgresql" }, q).map((s) => `${s};`));
  out.push("COMMIT;");
  if (mysql) out.push("SET FOREIGN_KEY_CHECKS=1;");
  return out.join("\n") + "\n";
}

async function sqlDump(project: Pick<Project, "name" | "dir">, schema: DataSchema): Promise<Rows> {
  const mysql = findDatabases(project).find((d) => d.kind === "postgres" || d.kind === "mysql")?.kind === "mysql";
  const rows: Rows = {};
  for (const t of schema.tables) {
    const cols = t.columns.filter((c) => c.type !== "bytes");
    const sql = mysql
      ? `SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(${cols.map((c) => `'${c.name.replace(/'/g, "''")}', \`${c.dbName.replace(/`/g, "``")}\``).join(", ")})), JSON_ARRAY()) FROM (SELECT * FROM \`${t.dbName.replace(/`/g, "``")}\` LIMIT 5000) x;\n`
      : `SELECT COALESCE(json_agg(json_build_object(${cols.map((c) => `'${c.name.replace(/'/g, "''")}', x."${c.dbName.replace(/"/g, '""')}"`).join(", ")})), '[]'::json) FROM (SELECT * FROM "${t.dbName.replace(/"/g, '""')}" LIMIT 5000) x;\n`;
    const { stdout } = await runSceneSql(project, sql);
    rows[t.name] = JSON.parse(stdout.trim() || "[]") as Array<Record<string, unknown>>;
  }
  return rows;
}

// ------------------------------------------------------------------ the two operations

/** What's in the database now, as a scene (not saved). */
async function dumpCurrent(project: Pick<Project, "name" | "dir">, schema: DataSchema, name: string, kind: "saved" | "backup"): Promise<Scene> {
  const target = dataTarget(project, schema);
  if (!target.ok) throw new Error(target.why);
  const order = fillOrder(schema.tables);
  const rows = target.how === "prisma" ? ((await prismaRun(project, "dump", { order, scalars: scalarsOf(schema) })) as Rows) : await sqlDump(project, schema);
  return { format: "dx-scene", version: 1, name, kind, createdAt: new Date().toISOString(), order, rows };
}

/** What's in the database now, saved as a scene under `name`. */
export async function saveCurrentData(project: Pick<Project, "name" | "dir">, schema: DataSchema, name: string, kind: "saved" | "backup" = "saved"): Promise<Scene> {
  const scene = await dumpCurrent(project, schema, name, kind);
  saveScene(project.dir, scene);
  return scene;
}

export interface LoadResult {
  scene: string;
  rows: number;
  tables: number;
  /** The backup scene the data that was there went to, when there was any. */
  backup?: string;
  where: string;
  ms: number;
}

/** Replaces the database's rows with the scene's, after saving what's there as a backup scene. */
export async function loadData(project: Pick<Project, "name" | "dir">, schema: DataSchema, scene: Scene, options: { backup?: boolean; source?: "cli" | "web" | "mcp" } = {}): Promise<LoadResult> {
  const t0 = Date.now();
  const target = dataTarget(project, schema);
  if (!target.ok) throw new Error(target.why);
  // Only tables the schema has, only their columns.
  const tables = new Map(schema.tables.map((t) => [t.name, t]));
  const rows: Rows = {};
  for (const [name, list] of Object.entries(scene.rows)) {
    const t: Table | undefined = tables.get(name);
    if (!t) continue;
    const known = new Set(t.columns.map((c) => c.name));
    rows[name] = list.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => known.has(k))));
  }
  let backup: string | undefined;
  if (options.backup !== false) {
    try {
      const b = await dumpCurrent(project, schema, `Before ${scene.name}, ${new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" })}`, "backup");
      // An empty database has nothing to lose: no backup then.
      if (Object.values(b.rows).some((r) => r.length)) {
        saveScene(project.dir, b);
        backup = b.name;
      }
    } catch (err) {
      throw new Error(`Couldn't save the data that's there first, so nothing was changed: ${(err as Error).message}`);
    }
  }
  const order = fillOrder(schema.tables);
  if (target.how === "prisma") {
    const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
    await prismaRun(project, "load", { order, rows, after: sequenceFixes(schema, quote) });
  } else {
    const mysql = target.where?.startsWith("MySQL") ?? false;
    await runSceneSql(project, sqlLoad(schema, rows, mysql));
  }
  const count = Object.values(rows).reduce((n, r) => n + r.length, 0);
  recordRun("data", true, `${project.name}: loaded "${scene.name}" (${count} rows)${backup ? `, the old data saved as "${backup}"` : ""}`, options.source ?? "web", { project: project.name });
  return { scene: scene.name, rows: count, tables: Object.keys(rows).length, backup, where: target.where ?? "", ms: Date.now() - t0 };
}
