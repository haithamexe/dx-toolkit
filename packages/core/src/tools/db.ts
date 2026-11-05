import { spawn } from "node:child_process";
import path from "node:path";
import { recordRun } from "../runs.js";
import type { Project } from "./projects.js";
import { readCompose } from "./stacks.js";

/**
 * Read-only queries against a project's development database, the one its docker-compose runs:
 * Postgres, MySQL/MariaDB or Redis. The query runs inside the container with the client it ships,
 * as the user the container was set up with, so there's nothing to install and no password to
 * give. Only reading statements get through, and the session itself is read-only.
 */

export type DbKind = "postgres" | "mysql" | "redis";

export interface DbService {
  service: string;
  kind: DbKind;
  image: string;
  composeDir: string;
}

export interface DbResult {
  service: string;
  kind: DbKind;
  columns: string[];
  rows: string[][];
  /** More rows came back than are kept. */
  truncated: boolean;
  ms: number;
  /** Plain text for answers that aren't a table (Redis, EXPLAIN). */
  text?: string;
}

const MAX_ROWS = 200;

export function kindOfImage(image: string): DbKind | undefined {
  const name = image.toLowerCase().split("@")[0].split(":")[0].split("/").pop() ?? "";
  if (/^(postgres|postgis|timescaledb|pgvector)/.test(name)) return "postgres";
  if (/^(mysql|mariadb|percona)/.test(name)) return "mysql";
  if (/^(redis|valkey|keydb)/.test(name)) return "redis";
  return undefined;
}

/** The databases in a project's docker-compose. */
export function findDatabases(project: Pick<Project, "dir">): DbService[] {
  const compose = readCompose(project.dir);
  if (!compose) return [];
  return compose.services.flatMap((s) => {
    const kind = s.image ? kindOfImage(s.image) : undefined;
    return kind && s.image ? [{ service: s.name, kind, image: s.image, composeDir: path.dirname(compose.file) }] : [];
  });
}

const WRITES = /\b(insert|update|delete|merge|upsert|replace|drop|alter|create|truncate|grant|revoke|copy|call|do|lock|vacuum|analyze|reindex|cluster|set|reset|load|handler|rename|comment|refresh|listen|notify|prepare|execute|begin|commit|rollback|savepoint|start)\b/i;
const READS = /^(select|with|show|explain|table|values|describe|desc)\b/i;

/** The statement, if it only reads; otherwise why not. */
export function checkReadOnly(sql: string): { sql: string } | { error: string } {
  const noComments = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim().replace(/;\s*$/, "").trim();
  if (!noComments) return { error: "The query is empty." };
  // Literals and quoted names can hold anything ('update', "delete_at"); look at the rest.
  const bare = noComments.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""').replace(/`[^`]*`/g, "``");
  if (bare.includes(";")) return { error: "One statement at a time." };
  if (!READS.test(bare)) return { error: "Only reading queries run here: SELECT, WITH, SHOW, EXPLAIN, DESCRIBE." };
  if (/^explain\b[^;]*\banalyze\b/i.test(bare)) return { error: "EXPLAIN ANALYZE runs the statement; use EXPLAIN on its own." };
  const w = WRITES.exec(bare.replace(/^explain\s+/i, ""));
  if (w && !(w[1].toLowerCase() === "replace" && /\breplace\s*\(/i.test(bare))) return { error: `"${w[1]}" changes things; this only reads.` };
  return { sql: noComments };
}

// Redis commands that only read.
const REDIS_READS = new Set(
  "get mget strlen getrange exists type ttl pttl keys scan dbsize info hget hgetall hkeys hvals hlen hexists hmget hscan lrange llen lindex smembers scard sismember sscan zrange zrevrange zrangebyscore zcard zscore zrank zscan xrange xrevrange xlen ping memory object".split(" "),
);

export function splitRedisCommand(input: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of input.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
  return out;
}

export interface QueryOptions {
  /** Which database service, when the project has several. */
  service?: string;
  /** SQL, or a Redis command. Leave out to list the tables (or keys). */
  query?: string;
  source?: string;
}

export async function queryDatabase(project: Pick<Project, "name" | "dir">, options: QueryOptions = {}): Promise<DbResult> {
  const dbs = findDatabases(project);
  if (!dbs.length) throw new Error(`${project.name} has no Postgres, MySQL or Redis in a docker-compose file.`);
  const db = options.service ? dbs.find((d) => d.service === options.service) : dbs[0];
  if (!db) throw new Error(`No database service called ${options.service}. ${project.name} has: ${dbs.map((d) => d.service).join(", ")}.`);
  if (!(await running(db))) throw new Error(`The ${db.service} container isn't running. Start the stack first (dx up ${project.name}, or start_dev_server).`);

  const started = Date.now();
  let r: DbResult;
  if (db.kind === "redis") {
    const words = options.query ? splitRedisCommand(options.query) : ["SCAN", "0", "COUNT", "200"];
    if (!REDIS_READS.has(words[0]?.toLowerCase() ?? "")) throw new Error(`${words[0] ?? "That"} isn't a reading Redis command. Allowed: GET, MGET, KEYS, SCAN, HGETALL, LRANGE, SMEMBERS, ZRANGE, TTL, TYPE, INFO, DBSIZE and similar.`);
    const out = await exec(db, ["redis-cli", "--no-raw", ...words]);
    if (!out.ok) throw new Error(firstLine(out.stderr || out.stdout));
    const lines = out.stdout.trimEnd().split(/\r?\n/);
    r = { service: db.service, kind: db.kind, columns: [], rows: [], truncated: lines.length > MAX_ROWS, ms: 0, text: lines.slice(0, MAX_ROWS).join("\n") };
  } else {
    let sql: string;
    if (options.query) {
      const check = checkReadOnly(options.query);
      if ("error" in check) throw new Error(check.error);
      sql = check.sql;
    } else {
      sql =
        db.kind === "postgres"
          ? "SELECT table_schema AS schema, table_name AS table, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2"
          : "SELECT table_name AS `table`, table_rows AS `rows` FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1";
    }
    // The container's own settings say which user and database; the session is read-only.
    const script =
      db.kind === "postgres"
        ? 'PGOPTIONS="-c default_transaction_read_only=on" psql -X -q -A -F "$(printf \'\\t\')" -P footer=off -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"'
        : 'U="${MYSQL_USER:-${MARIADB_USER:-root}}"; P="${MYSQL_PASSWORD:-$MARIADB_PASSWORD}"; if [ -n "${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}" ]; then U=root; P="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; fi; ' +
          'C="$(command -v mysql || command -v mariadb)"; MYSQL_PWD="$P" "$C" -u"$U" --batch -D "${MYSQL_DATABASE:-${MARIADB_DATABASE:-mysql}}"';
    const input = db.kind === "mysql" ? `SET SESSION TRANSACTION READ ONLY;\nSTART TRANSACTION;\n${sql};\nROLLBACK;\n` : `${sql};\n`;
    const out = await exec(db, ["sh", "-c", script], input);
    if (!out.ok) throw new Error(firstLine(out.stderr || out.stdout).replace(/^(psql|ERROR \d+ \([\w]+\) at line \d+):\s*/, ""));
    const lines = out.stdout.replace(/\r/g, "").split("\n").filter((l) => l !== "");
    const columns = (lines.shift() ?? "").split("\t");
    const rows = lines.map((l) => l.split("\t"));
    r = { service: db.service, kind: db.kind, columns, rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS, ms: 0 };
  }
  r.ms = Date.now() - started;
  recordRun("db", true, `${project.name}/${db.service}: ${options.query ? options.query.slice(0, 80) : "tables"}`, options.source ?? "cli", { project: project.name });
  return r;
}

/**
 * Runs SQL that dx built itself (Realistic data's scenes: TRUNCATE and INSERT, or a JSON dump)
 * in the project's Postgres or MySQL container, with its own client and user. Never a statement
 * from a request; the read-only queries above are the way in for those.
 */
export async function runSceneSql(project: Pick<Project, "name" | "dir">, sql: string, options: { service?: string } = {}): Promise<{ db: DbService; stdout: string }> {
  const dbs = findDatabases(project).filter((d) => d.kind !== "redis");
  const db = options.service ? dbs.find((d) => d.service === options.service) : dbs[0];
  if (!db) throw new Error(`${project.name} has no Postgres or MySQL in a docker-compose file.`);
  if (!(await running(db))) throw new Error(`The ${db.service} container isn't running. Start the stack first (dx up ${project.name}).`);
  const script =
    db.kind === "postgres"
      ? 'psql -X -q -At -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"'
      : 'U="${MYSQL_USER:-${MARIADB_USER:-root}}"; P="${MYSQL_PASSWORD:-$MARIADB_PASSWORD}"; if [ -n "${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}" ]; then U=root; P="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; fi; ' +
        'C="$(command -v mysql || command -v mariadb)"; MYSQL_PWD="$P" "$C" -u"$U" --batch --raw -N --default-character-set=utf8mb4 -D "${MYSQL_DATABASE:-${MARIADB_DATABASE:-mysql}}"';
  const out = await exec(db, ["sh", "-c", script], sql);
  if (!out.ok) throw new Error(firstLine(out.stderr || out.stdout).replace(/^(psql|ERROR \d+ \([\w]+\) at line \d+):\s*/, ""));
  return { db, stdout: out.stdout };
}

/** The database container's log since a moment, each line with docker's own timestamp (for counting queries). */
export async function databaseLog(db: DbService, since: string): Promise<string> {
  if (!(await running(db))) throw new Error(`The ${db.service} container isn't running.`);
  const r = await docker(db.composeDir, ["compose", "logs", "--no-color", "--no-log-prefix", "--timestamps", "--since", since, db.service]);
  if (!r.ok) throw new Error(firstLine(r.stderr || r.stdout));
  return r.stdout + r.stderr;
}

/** Whether the database container is up. */
export function databaseRunning(db: DbService): Promise<boolean> {
  return running(db);
}

async function running(db: DbService): Promise<boolean> {
  const r = await docker(db.composeDir, ["compose", "ps", "--status", "running", "--services"]);
  return r.ok && r.stdout.split(/\r?\n/).map((s) => s.trim()).includes(db.service);
}

function exec(db: DbService, command: string[], input?: string) {
  return docker(db.composeDir, ["compose", "exec", "-T", db.service, ...command], input);
}

function docker(cwd: string, args: string[], input?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Arguments as an array: the query reaches the database client on stdin, never a shell here.
    const child = spawn("docker", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on("data", (d: Buffer) => (stdout.length < 8_000_000 ? (stdout += d) : undefined));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: (e as NodeJS.ErrnoException).code === "ENOENT" ? "Docker isn't installed or isn't on PATH." : e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "The query failed.";
}
