import fs from "node:fs";
import path from "node:path";
import { dxPath, ensureDxHome } from "../config.js";
import type { ActivityEvent } from "./activity.js";
import { databaseLog, findDatabases, runSceneSql, type DbKind, type DbService } from "./db.js";
import { foldPath } from "./mocks.js";
import type { Project } from "./projects.js";

/**
 * Queries per request: the project's development database (the Postgres or MySQL its
 * docker-compose runs) logs every statement while this is on, and each one is matched to the
 * request that was being answered at that moment (from the activity history). A page that runs
 * 40 nearly identical queries (the "N+1" problem) or a query that takes 300 ms shows up next to
 * the request that caused it. Nothing changes in the code: the database's own logging is switched
 * on (Postgres `log_min_duration_statement = 0`, MySQL's slow log to a table with a 0 s threshold)
 * and back off.
 *
 * Statements are never kept with their values: literals become `?` as they're read, so an email
 * or a password hash in a WHERE clause never reaches dx's records.
 */

export interface DbQuery {
  /** When it ran, ms since 1970. */
  at: number;
  ms: number;
  /** The statement with every value replaced by ?. */
  shape: string;
  /** The database connection it ran on (Postgres' process id, MySQL's thread id). */
  conn?: string;
}

export interface QueryGroup {
  shape: string;
  count: number;
  ms: number;
}

export interface RequestQueries {
  /** The activity event's id. */
  id: number;
  at: string;
  method: string;
  /** "/api/orders/:id". */
  path: string;
  status?: number;
  /** How long the request took. */
  ms?: number;
  queries: number;
  /** Time spent in the database. */
  dbMs: number;
  groups: QueryGroup[];
  /** The same statement (values aside) run this many times or more: N+1. */
  repeated?: QueryGroup;
  slowest?: QueryGroup;
}

export type QueryFindingKind = "n+1" | "slow" | "many";

export interface QueryFinding {
  kind: QueryFindingKind;
  /** "GET /api/orders runs the same query 40 times". */
  text: string;
  /** "GET /api/orders" (folded path). */
  request: string;
  shape?: string;
  count: number;
  ms: number;
  /** An example request's activity id. */
  id: number;
}

export interface QueryReport {
  project: string;
  service?: string;
  kind?: DbKind;
  on: boolean;
  since?: string;
  /** Statements read from the log. */
  queries: number;
  /** Statements that ran while no request was being answered (startup, background jobs). */
  outside: number;
  requests: RequestQueries[];
  findings: QueryFinding[];
  /** The statements taking the most time in all. */
  top: QueryGroup[];
  /** Why there's nothing to show, when there isn't. */
  note?: string;
}

/** Thresholds: the same statement this many times in one request is N+1; this slow is slow; this many in one request is many. */
export const QUERY_LIMITS = { repeat: 10, slowMs: 200, many: 50 };

interface LogState {
  service: string;
  kind: DbKind;
  since: string;
}

function stateFile(): string {
  return dxPath("querylog.json");
}

function key(dir: string): string {
  const r = path.resolve(dir);
  return process.platform === "linux" ? r : r.toLowerCase();
}

function readState(): Record<string, LogState> {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as Record<string, LogState>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeState(s: Record<string, LogState>): void {
  ensureDxHome();
  const tmp = `${stateFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, stateFile());
}

/** Whether queries are being logged for the project, and since when. */
export function queryLogState(dir: string): LogState | undefined {
  return readState()[key(dir)];
}

function pickDb(project: Pick<Project, "name" | "dir">, service?: string): DbService {
  const dbs = findDatabases(project).filter((d) => d.kind !== "redis");
  const db = service ? dbs.find((d) => d.service === service) : dbs[0];
  if (!db) throw new Error(`${project.name} has no Postgres or MySQL in a docker-compose file, so dx can't see its queries.`);
  return db;
}

/**
 * Switches the database's statement logging on or off. dx's own fixed SQL, run with the
 * container's client as its own user (Postgres' is a superuser; MySQL needs the root password the
 * container was set up with).
 */
export async function setQueryLog(project: Pick<Project, "name" | "dir">, on: boolean, options: { service?: string } = {}): Promise<LogState | undefined> {
  const state = readState();
  const k = key(project.dir);
  const db = pickDb(project, options.service ?? state[k]?.service);
  const sql =
    db.kind === "postgres"
      ? on
        ? "ALTER SYSTEM SET log_min_duration_statement = 0;\nSELECT pg_reload_conf();\n"
        : "ALTER SYSTEM RESET log_min_duration_statement;\nSELECT pg_reload_conf();\n"
      : on
        ? "SET GLOBAL log_output = 'TABLE';\nSET GLOBAL long_query_time = 0;\nSET GLOBAL slow_query_log = 1;\n"
        : "SET GLOBAL slow_query_log = 0;\nSET GLOBAL long_query_time = 10;\n";
  try {
    await runSceneSql(project, sql, { service: db.service });
  } catch (err) {
    const m = (err as Error).message;
    if (/permission|denied|SUPER|privilege/i.test(m)) throw new Error(`The database user can't change logging (${m}). For MySQL, dx needs the root password the container was set up with (MYSQL_ROOT_PASSWORD).`);
    throw err;
  }
  if (on) state[k] = { service: db.service, kind: db.kind, since: new Date().toISOString() };
  else delete state[k];
  writeState(state);
  return state[k];
}

// ------------------------------------------------------------------ reading

/** A statement with its values taken out: strings, numbers, $1 parameters and IN lists become ?. */
export function shapeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^'\\]|''|\\.)*'/g, "?")
    .replace(/\bE\?/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/(?<![\w"`.])-?\d+(\.\d+)?(e[+-]?\d+)?\b/gi, "?")
    .replace(/\b(true|false|null)\b/gi, "?")
    .replace(/\(\s*\?(\s*,\s*\?)+\s*\)/g, "(?…)")
    .replace(/\bVALUES\s*\(\?…\)(\s*,\s*\(\?…\))+/gi, "VALUES (?…)…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

const PG_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s(.*)$/;
const PG_STATEMENT = /\bLOG:\s+duration:\s+([\d.]+)\s+ms\s+(statement|execute [^:]*):\s?(.*)$/;
const SKIP_SQL = /^(BEGIN|COMMIT|ROLLBACK|SET |SHOW |SAVEPOINT|RELEASE|DEALLOCATE|DISCARD|SELECT pg_reload_conf|ALTER SYSTEM|select version\(\)|SELECT 1$)/i;

/** Statements from `docker compose logs --timestamps` of a Postgres container (simple and extended protocol). */
export function parsePostgresLog(text: string): DbQuery[] {
  const out: DbQuery[] = [];
  let open: { at: number; ms: number; sql: string; conn?: string } | undefined;
  const close = () => {
    if (open && !SKIP_SQL.test(open.sql.trim())) out.push({ at: open.at, ms: open.ms, shape: shapeSql(open.sql), ...(open.conn ? { conn: open.conn } : {}) });
    open = undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    const m = PG_LINE.exec(raw);
    if (!m) continue;
    const [, stamp, rest] = m;
    const s = PG_STATEMENT.exec(rest);
    if (s) {
      close();
      // The log's time is when it finished; it started `ms` earlier.
      open = { at: Date.parse(stamp) - Number(s[1]), ms: Number(s[1]), sql: s[3], conn: /\[(\d+)\]/.exec(rest)?.[1] };
      continue;
    }
    // A statement on several lines continues with a tab; anything else (DETAIL with the values, other messages) ends it.
    if (open && /^\t/.test(rest)) open.sql += ` ${rest.trim()}`;
    else close();
  }
  close();
  return out;
}

/** Rows of MySQL's slow log table read as tab-separated "unix time, seconds, thread, statement". */
export function parseMysqlSlowLog(text: string): DbQuery[] {
  const out: DbQuery[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [t, secs, thread, ...sql] = line.split("\t");
    const at = Number(t) * 1000;
    const ms = Number(secs) * 1000;
    const statement = sql.join(" ").trim();
    if (!Number.isFinite(at) || !statement || SKIP_SQL.test(statement) || /slow_log|long_query_time|slow_query_log|log_output/i.test(statement)) continue;
    out.push({ at: at - ms, ms, shape: shapeSql(statement), ...(/^\d+$/.test(thread ?? "") ? { conn: thread } : {}) });
  }
  return out;
}

/** The statements the database ran since `since`. */
export async function readQueries(project: Pick<Project, "name" | "dir">, since: string, service?: string): Promise<{ db: DbService; queries: DbQuery[] }> {
  const db = pickDb(project, service);
  if (db.kind === "postgres") return { db, queries: parsePostgresLog(await databaseLog(db, since)) };
  const from = (Date.parse(since) / 1000).toFixed(3);
  const sql = `SELECT UNIX_TIMESTAMP(start_time), TIME_TO_SEC(query_time) + MICROSECOND(query_time) / 1000000, thread_id, REPLACE(REPLACE(REPLACE(CONVERT(sql_text USING utf8mb4), CHAR(10), ' '), CHAR(13), ' '), CHAR(9), ' ') FROM mysql.slow_log WHERE start_time >= FROM_UNIXTIME(${from}) ORDER BY start_time LIMIT 100000;\n`;
  const r = await runSceneSql(project, sql, { service: db.service });
  return { db, queries: parseMysqlSlowLog(r.stdout) };
}

const pathOf = (url: string) => {
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return url.split("?")[0];
  }
};

/**
 * Each statement goes to the request that was being answered while it ran: it started after the
 * request did and finished before its answer (with a little slack for the two clocks). A page
 * often sends several calls at once; of the requests that hold a statement, the tightest one
 * wins (a 300 ms report call doesn't take the 40 queries of a 20 ms list call that ran inside it).
 *
 * Statements run back to back on one connection (under 25 ms apart) go together: an N+1 loop is
 * one request's. The database's clock (in Docker's VM) can be a few ms off this computer's, so a
 * run that no request holds whole goes to the one it overlaps most.
 */
export function attributeQueries(events: ActivityEvent[], queries: DbQuery[], slackMs = 30): { requests: RequestQueries[]; outside: number } {
  const reqs = events
    .filter((e) => (e.type === "request" || e.type === "page") && e.url && !e.mocked && typeof e.ms === "number")
    .map((e) => ({ e, start: Date.parse(e.at), end: Date.parse(e.at) + (e.ms ?? 0), hits: [] as DbQuery[] }))
    .sort((a, b) => a.start - b.start);
  // Runs: statements on one connection, each starting within 25 ms of the one before ending.
  type Run = { start: number; end: number; qs: DbQuery[] };
  const runs: Run[] = [];
  const open = new Map<string, Run>();
  [...queries]
    .sort((a, b) => a.at - b.at)
    .forEach((q, i) => {
      const key = q.conn ?? `#${i}`;
      const run = open.get(key);
      if (run && q.at - run.end <= 25) {
        run.qs.push(q);
        run.end = Math.max(run.end, q.at + q.ms);
      } else {
        const fresh = { start: q.at, end: q.at + q.ms, qs: [q] };
        runs.push(fresh);
        open.set(key, fresh);
      }
    });
  let outside = 0;
  for (const run of runs) {
    let held: (typeof reqs)[number] | undefined;
    let most: (typeof reqs)[number] | undefined;
    let mostOverlap = 0;
    let heldOverlap = -1;
    for (const r of reqs) {
      if (r.start - slackMs > run.end) break;
      const span = r.end - r.start;
      const overlap = Math.min(run.end, r.end) - Math.max(run.start, r.start);
      if (run.start >= r.start - slackMs && run.end <= r.end + slackMs) {
        // Of the requests that hold it, the one it overlaps most (the slack can make a 1 ms page
        // load "hold" a loop that ran just after it), then the tightest, then the latest.
        const o = Math.max(0, overlap);
        const better = !held || o > heldOverlap || (o === heldOverlap && (span < held.end - held.start || (span === held.end - held.start && r.start > held.start)));
        if (better) {
          held = r;
          heldOverlap = o;
        }
      }
      if (overlap > mostOverlap) {
        mostOverlap = overlap;
        most = r;
      }
    }
    const best = held ?? most;
    if (best) best.hits.push(...run.qs);
    else outside += run.qs.length;
  }
  const requests: RequestQueries[] = [];
  for (const r of reqs) {
    if (!r.hits.length) continue;
    const groups = new Map<string, QueryGroup>();
    for (const q of r.hits) {
      const g = groups.get(q.shape) ?? { shape: q.shape, count: 0, ms: 0 };
      g.count++;
      g.ms += q.ms;
      groups.set(q.shape, g);
    }
    const list = [...groups.values()].sort((a, b) => b.count - a.count || b.ms - a.ms);
    const slowest = r.hits.reduce((m, q) => (q.ms > m.ms ? q : m), r.hits[0]);
    requests.push({
      id: r.e.id,
      at: r.e.at,
      method: (r.e.method ?? "GET").toUpperCase(),
      path: foldPath(pathOf(r.e.url!)),
      status: r.e.status,
      ms: r.e.ms,
      queries: r.hits.length,
      dbMs: Math.round(r.hits.reduce((n, q) => n + q.ms, 0) * 10) / 10,
      groups: list.slice(0, 30),
      ...(list[0].count >= QUERY_LIMITS.repeat ? { repeated: list[0] } : {}),
      slowest: { shape: slowest.shape, count: 1, ms: slowest.ms },
    });
  }
  return { requests, outside };
}

/** What's worth fixing: N+1, slow statements, requests with very many queries; one finding per request kind. */
export function queryFindings(requests: RequestQueries[]): QueryFinding[] {
  const out = new Map<string, QueryFinding>();
  const add = (k: string, f: QueryFinding) => {
    const had = out.get(k);
    if (!had || f.count > had.count || f.ms > had.ms) out.set(k, f);
  };
  for (const r of requests) {
    const req = `${r.method} ${r.path}`;
    if (r.repeated) add(`n+1 ${req} ${r.repeated.shape}`, { kind: "n+1", text: `${req} runs the same query ${r.repeated.count} times`, request: req, shape: r.repeated.shape, count: r.repeated.count, ms: r.repeated.ms, id: r.id });
    if (r.slowest && r.slowest.ms >= QUERY_LIMITS.slowMs) add(`slow ${r.slowest.shape}`, { kind: "slow", text: `A query took ${Math.round(r.slowest.ms)} ms in ${req}`, request: req, shape: r.slowest.shape, count: 1, ms: r.slowest.ms, id: r.id });
    if (r.queries >= QUERY_LIMITS.many && !r.repeated) add(`many ${req}`, { kind: "many", text: `${req} runs ${r.queries} queries`, request: req, count: r.queries, ms: r.dbMs, id: r.id });
  }
  const order: Record<QueryFindingKind, number> = { "n+1": 0, slow: 1, many: 2 };
  return [...out.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.count - a.count || b.ms - a.ms);
}

/**
 * The events still going on once logging was on: a request that started a moment before it was
 * switched on can have run every statement after (it ends, start plus its time, at or after `since`).
 */
export function eventsSince(events: ActivityEvent[], since: string): ActivityEvent[] {
  const from = Date.parse(since);
  return events.filter((e) => Date.parse(e.at) + (typeof e.ms === "number" ? e.ms : 0) >= from);
}

/** The report for the history since logging was switched on (or `since`). */
export async function queryReport(project: Pick<Project, "name" | "dir">, events: ActivityEvent[], options: { since?: string; service?: string } = {}): Promise<QueryReport> {
  const state = queryLogState(project.dir);
  const base: QueryReport = { project: project.name, on: !!state, service: state?.service, kind: state?.kind, since: state?.since, queries: 0, outside: 0, requests: [], findings: [], top: [] };
  const since = options.since ?? state?.since;
  if (!since) return { ...base, note: "Queries aren't being logged. Switch it on, use the app, then look again." };
  const { db, queries } = await readQueries(project, since, options.service ?? state?.service);
  const { requests, outside } = attributeQueries(eventsSince(events, since), queries);
  const all = new Map<string, QueryGroup>();
  for (const q of queries) {
    const g = all.get(q.shape) ?? { shape: q.shape, count: 0, ms: 0 };
    g.count++;
    g.ms += q.ms;
    all.set(q.shape, g);
  }
  return {
    ...base,
    service: db.service,
    kind: db.kind,
    since,
    queries: queries.length,
    outside,
    requests: requests.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300),
    findings: queryFindings(requests),
    top: [...all.values()].sort((a, b) => b.ms - a.ms).slice(0, 15),
    note: queries.length ? undefined : "No queries logged yet: use the app through dx, then look again.",
  };
}
