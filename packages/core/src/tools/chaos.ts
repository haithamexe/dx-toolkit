import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dxPath } from "../config.js";
import type { ActivityEvent } from "./activity.js";
import type { LocaleSettings } from "./locale.js";
import { foldPath } from "./mocks.js";

/**
 * Chaos mode: the failures production has, on purpose, before users meet them. While it's on, the
 * proxy breaks some of a project's API calls (never page loads, scripts or dx's own paths) the
 * way real networks and servers do: slow, failing, dropped, logged out, out of order, rate
 * limited, odd data. Seeded, so a run breaks the same calls the same way each time it's replayed.
 *
 * The same file holds the page-side settings that go with it: a fake clock for the page, and the
 * weak-phone setting for the dx browser and page checks. Kept per project under ~/.dx/chaos,
 * readable by this user only.
 */

export type ChaosFault = "slow" | "flaky" | "drop" | "timeout" | "logout" | "reorder" | "ratelimit" | "baddata";
export type ChaosLevel = "wifi" | "deploy" | "blackfriday";

export const CHAOS_FAULTS: Array<{ id: ChaosFault; name: string; about: string }> = [
  { id: "slow", name: "Slow", about: "the answer takes seconds" },
  { id: "flaky", name: "Flaky", about: "a 500 from the server" },
  { id: "drop", name: "Dropped", about: "the connection closes halfway through the answer" },
  { id: "timeout", name: "No answer", about: "nothing comes back until the page gives up" },
  { id: "logout", name: "Logged out", about: "a 401 halfway through, as when a session expires" },
  { id: "reorder", name: "Out of order", about: "an answer arrives after the call that came next" },
  { id: "ratelimit", name: "Rate limited", about: "a 429 with Retry-After" },
  { id: "baddata", name: "Odd data", about: "a field comes back null, empty or 10,000 characters long" },
];

interface LevelSpec {
  name: string;
  about: string;
  odds: Partial<Record<ChaosFault, number>>;
  slowMs: [number, number];
}

export const CHAOS_LEVELS: Record<ChaosLevel, LevelSpec> = {
  wifi: { name: "Bad Wi-Fi", about: "slow and patchy: delays, dropped answers, answers out of order", odds: { slow: 0.35, drop: 0.05, reorder: 0.1, timeout: 0.02 }, slowMs: [1500, 4000] },
  deploy: { name: "Monday deploy", about: "the server misbehaves: 500s, odd data, a logout, the odd 429", odds: { flaky: 0.1, slow: 0.15, baddata: 0.1, logout: 1, ratelimit: 0.03, drop: 0.02 }, slowMs: [800, 3000] },
  blackfriday: { name: "Black Friday", about: "everything at once, under load: long waits, 429s, 500s, timeouts", odds: { slow: 0.4, ratelimit: 0.15, flaky: 0.1, timeout: 0.03, drop: 0.04, reorder: 0.12, baddata: 0.05, logout: 1 }, slowMs: [3000, 8000] },
};

export interface FakeClock {
  /** The time the page starts at (ISO); it runs on from there unless frozen. */
  at?: string;
  frozen?: boolean;
  /** An IANA time zone the page sees, e.g. "Pacific/Auckland". */
  timeZone?: string;
}

export interface ChaosConfig {
  format: "dx-chaos";
  version: 1;
  dir: string;
  project: string;
  /** Chaos mode on the proxy. */
  on: boolean;
  level: ChaosLevel;
  /** Which faults this run may use; all of the level's when empty. */
  faults: ChaosFault[];
  seed: number;
  /** When this run started: the report covers the history from here. */
  startedAt?: string;
  /** Only calls whose path matches (a rule pattern, `*` and `**`); all API calls when empty. */
  paths?: string;
  /** The page's clock, through the recorder script (and DevTools in the dx browser and checks). */
  clock?: FakeClock;
  /** The dx browser and page checks as a cheap phone on a weak connection. */
  phone?: boolean;
  /** Longer, accented text and right to left in the page, through the recorder script. */
  locale?: LocaleSettings;
  updatedAt: string;
}

function norm(p: string): string {
  const r = path.resolve(p);
  return process.platform === "linux" ? r : r.toLowerCase();
}

export function chaosFile(dir: string): string {
  const name = path.basename(dir).replace(/[^\w.-]+/g, "-").slice(0, 40) || "project";
  return dxPath("chaos", `${name}-${crypto.createHash("sha1").update(norm(dir)).digest("hex").slice(0, 8)}.json`);
}

export function newSeed(): number {
  return 1000 + crypto.randomInt(9000);
}

export function loadChaos(dir: string, project = path.basename(dir)): ChaosConfig {
  // Until it's saved, the seed shown is the one the first run uses: the same for the same folder.
  const seed = 1000 + (crypto.createHash("sha1").update(norm(dir)).digest().readUInt32BE(0) % 9000);
  const empty: ChaosConfig = { format: "dx-chaos", version: 1, dir: path.resolve(dir), project, on: false, level: "wifi", faults: [], seed, updatedAt: new Date().toISOString() };
  try {
    const raw = JSON.parse(fs.readFileSync(chaosFile(dir), "utf8")) as Partial<ChaosConfig>;
    if (raw?.format !== "dx-chaos") return empty;
    return { ...empty, ...cleanChaos(raw), dir: empty.dir, project: raw.project ?? project, startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined, updatedAt: raw.updatedAt ?? empty.updatedAt };
  } catch {
    return empty;
  }
}

export function saveChaos(c: ChaosConfig): ChaosConfig {
  const file = chaosFile(c.dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  c.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return c;
}

export class ChaosError extends Error {
  status = 400;
}

const TIME_ZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/;

/** Known fields of the right shape only; throws on a value that can't be used. */
export function cleanChaos(input: Partial<Record<keyof ChaosConfig, unknown>>): Partial<ChaosConfig> {
  const out: Partial<ChaosConfig> = {};
  if (input.on !== undefined) out.on = input.on === true;
  if (input.level !== undefined) {
    if (typeof input.level !== "string" || !(input.level in CHAOS_LEVELS)) throw new ChaosError(`level is one of ${Object.keys(CHAOS_LEVELS).join(", ")}.`);
    out.level = input.level as ChaosLevel;
  }
  if (input.faults !== undefined) {
    if (!Array.isArray(input.faults)) throw new ChaosError("faults is a list.");
    const known = new Set(CHAOS_FAULTS.map((f) => f.id));
    out.faults = [...new Set(input.faults.filter((f): f is ChaosFault => typeof f === "string" && known.has(f as ChaosFault)))];
  }
  if (input.seed !== undefined) {
    const n = Number(input.seed);
    if (!Number.isInteger(n) || n < 0 || n > 2 ** 31) throw new ChaosError("seed is a whole number.");
    out.seed = n;
  }
  if (input.paths !== undefined) {
    if (typeof input.paths !== "string" || input.paths.length > 300 || /[\r\n]/.test(input.paths)) throw new ChaosError("paths is a path pattern like /api/**.");
    out.paths = input.paths.trim() || undefined;
  }
  if (input.phone !== undefined) out.phone = input.phone === true;
  if (input.locale !== undefined) {
    if (input.locale === null || input.locale === false) out.locale = undefined;
    else if (typeof input.locale === "object") {
      const l = input.locale as Record<string, unknown>;
      const locale: LocaleSettings = {};
      if (l.pseudo === true) locale.pseudo = true;
      if (l.rtl === true) locale.rtl = true;
      out.locale = locale.pseudo || locale.rtl ? locale : undefined;
    } else throw new ChaosError("locale is { pseudo, rtl }.");
  }
  if (input.clock !== undefined) {
    if (input.clock === null || input.clock === false) out.clock = undefined;
    else if (typeof input.clock === "object") {
      const c = input.clock as Record<string, unknown>;
      const clock: FakeClock = {};
      if (c.at !== undefined && c.at !== "") {
        // A time without an offset is the wall-clock time in the chosen zone (else this computer's).
        const raw = String(c.at);
        const zone = typeof c.timeZone === "string" && TIME_ZONE.test(c.timeZone) && validZone(c.timeZone) ? c.timeZone : undefined;
        const t = zone && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(raw) ? zonedTime(raw, zone) : Date.parse(raw);
        if (!Number.isFinite(t) || t < Date.UTC(1971, 0, 1) || t > Date.UTC(2200, 0, 1)) throw new ChaosError("The clock's time must be a date between 1971 and 2200.");
        clock.at = new Date(t).toISOString();
      }
      if (c.frozen === true) clock.frozen = true;
      if (c.timeZone !== undefined && c.timeZone !== "") {
        const tz = String(c.timeZone);
        if (!TIME_ZONE.test(tz) || !validZone(tz)) throw new ChaosError(`${tz.slice(0, 60)} isn't a time zone. Use a name like Europe/Berlin or America/New_York.`);
        clock.timeZone = tz;
      }
      out.clock = clock.at || clock.timeZone ? clock : undefined;
    } else throw new ChaosError("clock is { at, frozen, timeZone }.");
  }
  return out;
}

/** How far ahead of UTC a zone is at a moment, in ms. */
function zoneOffset(ms: number, tz: string): number {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

/** "2026-12-31T23:59:50" on the clocks of a time zone, as a moment. */
export function zonedTime(wall: string, tz: string): number {
  const [d, t = "00:00:00"] = wall.split("T");
  const [y, mo, day] = d.split("-").map(Number);
  const [h, mi, s = "0"] = t.split(":");
  const guess = Date.UTC(y, mo - 1, day, Number(h), Number(mi), Math.floor(Number(s)));
  // Twice, for a moment near a daylight-saving change.
  const first = guess - zoneOffset(guess, tz);
  return guess - zoneOffset(first, tz);
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Changes the project's chaos settings. Turning it on (or a new seed or level while on) starts a
 * new run: its report begins here and the proxy counts calls from zero.
 */
export function setChaos(dir: string, project: string, patch: Partial<Record<keyof ChaosConfig | "restart", unknown>>): ChaosConfig {
  const c = loadChaos(dir, project);
  const p = cleanChaos(patch);
  const wasOn = c.on;
  Object.assign(c, p);
  if ("clock" in p) c.clock = p.clock;
  if ("locale" in p) c.locale = p.locale;
  if (c.on && (!wasOn || p.seed !== undefined || p.level !== undefined || p.faults !== undefined || patch.restart === true)) c.startedAt = new Date().toISOString();
  if (!c.on && wasOn) c.startedAt ??= new Date().toISOString();
  return saveChaos(c);
}

// ------------------------------------------------------------------ deciding a call

/** A number from 0 to 1, the same every time for the same words. */
export function chance(...parts: Array<string | number>): number {
  const h = crypto.createHash("sha256").update(parts.join("\u0000")).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

export interface ChaosCall {
  method: string;
  path: string;
  /** The n-th call to this method and folded path in this run, from 0. */
  n: number;
  /** The n-th API call of any kind in this run, from 0. */
  index: number;
  /** The call carries a session: an Authorization header or a cookie. */
  signedIn: boolean;
}

export interface ChaosDecision {
  fault: ChaosFault;
  /** slow: how long to wait first. */
  delayMs?: number;
  /** For the history: "chaos: slow 3.2 s". */
  label: string;
  /** What makes this call's breakage repeat: the seed, the call and its count. */
  salt: string;
}

/** The faults this run may use, with their odds. */
export function chaosOdds(c: Pick<ChaosConfig, "level" | "faults">): Partial<Record<ChaosFault, number>> {
  const spec = CHAOS_LEVELS[c.level] ?? CHAOS_LEVELS.wifi;
  if (!c.faults.length) return spec.odds;
  const out: Partial<Record<ChaosFault, number>> = {};
  for (const f of c.faults) out[f] = spec.odds[f] ?? (f === "logout" ? 1 : f === "slow" ? 0.3 : 0.08);
  return out;
}

/** The call at which the session "expires" in this run, and how many signed-in calls get a 401 then. */
export function logoutWindow(seed: number): { from: number; count: number } {
  return { from: 4 + Math.floor(chance(seed, "logout") * 12), count: 3 };
}

/**
 * What happens to one call: nothing (undefined) or one fault. Decided only by the seed, the call's
 * method and folded path and how many such calls came before it, so the same run breaks the same
 * calls the same way.
 */
export function decideChaos(c: Pick<ChaosConfig, "level" | "faults" | "seed">, call: ChaosCall): ChaosDecision | undefined {
  const odds = chaosOdds(c);
  const spec = CHAOS_LEVELS[c.level] ?? CHAOS_LEVELS.wifi;
  if (odds.logout && call.signedIn) {
    const w = logoutWindow(c.seed);
    if (call.index >= w.from && call.index < w.from + w.count) return { fault: "logout", label: "chaos: logged out (401)", salt: `${c.seed}|logout|${call.index}` };
  }
  const key = `${call.method} ${foldPath(call.path.split("?")[0])}`;
  const r = chance(c.seed, key, call.n);
  let acc = 0;
  for (const f of ["timeout", "drop", "flaky", "ratelimit", "baddata", "reorder", "slow"] as ChaosFault[]) {
    const p = f === "logout" ? 0 : (odds[f] ?? 0);
    if (!p) continue;
    acc += p;
    if (r < acc) {
      if (f === "slow") {
        const [lo, hi] = spec.slowMs;
        const ms = Math.round(lo + chance(c.seed, key, call.n, "ms") * (hi - lo));
        return { fault: f, delayMs: ms, label: `chaos: slow ${(ms / 1000).toFixed(1)} s`, salt: `${c.seed}|${key}|${call.n}` };
      }
      const label = { timeout: "no answer", drop: "dropped", flaky: "500", ratelimit: "rate limited (429)", baddata: "odd data", reorder: "out of order" }[f as Exclude<ChaosFault, "slow" | "logout">];
      return { fault: f, label: `chaos: ${label}`, salt: `${c.seed}|${key}|${call.n}` };
    }
  }
  return undefined;
}

/** A JSON answer with one field broken: null, an empty list, a huge string or a negative number. Undefined when it isn't JSON with fields. */
export function breakJson(text: string, seed: number, key: string): { text: string; note: string } | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const spots: Array<{ path: string; holder: Record<string, unknown> | unknown[]; key: string | number; value: unknown }> = [];
  const walk = (v: unknown, p: string, depth: number) => {
    if (spots.length > 400 || depth > 6 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.slice(0, 3).forEach((x, i) => {
        spots.push({ path: `${p}${p ? "." : ""}${i}`, holder: v, key: i, value: x });
        walk(x, `${p}${p ? "." : ""}${i}`, depth + 1);
      });
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      spots.push({ path: `${p}${p ? "." : ""}${k}`, holder: v as Record<string, unknown>, key: k, value: x });
      walk(x, `${p}${p ? "." : ""}${k}`, depth + 1);
    }
  };
  walk(doc, "", 0);
  if (!spots.length) return undefined;
  // Leaves (and lists) first: a page reads those.
  const leaves = spots.filter((s) => s.value === null || typeof s.value !== "object" || Array.isArray(s.value));
  const pool = leaves.length ? leaves : spots;
  const spot = pool[Math.floor(chance(seed, key, "spot") * pool.length)];
  const v = spot.value;
  const r = chance(seed, key, "how");
  let next: unknown;
  let what: string;
  if (Array.isArray(v)) [next, what] = r < 0.6 ? [[], "an empty list"] : [null, "null"];
  else if (typeof v === "string") [next, what] = r < 0.5 ? ["x".repeat(10_000), "a 10,000-character string"] : r < 0.8 ? [null, "null"] : ["", "an empty string"];
  else if (typeof v === "number") [next, what] = r < 0.5 ? [null, "null"] : [-1, "-1"];
  else if (typeof v === "boolean") [next, what] = [null, "null"];
  else [next, what] = [null, "null"];
  if (Array.isArray(spot.holder)) spot.holder[spot.key as number] = next;
  else spot.holder[spot.key as string] = next;
  return { text: JSON.stringify(doc), note: `${spot.path || "the answer"} became ${what}` };
}

// ------------------------------------------------------------------ the report

export interface ChaosFinding {
  kind: "blank" | "uncaught" | "stuck" | "double" | "server";
  title: string;
  detail?: string;
  at: string;
  visit?: string;
  page?: string;
  /** The event to open in the history. */
  id: number;
  /** The chaos that hit this visit before it, as labels. */
  after?: string[];
}

export interface ChaosReport {
  since?: string;
  calls: number;
  broken: number;
  byFault: Record<string, number>;
  findings: ChaosFinding[];
  visits: number;
}

/**
 * What the run did to the app, from the project's history since the run started: pages that went
 * blank, errors nothing caught, loading indicators that never stopped, the same order sent twice,
 * and the server's own errors. Each with the chaos that hit the visit before it.
 */
export function chaosReport(events: ActivityEvent[], since?: string): ChaosReport {
  const from = since ? Date.parse(since) : 0;
  const list = events.filter((e) => Date.parse(e.at) >= from).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
  const report: ChaosReport = { since, calls: 0, broken: 0, byFault: {}, findings: [], visits: new Set(list.map((e) => e.visit).filter(Boolean)).size };
  const hitsByVisit = new Map<string, string[]>();
  const recentHits: Array<{ at: number; label: string }> = [];
  const lastWrite = new Map<string, ActivityEvent>();
  const seen = new Set<string>();
  const add = (f: ChaosFinding, dedupe: string) => {
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    if (report.findings.length < 200) report.findings.push(f);
  };
  for (const e of list) {
    const t = Date.parse(e.at);
    if (e.type === "request") {
      report.calls++;
      const chaos = (e.rules ?? []).filter((r) => r.startsWith("chaos: "));
      if (chaos.length) {
        report.broken++;
        for (const c of chaos) {
          // "chaos: odd data: price became null" and "chaos: slow 2.1 s" count as "odd data" and "slow".
          const fault = c.replace(/^chaos: /, "").split(": ")[0].replace(/ [\d.]+ s$/, "");
          report.byFault[fault] = (report.byFault[fault] ?? 0) + 1;
          recentHits.push({ at: t, label: `${c.replace(/^chaos: /, "")} on ${e.method ?? "GET"} ${foldPath((e.url ?? "").replace(/^https?:\/\/[^/]+/, "").split("?")[0])}` });
          if (e.visit) hitsByVisit.set(e.visit, [...(hitsByVisit.get(e.visit) ?? []), recentHits.at(-1)!.label]);
        }
      }
      // The same write sent twice within 3 seconds: a button that doesn't stop a second click.
      if (e.method && !["GET", "HEAD", "OPTIONS"].includes(e.method)) {
        const p = (e.url ?? "").replace(/^https?:\/\/[^/]+/, "");
        const k = `${e.visit ?? ""} ${e.method} ${p} ${e.requestBody ?? ""}`;
        const prev = lastWrite.get(k);
        if (prev && t - Date.parse(prev.at) < 3000) {
          add({ kind: "double", title: `${e.method} ${p.split("?")[0]} was sent twice`, detail: "Two identical calls within 3 s: the button or form doesn't stop a second click while the first is on its way.", at: e.at, visit: e.visit, page: e.page, id: e.id }, `double ${e.visit} ${e.method} ${p}`);
        }
        lastWrite.set(k, e);
      }
      continue;
    }
    const after = () => (e.visit && hitsByVisit.get(e.visit)?.slice(-4)) || recentHits.filter((h) => h.at <= t && t - h.at < 15_000).slice(-4).map((h) => h.label);
    if (e.type === "error" && e.problem === "blank") {
      add({ kind: "blank", title: "The page went blank", detail: e.text, at: e.at, visit: e.visit, page: e.page, id: e.id, after: after() }, `blank ${e.visit ?? e.id} ${e.page}`);
    } else if (e.type === "error" && e.problem === "stuck") {
      add({ kind: "stuck", title: "A loading indicator never stopped", detail: e.text, at: e.at, visit: e.visit, page: e.page, id: e.id, after: after() }, `stuck ${e.page} ${e.text}`);
    } else if (e.type === "error" && e.from !== "server") {
      const msg = e.text.replace(/\d+/g, "#").slice(0, 200);
      add({ kind: "uncaught", title: e.text.split("\n")[0].slice(0, 200), detail: e.source, at: e.at, visit: e.visit, page: e.page, id: e.id, after: after() }, `uncaught ${msg}`);
    } else if (e.type === "server-error") {
      add({ kind: "server", title: e.text.split("\n")[0].slice(0, 200), at: e.at, id: e.id, after: after() }, `server ${e.text.replace(/\d+/g, "#").slice(0, 200)}`);
    }
  }
  return report;
}
