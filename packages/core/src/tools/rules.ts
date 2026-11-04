import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dxPath } from "../config.js";

/**
 * Rules for the traffic that passes through dx's proxy to a project's dev server, like Burp's
 * match and replace or a Postman proxy: change a request before the server sees it, change the
 * answer before the page sees it, slow it down, make it fail, or hold it in the dashboard to edit
 * by hand (intercept). Kept per project under ~/.dx/rules, readable by this user only. Mock mode
 * (answering from recordings) is separate: a mocked call never reaches the server or these rules.
 */

export type RuleFail = "500" | "timeout" | "drop";
export type InterceptPhase = "request" | "response" | "both";

export interface JsonEdit {
  /** A dot path into the JSON body: "user.name", "items.0.price". */
  path: string;
  /** The new value; undefined (or absent) with `remove` deletes it. */
  value?: unknown;
  remove?: boolean;
}

export interface PayloadEdits {
  setHeaders?: Record<string, string>;
  removeHeaders?: string[];
  json?: JsonEdit[];
  /** The whole body, replaced. Wins over `json`. */
  body?: string;
}

export interface TrafficRule {
  id: string;
  name: string;
  on: boolean;
  /** "*" or a method. */
  method: string;
  /** A path pattern: `*` is one segment, `**` any number; a pattern without `?` ignores the query. */
  path: string;
  /** For a stack: only this service. */
  service?: string;
  request?: PayloadEdits;
  response?: PayloadEdits & { status?: number };
  /** Added before the request goes on, at most 30 s. */
  delayMs?: number;
  /** Answer with a 500, hang until the browser gives up, or close the connection. */
  fail?: RuleFail;
  /** Hold the request, its answer, or both in the dashboard to edit by hand. */
  intercept?: InterceptPhase;
  updatedAt?: string;
}

export interface RuleSet {
  format: "dx-rules";
  version: 1;
  dir: string;
  project: string;
  rules: TrafficRule[];
  updatedAt: string;
}

export const RULE_DELAY_MAX = 30_000;
export const RULES_MAX = 100;
export const RULE_BODY_MAX = 1024 * 1024;

export class RuleError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

function norm(p: string): string {
  const r = path.resolve(p);
  return process.platform === "linux" ? r : r.toLowerCase();
}

/** The file one project's rules are kept in. */
export function rulesFile(dir: string): string {
  const name = path.basename(dir).replace(/[^\w.-]+/g, "-").slice(0, 40) || "project";
  return dxPath("rules", `${name}-${crypto.createHash("sha1").update(norm(dir)).digest("hex").slice(0, 8)}.json`);
}

export function loadRules(dir: string, project = path.basename(dir)): RuleSet {
  const empty: RuleSet = { format: "dx-rules", version: 1, dir: path.resolve(dir), project, rules: [], updatedAt: new Date().toISOString() };
  try {
    const raw = JSON.parse(fs.readFileSync(rulesFile(dir), "utf8")) as RuleSet;
    if (raw?.format !== "dx-rules" || !Array.isArray(raw.rules)) return empty;
    return { ...empty, ...raw, rules: raw.rules.flatMap((r) => (cleanRule(r, true) ? [cleanRule(r, true)!] : [])) };
  } catch {
    return empty;
  }
}

/** Writes the set through a temp file and a rename, readable by this user only. */
export function saveRules(set: RuleSet): RuleSet {
  const file = rulesFile(set.dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  set.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(set, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return set;
}

/** Adds a rule, or replaces the one with its id. Everything in it is checked first. */
export function putRule(dir: string, project: string, input: unknown): TrafficRule {
  const rule = cleanRule(input);
  if (!rule) throw new RuleError("That isn't a rule dx can use.");
  const set = loadRules(dir, project);
  const i = set.rules.findIndex((r) => r.id === rule.id);
  if (i < 0 && set.rules.length >= RULES_MAX) throw new RuleError(`A project can have ${RULES_MAX} rules.`);
  rule.updatedAt = new Date().toISOString();
  if (i >= 0) set.rules[i] = rule;
  else set.rules.push(rule);
  saveRules(set);
  return rule;
}

export function removeRule(dir: string, id: string): RuleSet {
  const set = loadRules(dir);
  const before = set.rules.length;
  set.rules = set.rules.filter((r) => r.id !== id);
  if (set.rules.length === before) throw new RuleError("That rule isn't there any more.", 404);
  return saveRules(set);
}

const METHODS = new Set(["*", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
// Hop-by-hop and framing headers are dx's to set, never a rule's.
const RESERVED = new Set(["content-length", "transfer-encoding", "connection", "host", "upgrade", "keep-alive", "te", "trailer"]);

/** A rule from the page or a file, with only known fields of the right shape; undefined when it can't be one. */
export function cleanRule(input: unknown, lenient = false): TrafficRule | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const fail = (msg: string): undefined => {
    if (lenient) return undefined;
    throw new RuleError(msg);
  };
  const method = String(o.method ?? "*").toUpperCase();
  if (!METHODS.has(method)) return fail(`Unknown method "${method}".`);
  const p = String(o.path ?? "").trim();
  if (!p.startsWith("/") && p !== "*" && p !== "**") return fail("A rule's path starts with / (use * for one part, ** for any number).");
  if (p.length > 500) return fail("That path is too long.");
  const id = typeof o.id === "string" && /^[a-z0-9]{6,20}$/.test(o.id) ? o.id : crypto.randomBytes(5).toString("hex");
  const rule: TrafficRule = {
    id,
    name: String(o.name ?? "").trim().slice(0, 80) || `${method === "*" ? "Any" : method} ${p}`,
    on: o.on !== false,
    method,
    path: p,
  };
  if (typeof o.service === "string" && /^[\w.-]{1,60}$/.test(o.service)) rule.service = o.service;
  const edits = (raw: unknown, which: string): PayloadEdits | undefined => {
    if (!raw || typeof raw !== "object") return undefined;
    const e = raw as Record<string, unknown>;
    const out: PayloadEdits = {};
    if (e.setHeaders && typeof e.setHeaders === "object") {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.setHeaders as Record<string, unknown>)) {
        const name = k.toLowerCase();
        if (!HEADER.test(k) || RESERVED.has(name)) return fail(`dx can't set the ${which} header "${k}".`);
        const value = String(v);
        if (/[\r\n]/.test(value) || value.length > 8000) return fail(`The ${which} header "${k}" has a value dx can't send.`);
        h[name] = value;
      }
      if (Object.keys(h).length) out.setHeaders = h;
    }
    if (Array.isArray(e.removeHeaders)) {
      const r = e.removeHeaders.map((x) => String(x).toLowerCase()).filter((x) => HEADER.test(x) && !RESERVED.has(x));
      if (r.length) out.removeHeaders = r;
    }
    if (Array.isArray(e.json)) {
      const j: JsonEdit[] = [];
      for (const x of e.json.slice(0, 50)) {
        const je = x as Record<string, unknown>;
        const jp = String(je?.path ?? "").trim();
        if (!/^[^.\s][^\s]{0,200}$/.test(jp)) return fail(`"${jp}" isn't a JSON path (like user.name or items.0.price).`);
        j.push(je.remove === true ? { path: jp, remove: true } : { path: jp, value: je.value });
      }
      if (j.length) out.json = j;
    }
    if (typeof e.body === "string") {
      if (Buffer.byteLength(e.body) > RULE_BODY_MAX) return fail("A body can be at most 1 MB.");
      out.body = e.body;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const request = edits(o.request, "request");
  if (request) rule.request = request;
  const response = edits(o.response, "response") as TrafficRule["response"] | undefined;
  const status = Number((o.response as Record<string, unknown> | undefined)?.status);
  if (o.response && (o.response as Record<string, unknown>).status !== undefined && (o.response as Record<string, unknown>).status !== "") {
    if (!Number.isInteger(status) || status < 100 || status > 599) return fail("A status is a number from 100 to 599.");
  }
  if (response || Number.isInteger(status)) rule.response = { ...(response ?? {}), ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
  const delay = Number(o.delayMs);
  if (Number.isFinite(delay) && delay > 0) rule.delayMs = Math.min(RULE_DELAY_MAX, Math.round(delay));
  if (o.fail === "500" || o.fail === "timeout" || o.fail === "drop") rule.fail = o.fail;
  if (o.intercept === "request" || o.intercept === "response" || o.intercept === "both") rule.intercept = o.intercept;
  if (lenient && typeof o.updatedAt === "string") rule.updatedAt = o.updatedAt;
  return rule;
}

/** Whether a path pattern matches a request's address. */
export function pathMatches(pattern: string, url: string): boolean {
  if (pattern === "*" || pattern === "**") return true;
  const withQuery = pattern.includes("?");
  const target = withQuery ? url : url.split("?")[0];
  const [pPath, pQuery] = pattern.split("?");
  const [tPath, tQuery = ""] = target.split("?");
  const p = pPath.split("/").filter((s, i) => i === 0 || s !== "");
  const t = tPath.split("/").filter((s, i) => i === 0 || s !== "");
  const seg = (pi: number, ti: number): boolean => {
    if (pi === p.length) return ti === t.length;
    if (p[pi] === "**") return seg(pi + 1, ti) || (ti < t.length && seg(pi, ti + 1));
    if (ti === t.length) return false;
    const re = new RegExp(`^${p[pi].split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
    return re.test(decodeSafe(t[ti])) && seg(pi + 1, ti + 1);
  };
  if (!seg(0, 0)) return false;
  if (!withQuery) return true;
  // Each key=value the pattern names must be in the query ("*" as a value matches any).
  const want = new URLSearchParams(pQuery);
  const have = new URLSearchParams(tQuery);
  for (const [k, v] of want) if (!have.has(k) || (v !== "*" && have.get(k) !== v)) return false;
  return true;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The project's rules that are on and match, in their order. */
export function matchRules(set: RuleSet | undefined, req: { method: string; url: string; service?: string }): TrafficRule[] {
  if (!set) return [];
  const method = req.method.toUpperCase();
  return set.rules.filter((r) => r.on && (r.method === "*" || r.method === method) && (!r.service || r.service === req.service) && pathMatches(r.path, req.url));
}

// ------------------------------------------------------------------ editing payloads

export type Headers = Record<string, string | string[] | undefined>;

export function editHeaders(headers: Headers, e: PayloadEdits | undefined): Headers {
  if (!e) return headers;
  const out: Headers = {};
  const remove = new Set(e.removeHeaders ?? []);
  for (const [k, v] of Object.entries(headers)) if (!remove.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  for (const [k, v] of Object.entries(e.setHeaders ?? {})) out[k] = v;
  return out;
}

/** A body after a rule's edits: replaced whole, or changed field by field when it's JSON. */
export function editBody(body: string, e: PayloadEdits | undefined): { body: string; note?: string } {
  if (!e) return { body };
  if (typeof e.body === "string") return { body: e.body };
  if (!e.json?.length) return { body };
  let doc: unknown;
  try {
    doc = body.trim() ? JSON.parse(body) : {};
  } catch {
    return { body, note: "the body isn't JSON, so its fields weren't changed" };
  }
  for (const j of e.json) doc = j.remove ? removeJsonPath(doc, j.path) : setJsonPath(doc, j.path, j.value);
  return { body: JSON.stringify(doc) };
}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Sets `a.b.0.c` in a JSON value, making objects (or arrays, for number keys) on the way. */
export function setJsonPath(doc: unknown, p: string, value: unknown): unknown {
  const keys = p.split(".");
  if (keys.some((k) => UNSAFE_KEYS.has(k))) return doc;
  const root: unknown = doc !== null && typeof doc === "object" ? doc : {};
  let cur = root as Record<string, unknown>;
  keys.forEach((k, i) => {
    const key = Array.isArray(cur) && /^\d+$/.test(k) ? Number(k) : k;
    if (i === keys.length - 1) {
      (cur as Record<string | number, unknown>)[key] = value;
      return;
    }
    let next = (cur as Record<string | number, unknown>)[key];
    if (next === null || typeof next !== "object") {
      next = /^\d+$/.test(keys[i + 1]) ? [] : {};
      (cur as Record<string | number, unknown>)[key] = next;
    }
    cur = next as Record<string, unknown>;
  });
  return root;
}

export function removeJsonPath(doc: unknown, p: string): unknown {
  const keys = p.split(".");
  let cur: unknown = doc;
  for (const k of keys.slice(0, -1)) {
    if (cur === null || typeof cur !== "object") return doc;
    cur = (cur as Record<string, unknown>)[k];
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(cur) && /^\d+$/.test(last)) cur.splice(Number(last), 1);
  else if (cur !== null && typeof cur === "object") delete (cur as Record<string, unknown>)[last];
  return doc;
}

/** What the matching rules do, combined in order: later rules add to or override earlier ones. */
export interface RulePlan {
  rules: TrafficRule[];
  delayMs: number;
  fail?: RuleFail;
  interceptRequest: boolean;
  interceptResponse: boolean;
  request: PayloadEdits[];
  response: Array<PayloadEdits & { status?: number }>;
  /** The request's body must be read whole before it goes on. */
  needsRequestBody: boolean;
  /** The answer's body must be read whole (and uncompressed) before it goes back. */
  needsResponseBody: boolean;
}

export function planRules(rules: TrafficRule[]): RulePlan | undefined {
  if (!rules.length) return undefined;
  const plan: RulePlan = { rules, delayMs: 0, interceptRequest: false, interceptResponse: false, request: [], response: [], needsRequestBody: false, needsResponseBody: false };
  for (const r of rules) {
    plan.delayMs = Math.min(RULE_DELAY_MAX, plan.delayMs + (r.delayMs ?? 0));
    plan.fail ??= r.fail;
    if (r.intercept === "request" || r.intercept === "both") plan.interceptRequest = true;
    if (r.intercept === "response" || r.intercept === "both") plan.interceptResponse = true;
    if (r.request) plan.request.push(r.request);
    if (r.response) plan.response.push(r.response);
  }
  plan.needsRequestBody = plan.interceptRequest || plan.request.some((e) => e.body !== undefined || e.json?.length);
  plan.needsResponseBody = plan.interceptResponse || plan.response.some((e) => e.body !== undefined || e.json?.length);
  return plan;
}
