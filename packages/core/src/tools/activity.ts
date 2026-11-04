import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dxPath } from "../config.js";

/**
 * The activity history: what happened in an app while you used it, in order. Requests with their
 * payloads and responses (from the local domains proxy), pages and route changes, clicks and form
 * submits, console output and errors (from a small script the proxy adds to the app's pages), and
 * the dev server starting, stopping and failing.
 *
 * It's written by the dashboard, one JSON line per event, to ~/.dx/activity/<project>/<day>.jsonl,
 * readable by this user only, and kept for `activityDays` (default 7). Credentials are masked
 * before anything is written; typed values are never recorded.
 */

export type ActivityType =
  /** An API call: method, address, status, time, bodies. */
  | "request"
  /** A page the browser loaded. */
  | "page"
  /** A front-end route change without a page load (pushState, back, a #hash). */
  | "route"
  /** A click on a button, link or other control, or a form submitted. */
  | "action"
  /** console.log, info, warn, error, debug in the page. */
  | "console"
  /** An uncaught exception, an unhandled rejection, a script or image that didn't load. */
  | "error"
  /** The dev server starting, getting ready, stopping or exiting. */
  | "server"
  /** An error the dev server printed: a build error, a stack trace. */
  | "server-error";

export const ACTIVITY_TYPES: ActivityType[] = ["request", "page", "route", "action", "console", "error", "server", "server-error"];

export interface ActivityEvent {
  /** Increasing: later events have larger ids, also across restarts. */
  id: number;
  at: string;
  dir: string;
  project: string;
  service?: string;
  type: ActivityType;
  /** One line: "POST /api/cart → 500", "Clicked button “Add to cart”", "/cart → /checkout". */
  text: string;
  /** console: the level. Others: "error" or "warn" when something went wrong. */
  level?: "log" | "info" | "warn" | "error" | "debug";
  /** The page the browser was on. */
  page?: string;
  /** For requests: the address asked for. */
  url?: string;
  method?: string;
  status?: number;
  ms?: number;
  /** Why a request got no answer. */
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  /** A body was longer than what's kept. */
  truncated?: boolean;
  /** file:line:column where it happened. */
  source?: string;
  stack?: string;
  /** Where it was seen: the proxy, the page itself, the dev server, or a headless page check. */
  from: "proxy" | "browser" | "server" | "check";
  /** One page load in one tab, so the events of a visit can be told apart. */
  visit?: string;
}

export interface ActivityQuery {
  /** One project, by folder; every project when left out. */
  dir?: string;
  types?: ActivityType[];
  /** Only what went wrong: failed requests, errors, console errors, server errors. */
  problems?: boolean;
  /** Only events after this id (for following along). */
  after?: number;
  since?: Date;
  until?: Date;
  /** Text to look for in the line, the address, the bodies and the stack (case is ignored). */
  search?: string;
  /** The newest this many (default 200). */
  limit?: number;
}

/** The folder one project's history goes in: its name and a short hash of its path. */
export function activityFolder(dir: string): string {
  const key = process.platform === "linux" ? path.resolve(dir) : path.resolve(dir).toLowerCase();
  const name = path.basename(dir).replace(/[^\w.-]+/g, "-").slice(0, 40) || "project";
  return dxPath("activity", `${name}-${crypto.createHash("sha1").update(key).digest("hex").slice(0, 8)}`);
}

let lastId = 0;
/** A new id: the time in milliseconds × 1000, plus a counter for events in the same millisecond. */
export function nextActivityId(now = Date.now()): number {
  lastId = Math.max(now * 1000, lastId + 1);
  return lastId;
}

/** Appends events to their project's file for the day. */
export function appendActivity(events: ActivityEvent[]): void {
  const files = new Map<string, string[]>();
  for (const e of events) {
    const file = path.join(activityFolder(e.dir), `${localDay(new Date(e.at))}.jsonl`);
    (files.get(file) ?? files.set(file, []).get(file)!).push(JSON.stringify(e));
  }
  for (const [file, lines] of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  }
}

/** Events matching the query, oldest first (the newest `limit` of them). */
export function readActivity(q: ActivityQuery = {}): ActivityEvent[] {
  const limit = q.limit ?? 200;
  const folders = q.dir ? [activityFolder(q.dir)] : allFolders();
  const sinceDay = q.since ? localDay(q.since) : undefined;
  const untilDay = q.until ? localDay(q.until) : undefined;
  const matches = activityMatcher(q);
  const out: ActivityEvent[] = [];
  for (const folder of folders) {
    const found: ActivityEvent[] = [];
    // Newest day first, and stop once there's enough: the files are in time order.
    for (const day of days(folder).reverse()) {
      if (sinceDay && day < sinceDay) break;
      if (untilDay && day > untilDay) continue;
      const batch: ActivityEvent[] = [];
      for (const line of readLines(path.join(folder, `${day}.jsonl`))) {
        let e: ActivityEvent;
        try {
          e = JSON.parse(line) as ActivityEvent;
        } catch {
          continue; // a line cut short when the dashboard stopped
        }
        if (matches(e)) batch.push(e);
      }
      found.unshift(...batch);
      if (found.length >= limit) break;
    }
    out.push(...found.slice(-limit));
  }
  return byTime(out).slice(-limit);
}

/**
 * In the order things happened. Ids are the order events arrived in, and a page sends its
 * clicks and console lines a moment after they happen, so a click can arrive after the request
 * it caused; the time each event carries puts it back in place.
 */
export function byTime(events: ActivityEvent[]): ActivityEvent[] {
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
}

/** The query as a test on one event (everything but `limit`). */
export function activityMatcher(q: ActivityQuery): (e: ActivityEvent) => boolean {
  const search = q.search?.trim().toLowerCase();
  const sinceMs = q.since?.getTime();
  const untilMs = q.until?.getTime();
  const sameDir = q.dir ? norm(path.resolve(q.dir)) : undefined;
  return (e) => {
    if (q.after !== undefined && e.id <= q.after) return false;
    const t = Date.parse(e.at);
    if (sinceMs !== undefined && t < sinceMs) return false;
    if (untilMs !== undefined && t > untilMs) return false;
    if (sameDir && norm(path.resolve(e.dir)) !== sameDir) return false;
    if (q.types?.length && !q.types.includes(e.type)) return false;
    if (q.problems && !isProblem(e)) return false;
    if (search && !haystack(e).includes(search)) return false;
    return true;
  };
}

/** A failed request, an exception, a console error or warning, a server error. */
export function isProblem(e: ActivityEvent): boolean {
  if (e.type === "error" || e.type === "server-error") return true;
  if (e.type === "request" || e.type === "page") return !!e.error || (e.status ?? 0) >= 400;
  if (e.type === "console") return e.level === "error" || e.level === "warn";
  return e.level === "error";
}

/** Deletes days older than `days`. */
export function pruneActivity(keepDays = 7, now = new Date()): number {
  const oldest = localDay(new Date(now.getTime() - (keepDays - 1) * 86_400_000));
  let removed = 0;
  for (const folder of allFolders()) {
    for (const day of days(folder)) {
      if (day >= oldest) continue;
      fs.rmSync(path.join(folder, `${day}.jsonl`), { force: true });
      removed++;
    }
    if (!days(folder).length) fs.rmSync(folder, { recursive: true, force: true });
  }
  return removed;
}

/** Deletes one project's history, or everyone's. */
export function clearActivity(dir?: string): void {
  if (dir) fs.rmSync(activityFolder(dir), { recursive: true, force: true });
  else fs.rmSync(dxPath("activity"), { recursive: true, force: true });
}

/**
 * Reads "30m", "2h", "3d", "today", "yesterday", or a date or time, as the moment it means.
 * Undefined when it can't be read.
 */
export function parseSince(text: string, now = new Date()): Date | undefined {
  const s = text.trim().toLowerCase();
  const m = /^(\d+)\s*(s|m|min|h|d|w)$/.exec(s);
  if (m) {
    const unit = { s: 1e3, m: 6e4, min: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2] as "s"]!;
    return new Date(now.getTime() - Number(m[1]) * unit);
  }
  if (s === "today" || s === "yesterday") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    if (s === "yesterday") d.setDate(d.getDate() - 1);
    return d;
  }
  // 14:30 today
  const clock = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    return d;
  }
  const t = Date.parse(text);
  return Number.isNaN(t) ? undefined : new Date(t);
}

/** One line per event, for the terminal and for AI agents. `bodies` adds payloads and stacks. */
export function formatActivity(events: ActivityEvent[], options: { bodies?: boolean; project?: boolean; maxBody?: number } = {}): string {
  const max = options.maxBody ?? 2000;
  const clip = (s: string) => (s.length > max ? `${s.slice(0, max)} …` : s);
  const out: string[] = [];
  for (const e of events) {
    const time = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const who = [options.project ? e.project : "", e.service ? `[${e.service}]` : ""].filter(Boolean).join(" ");
    out.push(`${time}  ${LABELS[e.type].padEnd(7)} ${who ? `${who} ` : ""}${e.text}${e.ms !== undefined && e.type === "request" ? `  (${e.ms} ms)` : ""}`);
    if (!options.bodies) continue;
    if (e.source) out.push(`           at ${e.source}`);
    if (e.requestBody) out.push(`           → ${clip(e.requestBody)}`);
    if (e.responseBody) out.push(`           ← ${clip(e.responseBody)}${e.truncated ? " (cut short)" : ""}`);
    if (e.stack && e.type !== "console") out.push(...clip(e.stack).split("\n").slice(0, 12).map((l) => `           ${l}`));
  }
  return out.join("\n");
}

const LABELS: Record<ActivityType, string> = {
  request: "request",
  page: "page",
  route: "route",
  action: "action",
  console: "console",
  error: "error",
  server: "server",
  "server-error": "srv err",
};

function haystack(e: ActivityEvent): string {
  return [e.text, e.url ?? "", e.page ?? "", e.requestBody ?? "", e.responseBody ?? "", e.stack ?? "", e.source ?? "", e.service ?? ""].join("\n").toLowerCase();
}

function allFolders(): string[] {
  const root = dxPath("activity");
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
}

/** The days a folder has, oldest first, as YYYY-MM-DD. */
function days(folder: string): string[] {
  try {
    return fs
      .readdirSync(folder)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function norm(p: string): string {
  return process.platform === "linux" ? p : p.toLowerCase();
}
