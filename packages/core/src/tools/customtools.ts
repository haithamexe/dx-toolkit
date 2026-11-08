import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dxPath } from "../config.js";
import { readActivity, type ActivityEvent } from "./activity.js";
import { MASK } from "./mask.js";
import { foldPath } from "./mocks.js";
import { projectSpec, readSpec } from "./openapi.js";

/**
 * Custom tools: a project's own helpers, made once in a chat with an AI agent and then run by dx
 * the same way every time, with no AI. A tool is data in a fixed format, never code: where its
 * data comes from (a request to the project's dev server, or calls already recorded), steps that
 * reshape it, and how it's shown (a view); which events to watch for (a watch); or requests to
 * send in order (an operation). `cleanTool` checks every field, so a tool from the AI, the page or
 * an imported file can only be what this file describes.
 */

export type ToolKind = "view" | "watch" | "operation" | "answer" | "page" | "column";
export type ToolFormat = "text" | "number" | "money" | "percent" | "date" | "ago" | "ms" | "bytes" | "badge" | "json";
export type Tone = "danger" | "warn" | "ok";

/** A value from an item: a dot path ("customer.name", "items.0.price", "" for the item itself), a literal, or one operation. */
export type Expr = string | number | boolean | null | { [op: string]: unknown };

/** A condition on an item. */
export interface Where {
  field?: Expr;
  is?: unknown;
  not?: unknown;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  contains?: string;
  in?: unknown[];
  exists?: boolean;
  all?: Where[];
  any?: Where[];
}

export type ToolStep =
  | { get: string }
  | { flatten: string }
  | { map: Record<string, Expr> }
  | { filter: Where }
  | { sort: Expr; desc?: boolean }
  | { limit: number }
  | { group: Expr; sum?: Expr; avg?: Expr }
  | { count: true }
  | { sum: Expr };

export interface ToolColumn {
  field: string;
  label?: string;
  format?: ToolFormat;
}

export type ToolDisplay =
  | { as: "table"; columns?: ToolColumn[]; highlight?: { when: Where; tone: Tone }[] }
  | { as: "cards"; title: string; fields?: ToolColumn[]; highlight?: { when: Where; tone: Tone }[] }
  | { as: "number"; label?: string; format?: ToolFormat }
  | { as: "bars"; label: string; value: string; format?: ToolFormat }
  | { as: "tree" };

export type ToolSource =
  | { request: { method: string; path: string; headers?: Record<string, string>; body?: string } }
  | { recorded: { method?: string; path: string; calls?: boolean; last?: number } };

export interface ToolMatch {
  type?: "request" | "page" | "error" | "console" | "server-error" | "any";
  method?: string;
  /** A path pattern: `*` is one segment, `**` the rest; a folded `:id` fits any value. */
  path?: string;
  /** A status, "2xx" to "5xx", or "failed" (an error, or 4xx/5xx). */
  status?: number | "2xx" | "3xx" | "4xx" | "5xx" | "failed";
  notStatus?: number[];
  /** Text the line, address or message contains (case ignored). */
  text?: string;
}

export interface ToolInput {
  name: string;
  label?: string;
  default?: string;
}

export interface ToolRequest {
  name?: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** Sent this many times ({{i}} is 1, 2, …): a number up to 50, or an input ("{{count}}"). */
  repeat?: number | string;
  /** Values to keep from a JSON answer for later steps: { token: "data.token" } → {{token}}. */
  save?: Record<string, string>;
  /** The status it should answer; anything else stops the operation. */
  expect?: number;
}

/** A view a page change shows: where its data comes from, its steps and its display. */
export interface ToolViewPart {
  source: ToolSource;
  steps?: ToolStep[];
  display?: ToolDisplay;
}

/** One change a page tool makes to the app's own page, while it's used through dx. */
export type PageChange =
  | { panel: ToolViewPart & { title: string } }
  | { section: ToolViewPart & { title: string; at: string; place?: "before" | "after" | "inside" } }
  | { column: { table: string; header: string; source: ToolSource; steps?: ToolStep[]; key: { cell: number; field: string }; value: string; format?: ToolFormat } }
  | { highlight: { selector: string; text?: string; tone: Tone } }
  | { hide: { selector: string } };

export type ColumnShow = "last" | "avg" | "min" | "max" | "sum" | "count" | "unique";

export interface CustomTool {
  id: string;
  name: string;
  description?: string;
  kind: ToolKind;
  /** answer, page and column tools change things, so they can be switched off without deleting them. */
  off?: boolean;
  source?: ToolSource;
  steps?: ToolStep[];
  display?: ToolDisplay;
  /** A view shown on dx's own pages too: a card on the project's Overview. */
  pin?: "overview"[];
  match?: ToolMatch;
  alert?: { toast?: boolean; floppy?: boolean };
  inputs?: ToolInput[];
  requests?: ToolRequest[];
  /** answer: the calls whose JSON answers it changes, where in the answer, and how. */
  target?: { method?: string; path: string };
  at?: string;
  set?: Record<string, Expr>;
  remove?: string[];
  /** page: the app's pages it changes (a path pattern) and what it changes there. */
  path?: string;
  changes?: PageChange[];
  /** column: a column on dx's Activity API list, from each endpoint's calls. */
  page?: "activity-apis";
  endpoint?: { method?: string; path?: string };
  label?: string;
  from?: string;
  show?: ColumnShow;
  format?: ToolFormat;
  createdAt?: string;
  updatedAt?: string;
}

export class ToolError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const TOOL_MAX_BYTES = 64 * 1024;
export const TOOLS_MAX = 100;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const FORMATS: ToolFormat[] = ["text", "number", "money", "percent", "date", "ago", "ms", "bytes", "badge", "json"];
const TONES: Tone[] = ["danger", "warn", "ok"];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "keep-alive", "te", "trailer"]);
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const EXPR_OPS: Record<string, "one" | "list" | "pair" | "literal" | "cond"> = {
  value: "literal",
  add: "list",
  sub: "pair",
  mul: "list",
  div: "pair",
  round: "one",
  concat: "list",
  lower: "one",
  upper: "one",
  len: "one",
  first: "one",
  last: "one",
  default: "list",
  join: "pair",
  if: "cond",
};

// ------------------------------------------------------------------ checking a tool

/** Only these keys, each one checked; anything else is refused by name, so the AI can be told exactly what to fix. */
function only(o: Record<string, unknown>, keys: string[], where: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new ToolError(`${where}: "${k}" isn't something a tool can have here (it can have ${keys.join(", ")}).`);
}
function obj(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ToolError(`${where} must be an object.`);
  return v as Record<string, unknown>;
}
function str(v: unknown, where: string, max: number, optional = false): string | undefined {
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string") throw new ToolError(`${where} must be text.`);
  if (v.length > max) throw new ToolError(`${where} can be at most ${max} characters.`);
  return v;
}
function int(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ToolError(`${where} must be a whole number from ${min} to ${max}.`);
  return v;
}
function dotPath(v: unknown, where: string): string {
  const p = str(v, where, 200)!;
  if (p.split(".").some((s) => UNSAFE_KEYS.has(s))) throw new ToolError(`${where}: that path isn't allowed.`);
  return p;
}
function method(v: unknown, where: string): string {
  const m = String(v ?? "GET").toUpperCase();
  if (!METHODS.includes(m)) throw new ToolError(`${where}: the method is one of ${METHODS.join(", ")}.`);
  return m;
}
/** A path on the project's own dev server: starts with one /, no spaces; {{vars}} allowed in operations. */
function appPath(v: unknown, where: string): string {
  const p = str(v, where, 2000)!;
  if (!p.startsWith("/") || p.startsWith("//") || /[\s\r\n\\]/.test(p)) throw new ToolError(`${where}: a path on the app, starting with / (like /api/orders?page=2).`);
  return p;
}
function headers(v: unknown, where: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  const o = obj(v, where);
  const out: Record<string, string> = {};
  if (Object.keys(o).length > 30) throw new ToolError(`${where}: at most 30 headers.`);
  for (const [k, raw] of Object.entries(o)) {
    if (!HEADER_NAME.test(k) || RESERVED_HEADERS.has(k.toLowerCase())) throw new ToolError(`${where}: "${k}" can't be set.`);
    const value = String(raw ?? "");
    if (/[\r\n]/.test(value) || value.length > 4000) throw new ToolError(`${where}: the value of ${k} can't be sent.`);
    out[k.toLowerCase()] = value;
  }
  return out;
}
function format(v: unknown, where: string): ToolFormat | undefined {
  if (v === undefined) return undefined;
  if (!FORMATS.includes(v as ToolFormat)) throw new ToolError(`${where}: a format is one of ${FORMATS.join(", ")}.`);
  return v as ToolFormat;
}

export function cleanExpr(v: unknown, where: string, depth = 0): Expr {
  if (depth > 6) throw new ToolError(`${where}: too deeply nested.`);
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return dotPath(v, where);
  const o = obj(v, where);
  const keys = Object.keys(o);
  if (keys.length !== 1 || !(keys[0] in EXPR_OPS)) throw new ToolError(`${where}: a value is a path, a number, or one of ${Object.keys(EXPR_OPS).join(", ")} (like {"mul": ["price", "qty"]}).`);
  const op = keys[0];
  const arg = o[op];
  const kind = EXPR_OPS[op];
  if (kind === "literal") {
    if (JSON.stringify(arg ?? null).length > 2000) throw new ToolError(`${where}: the value is too long.`);
    return { value: arg ?? null };
  }
  if (kind === "one") return { [op]: Array.isArray(arg) && op === "round" ? [cleanExpr(arg[0], where, depth + 1), int(arg[1], `${where} round digits`, 0, 6)] : cleanExpr(arg, where, depth + 1) };
  if (kind === "cond") {
    if (!Array.isArray(arg) || arg.length !== 3) throw new ToolError(`${where}: if takes [condition, then, else].`);
    return { if: [cleanWhere(arg[0], `${where} if`, depth + 1), cleanExpr(arg[1], where, depth + 1), cleanExpr(arg[2], where, depth + 1)] };
  }
  if (!Array.isArray(arg) || arg.length < (kind === "pair" ? 2 : 1) || arg.length > (kind === "pair" ? 2 : 20)) throw new ToolError(`${where}: ${op} takes ${kind === "pair" ? "two values" : "a list of values"}.`);
  if (op === "join") return { join: [cleanExpr(arg[0], where, depth + 1), str(arg[1], `${where} join separator`, 20)!] };
  return { [op]: arg.map((x) => cleanExpr(x, where, depth + 1)) };
}

export function cleanWhere(v: unknown, where: string, depth = 0): Where {
  if (depth > 6) throw new ToolError(`${where}: too deeply nested.`);
  const o = obj(v, where);
  only(o, ["field", "is", "not", "gt", "gte", "lt", "lte", "contains", "in", "exists", "all", "any"], where);
  const out: Where = {};
  if (o.all !== undefined || o.any !== undefined) {
    for (const k of ["all", "any"] as const) {
      if (o[k] === undefined) continue;
      if (!Array.isArray(o[k]) || !(o[k] as unknown[]).length || (o[k] as unknown[]).length > 20) throw new ToolError(`${where}: ${k} is a list of conditions.`);
      out[k] = (o[k] as unknown[]).map((x) => cleanWhere(x, `${where} ${k}`, depth + 1));
    }
    return out;
  }
  if (o.field === undefined) throw new ToolError(`${where}: a condition needs a field (like {"field": "status", "is": "failed"}).`);
  out.field = cleanExpr(o.field, `${where} field`, depth + 1);
  for (const k of ["is", "not"] as const) {
    if (o[k] === undefined) continue;
    if (JSON.stringify(o[k]).length > 2000) throw new ToolError(`${where}: the value for ${k} is too long.`);
    out[k] = o[k];
  }
  for (const k of ["gt", "gte", "lt", "lte"] as const) if (o[k] !== undefined) {
    if (typeof o[k] !== "number") throw new ToolError(`${where}: ${k} takes a number.`);
    out[k] = o[k] as number;
  }
  if (o.contains !== undefined) out.contains = str(o.contains, `${where} contains`, 500);
  if (o.in !== undefined) {
    if (!Array.isArray(o.in) || o.in.length > 100) throw new ToolError(`${where}: in takes a list of up to 100 values.`);
    out.in = o.in;
  }
  if (o.exists !== undefined) out.exists = o.exists === true;
  if (Object.keys(out).length === 1) throw new ToolError(`${where}: say what the field should be (is, not, gt, lt, contains, in or exists).`);
  return out;
}

function cleanStep(v: unknown, where: string): ToolStep {
  const o = obj(v, where);
  if ("get" in o) return only(o, ["get"], where), { get: dotPath(o.get, `${where} get`) };
  if ("flatten" in o) return only(o, ["flatten"], where), { flatten: dotPath(o.flatten, `${where} flatten`) };
  if ("map" in o) {
    only(o, ["map"], where);
    const m = obj(o.map, `${where} map`);
    const entries = Object.entries(m);
    if (!entries.length || entries.length > 40) throw new ToolError(`${where}: map names 1 to 40 fields.`);
    const out: Record<string, Expr> = {};
    for (const [k, x] of entries) {
      if (UNSAFE_KEYS.has(k) || k.length > 60) throw new ToolError(`${where}: "${k}" can't be a field name.`);
      out[k] = cleanExpr(x, `${where} map ${k}`);
    }
    return { map: out };
  }
  if ("filter" in o) return only(o, ["filter"], where), { filter: cleanWhere(o.filter, `${where} filter`) };
  if ("sort" in o) {
    only(o, ["sort", "desc"], where);
    return { sort: cleanExpr(o.sort, `${where} sort`), ...(o.desc === true ? { desc: true } : {}) };
  }
  if ("limit" in o) return only(o, ["limit"], where), { limit: int(o.limit, `${where} limit`, 1, 1000) };
  if ("group" in o) {
    only(o, ["group", "sum", "avg"], where);
    return { group: cleanExpr(o.group, `${where} group`), ...(o.sum !== undefined ? { sum: cleanExpr(o.sum, `${where} sum`) } : {}), ...(o.avg !== undefined ? { avg: cleanExpr(o.avg, `${where} avg`) } : {}) };
  }
  if ("count" in o) return only(o, ["count"], where), { count: true };
  if ("sum" in o) return only(o, ["sum"], where), { sum: cleanExpr(o.sum, `${where} sum`) };
  throw new ToolError(`${where}: a step is one of get, flatten, map, filter, sort, limit, group, count, sum.`);
}

function cleanColumns(v: unknown, where: string): ToolColumn[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.length || v.length > 30) throw new ToolError(`${where}: 1 to 30 columns.`);
  return v.map((c, i) => {
    const o = obj(c, `${where} ${i + 1}`);
    only(o, ["field", "label", "format"], `${where} ${i + 1}`);
    return { field: dotPath(o.field, `${where} ${i + 1} field`), ...(o.label !== undefined ? { label: str(o.label, `${where} ${i + 1} label`, 60) } : {}), ...(o.format !== undefined ? { format: format(o.format, `${where} ${i + 1}`) } : {}) };
  });
}

function cleanHighlight(v: unknown, where: string): { when: Where; tone: Tone }[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 10) throw new ToolError(`${where}: up to 10 highlights.`);
  return v.map((x, i) => {
    const o = obj(x, `${where} ${i + 1}`);
    only(o, ["when", "tone"], `${where} ${i + 1}`);
    if (!TONES.includes(o.tone as Tone)) throw new ToolError(`${where} ${i + 1}: the tone is danger, warn or ok.`);
    return { when: cleanWhere(o.when, `${where} ${i + 1} when`), tone: o.tone as Tone };
  });
}

function cleanDisplay(v: unknown): ToolDisplay {
  const o = obj(v, "display");
  if (o.as === "table") return only(o, ["as", "columns", "highlight"], "display"), { as: "table", ...strip({ columns: cleanColumns(o.columns, "display columns"), highlight: cleanHighlight(o.highlight, "display highlight") }) };
  if (o.as === "cards") return only(o, ["as", "title", "fields", "highlight"], "display"), { as: "cards", title: dotPath(o.title, "display title"), ...strip({ fields: cleanColumns(o.fields, "display fields"), highlight: cleanHighlight(o.highlight, "display highlight") }) };
  if (o.as === "number") return only(o, ["as", "label", "format"], "display"), { as: "number", ...strip({ label: str(o.label, "display label", 80, true), format: format(o.format, "display") }) };
  if (o.as === "bars") return only(o, ["as", "label", "value", "format"], "display"), { as: "bars", label: dotPath(o.label, "display label"), value: dotPath(o.value, "display value"), ...strip({ format: format(o.format, "display") }) };
  if (o.as === "tree") return only(o, ["as"], "display"), { as: "tree" };
  throw new ToolError('display: "as" is one of table, cards, number, bars, tree.');
}

function cleanSource(v: unknown): ToolSource {
  const o = obj(v, "source");
  if ("request" in o) {
    only(o, ["request"], "source");
    const r = obj(o.request, "source request");
    only(r, ["method", "path", "headers", "body"], "source request");
    return { request: { method: method(r.method, "source request"), path: appPath(r.path, "source request path"), ...strip({ headers: headers(r.headers, "source request headers"), body: str(r.body, "source request body", 100_000, true) }) } };
  }
  if ("recorded" in o) {
    only(o, ["recorded"], "source");
    const r = obj(o.recorded, "source recorded");
    only(r, ["method", "path", "calls", "last"], "source recorded");
    return { recorded: { ...(r.method !== undefined ? { method: method(r.method, "source recorded") } : {}), path: appPath(r.path, "source recorded path"), ...(r.calls === true ? { calls: true } : {}), ...(r.last !== undefined ? { last: int(r.last, "source recorded last", 1, 200) } : {}) } };
  }
  throw new ToolError('source is {"request": {…}} (ask the dev server) or {"recorded": {…}} (calls already recorded).');
}

function cleanMatch(v: unknown): ToolMatch {
  const o = obj(v, "match");
  only(o, ["type", "method", "path", "status", "notStatus", "text"], "match");
  const out: ToolMatch = {};
  if (o.type !== undefined) {
    if (!["request", "page", "error", "console", "server-error", "any"].includes(o.type as string)) throw new ToolError("match type is request, page, error, console, server-error or any.");
    out.type = o.type as ToolMatch["type"];
  }
  if (o.method !== undefined) out.method = method(o.method, "match");
  if (o.path !== undefined) out.path = appPath(o.path, "match path");
  if (o.status !== undefined) {
    if (!(typeof o.status === "number" && Number.isInteger(o.status) && o.status >= 100 && o.status <= 599) && !["2xx", "3xx", "4xx", "5xx", "failed"].includes(o.status as string)) throw new ToolError('match status is a number, "2xx" to "5xx", or "failed".');
    out.status = o.status as ToolMatch["status"];
  }
  if (o.notStatus !== undefined) {
    if (!Array.isArray(o.notStatus) || o.notStatus.length > 20 || !o.notStatus.every((s) => Number.isInteger(s) && s >= 100 && s <= 599)) throw new ToolError("match notStatus is a list of statuses.");
    out.notStatus = o.notStatus as number[];
  }
  if (o.text !== undefined) out.text = str(o.text, "match text", 300);
  if (!Object.keys(out).length) throw new ToolError("match: say what to watch for (a type, method, path, status or text).");
  return out;
}

function cleanRequests(v: unknown): ToolRequest[] {
  if (!Array.isArray(v) || !v.length || v.length > 20) throw new ToolError("requests: 1 to 20 requests.");
  return v.map((x, i) => {
    const where = `request ${i + 1}`;
    const o = obj(x, where);
    only(o, ["name", "method", "path", "headers", "body", "repeat", "save", "expect"], where);
    const save = o.save === undefined ? undefined : obj(o.save, `${where} save`);
    if (save) for (const [k, p] of Object.entries(save)) {
      if (!VAR_NAME.test(k)) throw new ToolError(`${where} save: "${k}" can't be a name (letters, digits and _).`);
      dotPath(p, `${where} save ${k}`);
    }
    return {
      ...strip({ name: str(o.name, `${where} name`, 80, true) }),
      method: method(o.method, where),
      path: appPath(o.path, `${where} path`),
      ...strip({
        headers: headers(o.headers, `${where} headers`),
        body: str(o.body, `${where} body`, 100_000, true),
        repeat: o.repeat === undefined ? undefined : typeof o.repeat === "string" && /^\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/.test(o.repeat) ? o.repeat : int(o.repeat, `${where} repeat`, 1, 50),
        save: save as Record<string, string> | undefined,
        expect: o.expect === undefined ? undefined : int(o.expect, `${where} expect`, 100, 599),
      }),
    };
  });
}

/** The fields each kind has (besides id, name, description and kind). */
const KIND_FIELDS: Record<ToolKind, string[]> = {
  view: ["source", "steps", "display", "pin"],
  watch: ["match", "alert"],
  operation: ["inputs", "requests"],
  answer: ["target", "at", "set", "remove", "off"],
  page: ["path", "changes", "off"],
  column: ["page", "endpoint", "label", "from", "show", "format", "off"],
};
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,59}$/;
const SELECTOR_MAX = 300;

function cleanSteps(v: unknown): ToolStep[] {
  if (!Array.isArray(v) || v.length > 30) throw new ToolError("steps: up to 30 steps.");
  return v.map((s, i) => cleanStep(s, `step ${i + 1}`));
}

function selector(v: unknown, where: string): string {
  const s = str(v, where, SELECTOR_MAX)!.trim();
  if (!s) throw new ToolError(`${where}: a CSS selector, like "table.orders" or "#cart".`);
  return s;
}

/** A page change's view: a GET to the app (so it can run by itself when the page opens) or recorded calls. */
function cleanViewPart(o: Record<string, unknown>, where: string): ToolViewPart {
  const source = cleanSource(o.source);
  if ("request" in source && source.request.method !== "GET") throw new ToolError(`${where}: a page change only asks with GET (it runs by itself when the page opens).`);
  return { source, ...(o.steps !== undefined ? { steps: cleanSteps(o.steps) } : {}), display: cleanDisplay(o.display ?? { as: "tree" }) };
}

function cleanPageChange(v: unknown, where: string): PageChange {
  const o = obj(v, where);
  if ("panel" in o) {
    only(o, ["panel"], where);
    const p = obj(o.panel, `${where} panel`);
    only(p, ["title", "source", "steps", "display"], `${where} panel`);
    return { panel: { title: str(p.title, `${where} title`, 80)!, ...cleanViewPart(p, where) } };
  }
  if ("section" in o) {
    only(o, ["section"], where);
    const p = obj(o.section, `${where} section`);
    only(p, ["title", "at", "place", "source", "steps", "display"], `${where} section`);
    if (p.place !== undefined && !["before", "after", "inside"].includes(p.place as string)) throw new ToolError(`${where}: place is before, after or inside.`);
    return { section: { title: str(p.title, `${where} title`, 80)!, at: selector(p.at, `${where} at`), ...(p.place !== undefined ? { place: p.place as "before" | "after" | "inside" } : {}), ...cleanViewPart(p, where) } };
  }
  if ("column" in o) {
    only(o, ["column"], where);
    const c = obj(o.column, `${where} column`);
    only(c, ["table", "header", "source", "steps", "key", "value", "format"], `${where} column`);
    const k = obj(c.key, `${where} key`);
    only(k, ["cell", "field"], `${where} key`);
    const part = cleanViewPart({ ...c, display: undefined }, where);
    return {
      column: {
        table: selector(c.table, `${where} table`),
        header: str(c.header, `${where} header`, 60)!,
        source: part.source,
        ...(part.steps ? { steps: part.steps } : {}),
        key: { cell: int(k.cell, `${where} key cell`, 0, 50), field: dotPath(k.field, `${where} key field`) },
        value: dotPath(c.value, `${where} value`),
        ...(c.format !== undefined ? { format: format(c.format, where) } : {}),
      },
    };
  }
  if ("highlight" in o) {
    only(o, ["highlight"], where);
    const x = obj(o.highlight, `${where} highlight`);
    only(x, ["selector", "text", "tone"], `${where} highlight`);
    if (!TONES.includes(x.tone as Tone)) throw new ToolError(`${where}: the tone is danger, warn or ok.`);
    return { highlight: { selector: selector(x.selector, `${where} selector`), ...(x.text !== undefined ? { text: str(x.text, `${where} text`, 200) } : {}), tone: x.tone as Tone } };
  }
  if ("hide" in o) {
    only(o, ["hide"], where);
    const x = obj(o.hide, `${where} hide`);
    only(x, ["selector"], `${where} hide`);
    return { hide: { selector: selector(x.selector, `${where} selector`) } };
  }
  throw new ToolError(`${where}: a change is a panel, section, column, highlight or hide.`);
}

/**
 * An answer tool's change to one JSON answer: at its path (a list: every item; an object: itself),
 * each `set` field worked out from the item, each `remove` field taken out. Field names only, never
 * a path, so nothing reaches past the item.
 */
export function applyAnswerTool(data: unknown, t: Pick<CustomTool, "at" | "set" | "remove">): unknown {
  const target = t.at ? pathValue(data, t.at) : data;
  const items = Array.isArray(target) ? target : [target];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    for (const [k, e] of Object.entries(t.set ?? {})) if (!UNSAFE_KEYS.has(k)) rec[k] = evalExpr(e, item);
    for (const k of t.remove ?? []) if (!UNSAFE_KEYS.has(k)) delete rec[k];
  }
  return data;
}

function strip<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * A tool with only known fields of the right shape, for its kind; throws a ToolError naming the
 * first thing wrong. Keeps its id and dates when they're well formed (a stored tool); a new one gets an id.
 */
export function cleanTool(input: unknown): CustomTool {
  if (JSON.stringify(input ?? null).length > TOOL_MAX_BYTES) throw new ToolError("A tool can be at most 64 KB.");
  const o = obj(input, "The tool");
  const fields = Object.values(KIND_FIELDS).flat();
  only(o, ["id", "name", "description", "kind", "createdAt", "updatedAt", ...new Set(fields)], "The tool");
  const name = str(o.name, "name", 80)!.trim();
  if (!name) throw new ToolError("Give the tool a name.");
  if (!(String(o.kind) in KIND_FIELDS)) throw new ToolError(`kind is one of ${Object.keys(KIND_FIELDS).join(", ")}.`);
  const kind = o.kind as ToolKind;
  const tool: CustomTool = {
    id: typeof o.id === "string" && /^[a-f0-9]{12}$/.test(o.id) ? o.id : newToolId(),
    name,
    ...strip({ description: str(o.description, "description", 300, true) }),
    kind,
  };
  for (const f of fields) if (o[f] !== undefined && !KIND_FIELDS[kind].includes(f)) throw new ToolError(`${/^[aeiou]/.test(kind) ? "An" : "A"} ${kind} tool doesn't have ${f}.`);
  if (o.off === true) tool.off = true;
  if (kind === "view") {
    tool.source = cleanSource(o.source);
    if (o.steps !== undefined) tool.steps = cleanSteps(o.steps);
    tool.display = cleanDisplay(o.display ?? { as: "tree" });
    if (o.pin !== undefined) {
      if (!Array.isArray(o.pin) || !o.pin.every((p) => p === "overview")) throw new ToolError('pin is ["overview"]: a card on the project\'s Overview.');
      if (o.pin.length) tool.pin = ["overview"];
    }
  } else if (kind === "answer") {
    const t = obj(o.target, "target");
    only(t, ["method", "path"], "target");
    tool.target = { ...(t.method !== undefined ? { method: method(t.method, "target") } : {}), path: appPath(t.path, "target path") };
    if (o.at !== undefined) tool.at = dotPath(o.at, "at");
    if (o.set !== undefined) {
      const s = obj(o.set, "set");
      const entries = Object.entries(s);
      if (!entries.length || entries.length > 30) throw new ToolError("set names 1 to 30 fields.");
      tool.set = {};
      for (const [k, e] of entries) {
        if (!FIELD_NAME.test(k) || UNSAFE_KEYS.has(k)) throw new ToolError(`set: "${k}" can't be a field name (letters, digits, _ and -).`);
        tool.set[k] = cleanExpr(e, `set ${k}`);
      }
    }
    if (o.remove !== undefined) {
      if (!Array.isArray(o.remove) || o.remove.length > 30 || !o.remove.every((k) => typeof k === "string" && FIELD_NAME.test(k) && !UNSAFE_KEYS.has(k))) throw new ToolError("remove is a list of field names.");
      tool.remove = o.remove as string[];
    }
    if (!tool.set && !tool.remove) throw new ToolError("An answer tool sets fields (set) or takes them out (remove).");
  } else if (kind === "page") {
    tool.path = appPath(o.path, "path");
    if (!Array.isArray(o.changes) || !o.changes.length || o.changes.length > 10) throw new ToolError("changes: 1 to 10 changes to the page.");
    tool.changes = o.changes.map((c, i) => cleanPageChange(c, `change ${i + 1}`));
  } else if (kind === "column") {
    if (o.page !== undefined && o.page !== "activity-apis") throw new ToolError('page is "activity-apis": the Activity page\'s list of API calls.');
    tool.page = "activity-apis";
    if (o.endpoint !== undefined) {
      const e = obj(o.endpoint, "endpoint");
      only(e, ["method", "path"], "endpoint");
      tool.endpoint = strip({ method: e.method === undefined ? undefined : method(e.method, "endpoint"), path: e.path === undefined ? undefined : appPath(e.path, "endpoint path") });
    }
    tool.label = str(o.label, "label", 40)!;
    tool.from = dotPath(o.from, "from");
    if (!/^(status|ms|body|request)(\.|$)/.test(tool.from)) throw new ToolError('from is "status", "ms", "body.<path in the answer>" or "request.<path in the request body>".');
    if (!["last", "avg", "min", "max", "sum", "count", "unique"].includes(o.show as string)) throw new ToolError("show is last, avg, min, max, sum, count or unique.");
    tool.show = o.show as ColumnShow;
    if (o.format !== undefined) tool.format = format(o.format, "column");
  } else if (kind === "watch") {
    tool.match = cleanMatch(o.match);
    if (o.alert !== undefined) {
      const a = obj(o.alert, "alert");
      only(a, ["toast", "floppy"], "alert");
      tool.alert = strip({ toast: a.toast === true ? true : undefined, floppy: a.floppy === true ? true : undefined });
    }
  } else {
    if (o.inputs !== undefined) {
      if (!Array.isArray(o.inputs) || o.inputs.length > 10) throw new ToolError("inputs: up to 10 inputs.");
      tool.inputs = o.inputs.map((x, i) => {
        const w = `input ${i + 1}`;
        const io = obj(x, w);
        only(io, ["name", "label", "default"], w);
        const n = str(io.name, `${w} name`, 31)!;
        if (!VAR_NAME.test(n)) throw new ToolError(`${w}: "${n}" can't be a name (letters, digits and _).`);
        return { name: n, ...strip({ label: str(io.label, `${w} label`, 80, true), default: io.default === undefined ? undefined : String(io.default).slice(0, 2000) }) };
      });
    }
    tool.requests = cleanRequests(o.requests);
  }
  for (const k of ["createdAt", "updatedAt"] as const) if (typeof o[k] === "string" && !Number.isNaN(Date.parse(o[k] as string))) tool[k] = o[k] as string;
  return tool;
}

export function newToolId(): string {
  return crypto.randomBytes(6).toString("hex");
}

// ------------------------------------------------------------------ running a view's steps

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The value at a dot path; "" or "." is the value itself. Never walks into __proto__ and the like. */
export function pathValue(v: unknown, p: string): unknown {
  if (p === "" || p === ".") return v;
  let cur: unknown = v;
  for (const seg of p.split(".")) {
    if (UNSAFE_KEYS.has(seg)) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (isObj(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);

export function evalExpr(e: Expr, item: unknown): unknown {
  if (e === null || typeof e === "number" || typeof e === "boolean") return e;
  if (typeof e === "string") return pathValue(item, e);
  const [op, arg] = Object.entries(e)[0];
  const all = () => (arg as Expr[]).map((x) => evalExpr(x, item));
  switch (op) {
    case "value":
      return arg;
    case "add":
      return all().reduce<number>((a, b) => a + (num(b) ?? 0), 0);
    case "mul":
      return all().reduce<number>((a, b) => a * (num(b) ?? 0), 1);
    case "sub": {
      const [a, b] = all().map(num);
      return a === undefined || b === undefined ? undefined : a - b;
    }
    case "div": {
      const [a, b] = all().map(num);
      return a === undefined || !b ? undefined : a / b;
    }
    case "round": {
      const [x, digits] = Array.isArray(arg) ? [evalExpr(arg[0] as Expr, item), arg[1] as number] : [evalExpr(arg as Expr, item), 0];
      const n = num(x);
      return n === undefined ? undefined : Math.round(n * 10 ** digits) / 10 ** digits;
    }
    case "concat":
      return all().map((x) => (x === undefined || x === null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x))).join("");
    case "lower":
    case "upper": {
      const x = evalExpr(arg as Expr, item);
      return typeof x === "string" ? (op === "lower" ? x.toLowerCase() : x.toUpperCase()) : x;
    }
    case "len": {
      const x = evalExpr(arg as Expr, item);
      return Array.isArray(x) || typeof x === "string" ? x.length : isObj(x) ? Object.keys(x).length : 0;
    }
    case "first":
    case "last": {
      const x = evalExpr(arg as Expr, item);
      return Array.isArray(x) ? (op === "first" ? x[0] : x[x.length - 1]) : x;
    }
    case "default":
      return all().find((x) => x !== undefined && x !== null && x !== "");
    case "join": {
      const [x, sep] = arg as [Expr, string];
      const v = evalExpr(x, item);
      return Array.isArray(v) ? v.map((y) => (isObj(y) ? JSON.stringify(y) : String(y))).join(sep) : v;
    }
    case "if": {
      const [cond, a, b] = arg as [Where, Expr, Expr];
      return evalExpr(matchesWhere(cond, item) ? a : b, item);
    }
  }
  return undefined;
}

const same = (a: unknown, b: unknown) => a === b || (num(a) !== undefined && num(a) === num(b)) || (typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase());

export function matchesWhere(w: Where, item: unknown): boolean {
  if (w.all) return w.all.every((x) => matchesWhere(x, item));
  if (w.any) return w.any.some((x) => matchesWhere(x, item));
  const v = evalExpr(w.field ?? "", item);
  if (w.exists !== undefined && (v !== undefined && v !== null) !== w.exists) return false;
  if (w.is !== undefined && !same(v, w.is)) return false;
  if (w.not !== undefined && same(v, w.not)) return false;
  const n = num(v);
  if (w.gt !== undefined && !(n !== undefined && n > w.gt)) return false;
  if (w.gte !== undefined && !(n !== undefined && n >= w.gte)) return false;
  if (w.lt !== undefined && !(n !== undefined && n < w.lt)) return false;
  if (w.lte !== undefined && !(n !== undefined && n <= w.lte)) return false;
  if (w.contains !== undefined && !(typeof v === "string" ? v : JSON.stringify(v ?? "")).toLowerCase().includes(w.contains.toLowerCase())) return false;
  if (w.in !== undefined && !w.in.some((x) => same(v, x))) return false;
  return true;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** A view's steps over its data, in order. Pure: nothing outside the data is read. */
export function runSteps(data: unknown, steps: ToolStep[] = []): unknown {
  let cur = data;
  for (const s of steps) {
    if ("get" in s) cur = pathValue(cur, s.get);
    else if ("flatten" in s) cur = asList(cur).flatMap((x) => asList(pathValue(x, s.flatten)));
    else if ("map" in s) cur = asList(cur).map((x) => Object.fromEntries(Object.entries(s.map).map(([k, e]) => [k, evalExpr(e, x)])));
    else if ("filter" in s) cur = asList(cur).filter((x) => matchesWhere(s.filter, x));
    else if ("sort" in s) {
      const keyed = asList(cur).map((x) => ({ x, k: evalExpr(s.sort, x) }));
      keyed.sort((a, b) => {
        const an = num(a.k);
        const bn = num(b.k);
        const c = an !== undefined && bn !== undefined ? an - bn : String(a.k ?? "").localeCompare(String(b.k ?? ""));
        return s.desc ? -c : c;
      });
      cur = keyed.map((y) => y.x);
    } else if ("limit" in s) cur = asList(cur).slice(0, s.limit);
    else if ("group" in s) {
      const groups = new Map<string, { key: unknown; count: number; sum: number; n: number; avgSum: number }>();
      for (const x of asList(cur)) {
        const key = evalExpr(s.group, x);
        const id = JSON.stringify(key ?? null);
        const g = groups.get(id) ?? groups.set(id, { key, count: 0, sum: 0, n: 0, avgSum: 0 }).get(id)!;
        g.count++;
        if (s.sum !== undefined) g.sum += num(evalExpr(s.sum, x)) ?? 0;
        if (s.avg !== undefined) {
          const a = num(evalExpr(s.avg, x));
          if (a !== undefined) ((g.avgSum += a), g.n++);
        }
      }
      cur = [...groups.values()].map((g) => ({ key: g.key, count: g.count, ...(s.sum !== undefined ? { sum: g.sum } : {}), ...(s.avg !== undefined ? { avg: g.n ? g.avgSum / g.n : undefined } : {}) }));
    } else if ("count" in s) cur = asList(cur).length;
    else if ("sum" in s) cur = asList(cur).reduce<number>((a, x) => a + (num(evalExpr(s.sum, x)) ?? 0), 0);
  }
  return cur;
}

// ------------------------------------------------------------------ watches and recorded calls

/** A path pattern against a path: `*` one segment, `**` the rest, `:id`/`{id}` any value; the query is left out. */
export function toolPathMatches(pattern: string, p: string): boolean {
  const pat = pattern.split("?")[0].split("/").filter(Boolean);
  const segs = p.split("?")[0].split("#")[0].split("/").filter(Boolean);
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === "**") return true;
    if (i >= segs.length) return false;
    if (pat[i] === "*" || pat[i].startsWith(":") || /^\{.+\}$/.test(pat[i])) continue;
    if (pat[i].toLowerCase() !== segs[i].toLowerCase()) return false;
  }
  return pat.length === segs.length;
}

const failedStatus = (e: ActivityEvent) => !!e.error || (e.status !== undefined && e.status >= 400);

/** Whether an activity event is one a watch is looking for. */
export function matchesWatch(m: ToolMatch, e: ActivityEvent): boolean {
  const type = m.type ?? (m.method || m.status !== undefined || m.notStatus ? "request" : "any");
  if (type !== "any" && e.type !== type) return false;
  if (m.method && (e.method ?? "GET").toUpperCase() !== m.method) return false;
  if (m.path) {
    let p = e.url ?? "";
    try {
      if (/^https?:/.test(p)) p = new URL(p).pathname;
    } catch {
      // not an address
    }
    if (!toolPathMatches(m.path, p)) return false;
  }
  if (m.status !== undefined) {
    const s = e.status;
    if (m.status === "failed" ? !failedStatus(e) : typeof m.status === "number" ? s !== m.status : !(s !== undefined && Math.floor(s / 100) === Number(m.status[0]))) return false;
  }
  if (m.notStatus && (e.status === undefined || m.notStatus.includes(e.status))) return false;
  if (m.text && !`${e.text} ${e.url ?? ""} ${e.stack ?? ""}`.toLowerCase().includes(m.text.toLowerCase())) return false;
  return true;
}

/** The answer body as data: JSON parsed, else the text. */
export function bodyData(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * What a `recorded` source gives: the latest matching call's answer as data, or with `calls`, the
 * latest calls themselves (newest first): when, method, path, status, time and answer.
 */
export function recordedData(events: ActivityEvent[], r: { method?: string; path: string; calls?: boolean; last?: number }): unknown {
  const hits = events
    .filter((e) => e.type === "request" && (!r.method || (e.method ?? "GET").toUpperCase() === r.method) && toolPathMatches(r.path, (e.url ?? "").replace(/^https?:\/\/[^/]+/, "")))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!r.calls) return hits[0] ? bodyData(hits[0].responseBody) : undefined;
  return hits.slice(0, r.last ?? 20).map((e) => ({ at: e.at, method: (e.method ?? "GET").toUpperCase(), path: e.url, status: e.status, ms: e.ms, error: e.error, body: bodyData(e.responseBody) }));
}

/** One call's value for a column tool: its status or time, or a path in its answer or request body. */
export function columnValue(from: string, e: Pick<ActivityEvent, "status" | "ms" | "responseBody" | "requestBody">): unknown {
  if (from === "status") return e.status;
  if (from === "ms") return e.ms;
  if (from.startsWith("body")) return pathValue(bodyData(e.responseBody), from.slice(5));
  return pathValue(bodyData(e.requestBody), from.slice(8));
}

/** A column's values, oldest first, as one: the last, the average, the smallest… */
export function aggregateColumn(values: unknown[], show: ColumnShow): unknown {
  const present = values.filter((v) => v !== undefined && v !== null && v !== "");
  const nums = present.map(num).filter((n): n is number => n !== undefined);
  switch (show) {
    case "last":
      return present[present.length - 1];
    case "count":
      return present.length;
    case "unique":
      return [...new Set(present.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))))].slice(0, 10).join(", ");
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : undefined;
    case "min":
      return nums.length ? Math.min(...nums) : undefined;
    case "max":
      return nums.length ? Math.max(...nums) : undefined;
  }
}

/** A column tool over recorded calls, per endpoint ("GET /api/orders/:id"), for its preview. */
export function columnValues(t: CustomTool, events: ActivityEvent[]): { endpoint: string; value: unknown; calls: number }[] {
  const groups = new Map<string, unknown[]>();
  for (const e of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (e.type !== "request" || (e.env && e.env !== "local")) continue;
    const p = (e.url ?? "").replace(/^https?:\/\/[^/]+/, "");
    if (!p.startsWith("/") || p.startsWith("/__dx/")) continue;
    const m = (e.method ?? "GET").toUpperCase();
    if (t.endpoint?.method && m !== t.endpoint.method) continue;
    if (t.endpoint?.path && !toolPathMatches(t.endpoint.path, p)) continue;
    const key = `${m} ${foldPath(p)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(columnValue(t.from ?? "status", e));
  }
  return [...groups.entries()].map(([endpoint, vals]) => ({ endpoint, value: aggregateColumn(vals, t.show ?? "last"), calls: vals.length }));
}

/** {{name}} in a template from the values so far; an unknown name stays as written. */
export function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (all, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : all));
}

// ------------------------------------------------------------------ keeping a project's tools

interface ToolStore {
  format: "dx-tools-store";
  dir: string;
  tools: CustomTool[];
}

export function toolsFile(dir: string): string {
  const r = path.resolve(dir);
  const n = process.platform === "linux" ? r : r.toLowerCase();
  const name = path.basename(dir).replace(/[^\w.-]+/g, "-").slice(0, 40) || "project";
  return dxPath("tools", `${name}-${crypto.createHash("sha1").update(n).digest("hex").slice(0, 8)}.json`);
}

/** A project's tools, oldest first. A tool that no longer passes the checks is left out, not thrown. */
export function loadTools(dir: string): CustomTool[] {
  let store: ToolStore;
  try {
    store = JSON.parse(fs.readFileSync(toolsFile(dir), "utf8")) as ToolStore;
  } catch {
    return [];
  }
  if (store.format !== "dx-tools-store" || !Array.isArray(store.tools)) return [];
  const out: CustomTool[] = [];
  for (const t of store.tools) {
    try {
      out.push(cleanTool(t));
    } catch {
      // a tool written by an older dx that this one can't read
    }
  }
  return out;
}

function writeTools(dir: string, tools: CustomTool[]): void {
  const file = toolsFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ format: "dx-tools-store", dir: path.resolve(dir), tools } satisfies ToolStore, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Saves a tool (checked again): replaces the one with its id, or adds it. */
export function saveTool(dir: string, input: unknown): CustomTool {
  const tool = cleanTool(input);
  const tools = loadTools(dir);
  const at = new Date().toISOString();
  const i = tools.findIndex((t) => t.id === tool.id);
  if (i < 0 && tools.length >= TOOLS_MAX) throw new ToolError(`A project can have at most ${TOOLS_MAX} tools.`);
  const saved: CustomTool = { ...tool, createdAt: i >= 0 ? (tools[i].createdAt ?? at) : at, updatedAt: at };
  if (i >= 0) tools[i] = saved;
  else tools.push(saved);
  writeTools(dir, tools);
  return saved;
}

export function deleteTool(dir: string, id: string): CustomTool {
  const tools = loadTools(dir);
  const t = tools.find((x) => x.id === id);
  if (!t) throw new ToolError("That tool isn't there any more. Refresh the page.", 404);
  writeTools(dir, tools.filter((x) => x.id !== id));
  return t;
}

// ------------------------------------------------------------------ export and import

export interface ToolBundle {
  format: "dx-tools";
  version: 1;
  project: string;
  exportedAt: string;
  tools: Omit<CustomTool, "id" | "createdAt" | "updatedAt">[];
}

export const TOOL_BUNDLE_MAX = 2 * 1024 * 1024;

/** Every tool of a project as one file: definitions only (no ids or dates, and nothing about this computer). */
export function exportTools(dir: string, project: string): ToolBundle {
  return { format: "dx-tools", version: 1, project, exportedAt: new Date().toISOString(), tools: loadTools(dir).map(({ id: _id, createdAt: _c, updatedAt: _u, ...t }) => t) };
}

/** A tools file, read strictly: its format and version, at most 100 tools, each passing every check. */
export function readToolBundle(input: unknown): { project?: string; tools: CustomTool[] } {
  let raw = input;
  if (typeof raw === "string") {
    if (raw.length > TOOL_BUNDLE_MAX) throw new ToolError("A tools file can be at most 2 MB.", 413);
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new ToolError("That isn't a dx tools file (it isn't JSON).");
    }
  }
  const o = obj(raw, "The file");
  if (o.format !== "dx-tools") throw new ToolError("That isn't a dx tools file.");
  if (o.version !== 1) throw new ToolError("That tools file is from a newer dx: update dx to read it.");
  only(o, ["format", "version", "project", "exportedAt", "tools"], "The file");
  if (!Array.isArray(o.tools) || o.tools.length > TOOLS_MAX) throw new ToolError(`The file holds a list of up to ${TOOLS_MAX} tools.`);
  // Fresh ids: an imported tool never takes the place of one by its id.
  const tools = o.tools.map((t, i) => {
    try {
      const c = cleanTool({ ...obj(t, `Tool ${i + 1}`), id: undefined, createdAt: undefined, updatedAt: undefined });
      return c;
    } catch (err) {
      throw new ToolError(`Tool ${i + 1} in the file: ${(err as Error).message}`);
    }
  });
  return { project: typeof o.project === "string" ? o.project.slice(0, 80) : undefined, tools };
}

/**
 * Adds tools from a file: those picked (by their place in the file), a tool with the name of one
 * the project has either replacing it (keeping its id) or kept beside it as "Name (2)".
 */
export function importTools(dir: string, tools: CustomTool[], options: { pick?: number[]; replace?: boolean } = {}): { added: number; replaced: number } {
  const have = loadTools(dir);
  const chosen = options.pick ? tools.filter((_, i) => options.pick!.includes(i)) : tools;
  let added = 0;
  let replaced = 0;
  for (const t of chosen) {
    const at = new Date().toISOString();
    const same = have.findIndex((x) => x.name.toLowerCase() === t.name.toLowerCase());
    if (same >= 0 && options.replace) {
      have[same] = { ...t, id: have[same].id, createdAt: have[same].createdAt ?? at, updatedAt: at };
      replaced++;
      continue;
    }
    let name = t.name;
    for (let n = 2; have.some((x) => x.name.toLowerCase() === name.toLowerCase()); n++) name = `${t.name.slice(0, 74)} (${n})`;
    if (have.length >= TOOLS_MAX) throw new ToolError(`A project can have at most ${TOOLS_MAX} tools.`);
    have.push({ ...t, name, id: newToolId(), createdAt: at, updatedAt: at });
    added++;
  }
  writeTools(dir, have);
  return { added, replaced };
}

// ------------------------------------------------------------------ making one in a chat

/** What the agent is told about the format: every building block, with an example of each kind. */
export const TOOL_GUIDE = `A tool is one JSON object. It is data, never code: only these fields exist.

Common: "name" (short), "description" (one sentence), "kind": "view" | "watch" | "operation" | "answer" | "page" | "column".

VIEW: shows data in a readable shape.
- "source": where the data comes from, one of
  {"request": {"method": "GET", "path": "/api/orders?status=open", "headers": {...}, "body": "..."}}  (asked of the project's own dev server; GET views refresh by themselves)
  {"recorded": {"method": "GET", "path": "/api/orders/*", "calls": false}}  (the latest recorded answer to that endpoint; with "calls": true and "last": 20, the latest calls themselves as [{at, method, path, status, ms, error, body}])
  Paths: "*" is one segment, "**" the rest.
- "steps": a list, each one of
  {"get": "data.items"}  (take a nested value; "" is the whole thing; numbers index lists: "items.0")
  {"flatten": "lines"}  (each item's list, joined into one list)
  {"map": {"customer": "customer.name", "total": {"mul": ["price", "qty"]}}}  (each item becomes these fields)
  {"filter": {"field": "status", "is": "failed"}}
  {"sort": "total", "desc": true}
  {"limit": 50}
  {"group": "status", "sum": "total", "avg": "ms"}  (gives [{key, count, sum, avg}])
  {"count": true}  /  {"sum": "total"}  (gives one number)
- A value (in map, sort, group, sum, fields) is a dot path, a number, or one operation. Text is always a path: write literal text as {"value": "..."}.
  {"value": "literal"}, {"add": [a, b, ...]}, {"sub": [a, b]}, {"mul": [a, b, ...]}, {"div": [a, b]}, {"round": a} or {"round": [a, 2]},
  {"concat": ["first", {"value": " "}, "last"]}, {"lower": a}, {"upper": a}, {"len": a}, {"first": a}, {"last": a}, {"default": [a, {"value": "none"}]}, {"join": [a, ", "]} (the separator is literal), {"if": [condition, then, else]}
- A condition: {"field": value, "is" | "not" | "gt" | "gte" | "lt" | "lte" | "contains" | "in" | "exists": ...}, or {"all": [...]}, {"any": [...]}.
- "display": one of
  {"as": "table", "columns": [{"field": "total", "label": "Total", "format": "money"}], "highlight": [{"when": {"field": "status", "is": "failed"}, "tone": "danger"}]}
  {"as": "cards", "title": "name", "fields": [...], "highlight": [...]}
  {"as": "number", "label": "Open orders", "format": "number"}
  {"as": "bars", "label": "key", "value": "count"}
  {"as": "tree"}
  Formats: text, number, money, percent, date, ago, ms, bytes, badge, json. Tones: danger, warn, ok.
- "pin": ["overview"]  (also show it as a card on the project's Overview in dx)

ANSWER: changes the JSON answers of matching API calls on their way to the app (only while the app is used through dx).
- "target": {"method": "GET", "path": "/api/orders/*"}
- "at": "orders"  (where in the answer: a list changes every item, an object changes itself; left out, the whole answer)
- "set": {"total": {"mul": ["price", "qty"]}, "debug": {"value": true}}  (field names, each worked out from the item)
- "remove": ["internalNotes"]  (field names taken out)

PAGE: changes the app's own page in the browser (only while it's used through dx; the app's code isn't touched).
- "path": "/orders"  (the pages it applies to; "*" one segment, "**" the rest)
- "changes": a list, each one of
  {"panel": {"title": "Open orders", "source": {"request": {"method": "GET", "path": "/api/orders"}}, "steps": [...], "display": {...}}}  (a floating panel)
  {"section": {"title": "Totals", "at": "main h1", "place": "after", "source": ..., "steps": [...], "display": {...}}}  (place: before, after or inside the element)
  {"column": {"table": "table.orders", "header": "Margin", "source": ..., "steps": [...], "key": {"cell": 0, "field": "id"}, "value": "margin", "format": "money"}}  (a new cell in each row: the row's cell number "cell", counted from 0, is matched with the item whose "field" has the same text)
  {"highlight": {"selector": "tbody tr", "text": "failed", "tone": "danger"}}
  {"hide": {"selector": ".promo-banner"}}
  Selectors are CSS selectors of the app's own page. Page changes only ask with GET.

COLUMN: a column on dx's Activity page, in its list of API endpoints.
- "endpoint": {"method": "GET", "path": "/api/orders"}  (which endpoints; left out, all of them)
- "label": "Total", "from": "status" | "ms" | "body.total" | "request.qty", "show": "last" | "avg" | "min" | "max" | "sum" | "count" | "unique", "format": "money"

answer, page and column tools can be switched off with "off": true.

WATCH: looks at what the app does (the recorded requests, pages, errors and console lines) and says when something matches.
- "match": {"type": "request" | "page" | "error" | "console" | "server-error" | "any", "method": "POST", "path": "/api/checkout", "status": 500 | "4xx" | "failed", "notStatus": [201], "text": "timeout"}
- "alert": {"toast": true, "floppy": true}  (a message in the dashboard, and on the line beside Floppy)

OPERATION: requests sent in order to the project's own dev server, on a button.
- "inputs": [{"name": "count", "label": "How many", "default": "5"}]  (asked for before it runs; {{count}})
- "requests": [{"name": "Log in", "method": "POST", "path": "/api/login", "headers": {"content-type": "application/json"}, "body": "{\\"email\\":\\"test@example.com\\"}", "save": {"token": "token"}, "expect": 200},
               {"method": "POST", "path": "/api/orders", "headers": {"authorization": "Bearer {{token}}"}, "body": "{\\"n\\": {{i}}}", "repeat": "{{count}}", "expect": 201}]
  {{name}} is an input or a saved value; {{i}} is the repeat count (1, 2, …). "repeat" is a whole number up to 50, or an input like "{{count}}".`;

export interface ToolChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** What the agent is shown about the project: its API spec's endpoints and the API calls recorded lately, each with one answer. */
export function toolContext(dir: string): string {
  const out: string[] = [];
  try {
    const spec = projectSpec(dir);
    if (spec) {
      const s = readSpec(spec.doc);
      out.push(`Its API spec (${s.title}): ${s.endpoints.slice(0, 60).map((e) => `${e.method} ${e.path}${e.summary ? ` (${e.summary})` : ""}`).join("; ")}`);
    }
  } catch {
    // no spec it can read
  }
  const events = readActivity({ dir, since: new Date(Date.now() - 7 * 86_400_000), types: ["request"], limit: 3000 });
  const seen = new Map<string, ActivityEvent>();
  for (const e of [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const p = (e.url ?? "").replace(/^https?:\/\/[^/]+/, "");
    if (!p.startsWith("/") || p.startsWith("/__dx/")) continue;
    const key = `${(e.method ?? "GET").toUpperCase()} ${foldPath(p)}`;
    if (!seen.has(key)) seen.set(key, e);
    if (seen.size >= 30) break;
  }
  if (seen.size) {
    out.push("API calls recorded in the last 7 days, with the latest answer (values like tokens are already masked as •••):");
    for (const [key, e] of seen) out.push(`- ${key} → ${e.status ?? e.error ?? "?"}${e.responseBody ? `: ${e.responseBody.slice(0, 1200)}` : ""}`);
  } else out.push("No API calls recorded yet.");
  return out.join("\n");
}

/** The whole prompt for one turn of the chat: the format, the project, the tool so far, the conversation, and how to answer. */
// Request headers that hold credentials: hidden from the agent in a chat, and put back in its answer.
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie)$|token|secret|api[-_]?key|auth/i;

function headerBags(v: unknown, out: Record<string, string>[] = []): Record<string, string>[] {
  if (Array.isArray(v)) for (const x of v) headerBags(x, out);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (k === "headers" && x && typeof x === "object" && !Array.isArray(x)) out.push(x as Record<string, string>);
      else headerBags(x, out);
    }
  return out;
}

/**
 * A tool for the chat, with the values of its requests' credential headers hidden (a value made
 * of `{{inputs}}` stays: it holds no secret), and the hidden values by header name.
 */
export function hideToolSecrets(tool: CustomTool): { shown: CustomTool; kept: Map<string, string> } {
  const shown = structuredClone(tool);
  const kept = new Map<string, string>();
  for (const bag of headerBags(shown))
    for (const [k, v] of Object.entries(bag)) {
      if (!SECRET_HEADER.test(k) || typeof v !== "string" || v.includes("{{") || v === MASK) continue;
      if (!kept.has(k.toLowerCase())) kept.set(k.toLowerCase(), v);
      bag[k] = MASK;
    }
  return { shown, kept };
}

/** The agent's tool with the hidden header values put back where it kept them hidden. */
export function restoreToolSecrets(tool: CustomTool, kept: Map<string, string> | undefined): CustomTool {
  if (!kept?.size) return tool;
  for (const bag of headerBags(tool))
    for (const [k, v] of Object.entries(bag)) if (typeof v === "string" && v.includes(MASK) && kept.has(k.toLowerCase())) bag[k] = kept.get(k.toLowerCase())!;
  return tool;
}

export function toolPrompt(o: { project: string; context: string; current?: CustomTool; history: ToolChatTurn[]; message: string; problem?: string }): string {
  const history = o.history.slice(-12).map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text}`).join("\n");
  return [
    `You help a developer make a small tool in dx, their local developer dashboard, for the project "${o.project}".`,
    "You're in the project's folder: look at its code and files as much as you need to understand its API, but don't change anything. A tool isn't code: your final answer is one JSON object, nothing else:",
    '{"reply": "one or two sentences for the user", "tool": { ...the whole tool... }}',
    'Leave "tool" out only when you need to ask something first. Always give the whole tool, not a change.',
    "",
    TOOL_GUIDE,
    "",
    "What dx knows about the project:",
    o.context,
    "",
    o.current ? `The tool so far:\n${JSON.stringify({ ...o.current, id: undefined, createdAt: undefined, updatedAt: undefined })}` : "There's no tool yet.",
    history ? `\nThe conversation so far:\n${history}` : "",
    o.problem ? `\nYour last answer couldn't be used: ${o.problem}. Answer again with a tool that fits the format.` : "",
    "",
    `User: ${o.message}`,
  ].join("\n");
}
