import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dxPath } from "../config.js";
import type { ActivityEvent } from "./activity.js";
import { maskBody } from "./mask.js";

/**
 * Mock mode: a project's API answered by dx from what was recorded, so its front end runs
 * without its back end. A mock set is made from the activity history (a visit, or the last
 * hour), kept per project in ~/.dx/mocks/<project>-<hash>.json (readable by this user only),
 * and used only by dx's own proxy for dev servers dx runs. Endpoints are matched by method and
 * path with ids folded (/orders/42 → /orders/:id), and by query and body where the recorded
 * calls differed by them. The bodies are the recorded ones, masked values included.
 */

export interface MockEndpoint {
  /** Stable for the same method, path, query and body. */
  id: string;
  method: string;
  /** The path with ids folded: /orders/:id. */
  path: string;
  /** The exact query (?page=2), when the recorded calls differed by it. */
  query?: string;
  /** A hash of the request body, when the recorded calls differed by it. */
  bodyKey?: string;
  /** The request body that one was recorded with (masked), so you can tell them apart. */
  requestBody?: string;
  /** For a stack: the service it was recorded on. */
  service?: string;
  status: number;
  /** How long to wait before answering, ms (at most 30 s). */
  delayMs: number;
  contentType: string;
  body: string;
  /** Answer as if the API were down: the connection is closed without an answer. */
  offline?: boolean;
  enabled: boolean;
  /** Changed by hand: making mocks again from the history leaves it as it is. */
  edited?: boolean;
  /** What was recorded, for Reset. */
  recorded: { status: number; contentType: string; body: string; at: string; eventId: number };
  updatedAt: string;
  /** Where it came from: made from the history, kept by the cache, the API spec's example, made up from its schema, or written by Claude. */
  source?: MockSource;
  /** An API spec's path template (/users/{name}): matched instead of `path`, so any value fits. */
  pattern?: string;
  /** The spec's name for it (operationId or summary). */
  operation?: string;
  /** For a mock made from one of the project's several API specs: which (its id and name). */
  api?: string;
  apiName?: string;
  /** The example's name in the spec, for x-mock-response-name. */
  example?: string;
}

export type MockSource = "recorded" | "cache" | "spec" | "generated" | "ai";

export interface MockSet {
  format: "dx-mocks";
  version: 1;
  dir: string;
  project: string;
  /** Mock mode is on: matching API calls are answered from here. */
  on: boolean;
  /** Also answer API calls that have no mock with a 404, instead of passing them to the dev server. */
  strict: boolean;
  /** Keep every real API answer that passes through as a mock (source "cache"), until purged. */
  cache?: boolean;
  /** Its mock server runs (started again with the dashboard), and the port it had, so its address stays. */
  server?: boolean;
  serverPort?: number;
  endpoints: MockEndpoint[];
  updatedAt: string;
}

export type MockPreset = "fail" | "empty" | "slow" | "offline" | "reset";
export const MOCK_PRESETS: MockPreset[] = ["fail", "empty", "slow", "offline", "reset"];

export const MOCK_BODY_MAX = 1024 * 1024;
export const MOCK_DELAY_MAX = 30_000;
export const MOCK_ENDPOINTS_MAX = 500;

export class MockError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** /orders/42/items/9f1c… → /orders/:id/items/:id: numbers, UUIDs and long hex become :id. The Activity page's APIs view folds the same way. */
export function foldPath(p: string): string {
  const pathname = p.split("?")[0].split("#")[0] || "/";
  return pathname
    .split("/")
    .map((seg) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{16,}$/i.test(seg) ? ":id" : seg))
    .join("/");
}

function norm(dir: string): string {
  const r = path.resolve(dir);
  return process.platform === "linux" ? r : r.toLowerCase();
}

/** The file one project's mocks are kept in. */
export function mockFile(dir: string): string {
  const name = path.basename(dir).replace(/[^\w.-]+/g, "-").slice(0, 40) || "project";
  return dxPath("mocks", `${name}-${crypto.createHash("sha1").update(norm(dir)).digest("hex").slice(0, 8)}.json`);
}

function emptySet(dir: string, project: string): MockSet {
  return { format: "dx-mocks", version: 1, dir: path.resolve(dir), project, on: false, strict: false, endpoints: [], updatedAt: new Date().toISOString() };
}

/** A project's mock set; an empty one (off) when it has none. */
export function loadMocks(dir: string, project = path.basename(dir)): MockSet {
  try {
    const raw = JSON.parse(fs.readFileSync(mockFile(dir), "utf8")) as MockSet;
    if (raw?.format !== "dx-mocks" || !Array.isArray(raw.endpoints)) return emptySet(dir, project);
    return { ...emptySet(dir, project), ...raw, on: raw.on === true, strict: raw.strict === true, cache: raw.cache === true || undefined };
  } catch {
    return emptySet(dir, project);
  }
}

export function hasMocks(dir: string): boolean {
  return fs.existsSync(mockFile(dir));
}

/** Writes the set through a temp file and a rename, readable by this user only. */
export function saveMocks(set: MockSet): MockSet {
  const file = mockFile(set.dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  set.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(set, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  return set;
}

export interface MockSummary {
  on: boolean;
  strict: boolean;
  endpoints: number;
  enabled: number;
}

export function mockSummary(dir: string): MockSummary | undefined {
  if (!hasMocks(dir)) return undefined;
  const s = loadMocks(dir);
  return { on: s.on, strict: s.strict, endpoints: s.endpoints.length, enabled: s.endpoints.filter((e) => e.enabled).length };
}

function bodyKeyOf(body: string | undefined, contentType: string): string | undefined {
  if (!body) return undefined;
  const masked = maskBody(body, contentType);
  let canonical = masked;
  try {
    canonical = JSON.stringify(sortKeys(JSON.parse(masked)));
  } catch {
    // not JSON: the text as it is
  }
  return crypto.createHash("sha1").update(canonical).digest("hex").slice(0, 12);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

function endpointId(method: string, p: string, query?: string, bodyKey?: string, service?: string): string {
  return crypto.createHash("sha1").update([method, p, query ?? "", bodyKey ?? "", service ?? ""].join("\n")).digest("hex").slice(0, 10);
}

function queryOf(url: string): string {
  const i = url.indexOf("?");
  return i < 0 ? "" : url.slice(i).split("#")[0];
}

/**
 * Mocks from recorded API calls: one per method and folded path, the most recent answer; where
 * the calls differed by query or body, one per query or body. Only answers the proxy saw (the
 * only place mocks apply), and never ones that were mocked themselves.
 */
export function mocksFromActivity(events: ActivityEvent[]): MockEndpoint[] {
  const calls = events.filter(
    // Not mocked answers, nor ones a custom tool changed: neither is what the server said.
    (e) => e.type === "request" && (e.from === "proxy" || e.from === "check") && !e.mocked && !e.rules?.some((r) => r.startsWith("tool: ")) && !e.error && e.status !== undefined && !!e.url && e.url.startsWith("/") && !e.url.startsWith("/__dx/"),
  );
  const groups = new Map<string, ActivityEvent[]>();
  for (const e of calls) {
    const key = `${(e.method ?? "GET").toUpperCase()} ${e.service ?? ""} ${foldPath(e.url!)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }
  const out: MockEndpoint[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
    const reqType = (e: ActivityEvent) => e.requestHeaders?.["content-type"] ?? "";
    const byQuery = new Set(list.map((e) => queryOf(e.url!))).size > 1;
    const byBody = new Set(list.map((e) => bodyKeyOf(e.requestBody, reqType(e)) ?? "")).size > 1;
    const newest = new Map<string, ActivityEvent>();
    for (const e of list) newest.set(`${byQuery ? queryOf(e.url!) : ""}|${byBody ? (bodyKeyOf(e.requestBody, reqType(e)) ?? "") : ""}`, e);
    for (const e of newest.values()) {
      const method = (e.method ?? "GET").toUpperCase();
      const p = foldPath(e.url!);
      const query = byQuery ? queryOf(e.url!) || undefined : undefined;
      const bodyKey = byBody ? bodyKeyOf(e.requestBody, reqType(e)) : undefined;
      const contentType = e.responseHeaders?.["content-type"] ?? "application/json";
      const body = (e.responseBody ?? "").slice(0, MOCK_BODY_MAX);
      const status = e.status!;
      out.push({
        id: endpointId(method, p, query, bodyKey, e.service),
        method,
        path: p,
        query,
        bodyKey,
        requestBody: bodyKey ? e.requestBody?.slice(0, 4000) : undefined,
        service: e.service,
        status,
        delayMs: 0,
        contentType,
        body,
        enabled: true,
        recorded: { status, contentType, body, at: e.at, eventId: e.id },
        updatedAt: e.at,
      });
    }
  }
  return out;
}

/** Adds mocks made from `events` to the project's set: a newer recording replaces an older one, unless you edited it. */
export function addMocks(dir: string, project: string, events: ActivityEvent[], source: MockSource = "recorded"): { set: MockSet; added: number; replaced: number; kept: number } {
  return putMocks(dir, project, mocksFromActivity(events).map((m) => ({ ...m, source })));
}

/**
 * Adds endpoints (made from history, an API spec, or by Claude) to the project's set: one with
 * the same id replaces the old one, unless that was edited by hand.
 */
export function putMocks(dir: string, project: string, made: MockEndpoint[], options: { replaceApis?: string[]; legacy?: boolean } = {}): { set: MockSet; added: number; replaced: number; kept: number } {
  const set = loadMocks(dir, project);
  set.project = project;
  // Made again from an API's spec: its mocks that nobody edited are replaced, so one the spec dropped goes
  // (and, for the first API, the ones made before specs were told apart, which have no API).
  if (options.replaceApis?.length) {
    set.endpoints = set.endpoints.filter((e) => e.edited || (e.source !== "spec" && e.source !== "generated") || (e.api === undefined ? !options.legacy : !options.replaceApis!.includes(e.api)));
  }
  let added = 0;
  let replaced = 0;
  let kept = 0;
  for (const m of made) {
    const i = set.endpoints.findIndex((x) => x.id === m.id);
    if (i < 0) {
      if (set.endpoints.length >= MOCK_ENDPOINTS_MAX) continue;
      set.endpoints.push(m);
      added++;
    } else if (set.endpoints[i].edited) kept++;
    else {
      set.endpoints[i] = { ...m, enabled: set.endpoints[i].enabled };
      replaced++;
    }
  }
  if (made.length) saveMocks(set);
  return { set, added, replaced, kept };
}

export function setMockMode(dir: string, project: string, mode: { on?: boolean; strict?: boolean; cache?: boolean }): MockSet {
  const set = loadMocks(dir, project);
  set.project = project;
  if (mode.on !== undefined) {
    if (mode.on && !set.endpoints.length)
      throw new MockError(`${project} has no mocks yet. Make them from its activity, its API spec, or turn on the cache first (dx mock make, the Activity page, or the Requests page).`);
    set.on = mode.on;
  }
  if (mode.strict !== undefined) set.strict = mode.strict;
  if (mode.cache !== undefined) set.cache = mode.cache || undefined;
  return saveMocks(set);
}

/** Removes the mocks from one source (the cache, say), or all of them; edited ones go too. */
export function purgeMocks(dir: string, source?: MockSource, api?: string): { set: MockSet; removed: number } {
  const set = loadMocks(dir);
  const before = set.endpoints.length;
  // One API's mocks (of one source, or all of them), or one source's, or everything.
  set.endpoints = api ? set.endpoints.filter((e) => e.api !== api || (source !== undefined && (e.source ?? "recorded") !== source)) : source ? set.endpoints.filter((e) => (e.source ?? "recorded") !== source) : [];
  if (!set.endpoints.length) set.on = false;
  saveMocks(set);
  return { set, removed: before - set.endpoints.length };
}

/** Whether an API spec's path template (/users/{id}/orders) fits a request's path. */
export function templateMatches(pattern: string, url: string): boolean {
  const p = pattern.split("?")[0].split("/");
  const t = (url.split("?")[0].split("#")[0] || "/").split("/");
  if (p.length !== t.length) return false;
  return p.every((seg, i) => {
    if (seg === t[i]) return true;
    if (!seg.includes("{")) return false;
    // {id}, or a part with one inside it: /files/{name}.json
    const re = new RegExp(`^${seg.split(/\{[^}]+\}/).map((x) => x.replace(/[.+?^${}()|[\]\\*]/g, "\\$&")).join("[^/]+")}$`);
    return re.test(t[i]);
  });
}

export interface MockPatch {
  status?: unknown;
  delayMs?: unknown;
  contentType?: unknown;
  body?: unknown;
  enabled?: unknown;
  offline?: unknown;
  preset?: unknown;
}

/** Changes one endpoint: status, delay, content type, body, on/off, or a preset. Every value is checked. */
export function updateMock(dir: string, id: string, patch: MockPatch): MockEndpoint {
  const set = loadMocks(dir);
  const ep = set.endpoints.find((e) => e.id === id);
  if (!ep) throw new MockError("That mock isn't there any more. Refresh the list.", 404);
  if (patch.preset !== undefined) {
    if (!MOCK_PRESETS.includes(patch.preset as MockPreset)) throw new MockError(`Presets: ${MOCK_PRESETS.join(", ")}.`);
    applyMockPreset(ep, patch.preset as MockPreset);
  }
  if (patch.status !== undefined) {
    const n = Number(patch.status);
    if (!Number.isInteger(n) || n < 100 || n > 599) throw new MockError("A status is a number from 100 to 599.");
    ep.status = n;
  }
  if (patch.delayMs !== undefined) {
    const n = Number(patch.delayMs);
    if (!Number.isFinite(n) || n < 0) throw new MockError("A delay is a number of milliseconds.");
    ep.delayMs = Math.min(MOCK_DELAY_MAX, Math.round(n));
  }
  if (patch.contentType !== undefined) {
    const t = String(patch.contentType).trim();
    if (!/^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w-]+=[^;\r\n]{1,100})*$/.test(t) || t.length > 200) throw new MockError("A content type looks like application/json.");
    ep.contentType = t;
  }
  if (patch.body !== undefined) {
    if (typeof patch.body !== "string") throw new MockError("The body is text.");
    if (Buffer.byteLength(patch.body) > MOCK_BODY_MAX) throw new MockError("A mock's body can be at most 1 MB.", 413);
    ep.body = patch.body;
  }
  if (patch.enabled !== undefined) ep.enabled = patch.enabled === true;
  if (patch.offline !== undefined) ep.offline = patch.offline === true || undefined;
  if (/json/i.test(ep.contentType) && ep.body.trim()) {
    try {
      JSON.parse(ep.body);
    } catch {
      throw new MockError("The body isn't valid JSON, and the content type says it is.");
    }
  }
  // Changing the answer marks it edited (so a new recording doesn't replace it); Reset unmarks it.
  const changed = (patch.preset !== undefined && patch.preset !== "reset") || [patch.status, patch.delayMs, patch.contentType, patch.body, patch.offline].some((v) => v !== undefined);
  if (changed) ep.edited = true;
  else if (patch.preset === "reset") delete ep.edited;
  ep.updatedAt = new Date().toISOString();
  saveMocks(set);
  return ep;
}

const CONTENT_TYPE = /^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w-]+=[^;\r\n]{1,100})*$/;
const MOCK_SOURCES: MockSource[] = ["recorded", "cache", "spec", "generated", "ai"];

/**
 * One endpoint read from a file (dx's state export from another computer): every field checked the
 * way an edit is, and unknown fields left out.
 */
export function cleanMockEndpoint(input: unknown): MockEndpoint {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MockError("A mock is an object.");
  const o = input as Record<string, unknown>;
  const text = (v: unknown, max: number, what: string): string => {
    if (typeof v !== "string" || v.length > max) throw new MockError(`A mock's ${what} isn't right.`);
    return v;
  };
  const opt = (v: unknown, max: number, what: string, pattern?: RegExp): string | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    const s = text(v, max, what);
    if (pattern && !pattern.test(s)) throw new MockError(`A mock's ${what} isn't right.`);
    return s;
  };
  const status = (v: unknown): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 100 || n > 599) throw new MockError("A mock's status is a number from 100 to 599.");
    return n;
  };
  const contentType = (v: unknown): string => {
    const t = text(v, 200, "content type").trim();
    if (!CONTENT_TYPE.test(t)) throw new MockError("A mock's content type looks like application/json.");
    return t;
  };
  const body = (v: unknown): string => {
    if (typeof v !== "string" || Buffer.byteLength(v) > MOCK_BODY_MAX) throw new MockError("A mock's body is text of at most 1 MB.");
    return v;
  };
  const id = text(o.id, 40, "id");
  if (!/^[a-z0-9]{6,40}$/.test(id)) throw new MockError("A mock's id isn't right.");
  const method = text(o.method, 10, "method").toUpperCase();
  if (!/^[A-Z]{3,10}$/.test(method)) throw new MockError("A mock's method isn't right.");
  const p = text(o.path, 2000, "path");
  if (!p.startsWith("/") || /[\r\n]/.test(p)) throw new MockError("A mock's path starts with /.");
  const delay = Number(o.delayMs ?? 0);
  const rec = o.recorded && typeof o.recorded === "object" ? (o.recorded as Record<string, unknown>) : undefined;
  const ep: MockEndpoint = {
    id,
    method,
    path: p,
    status: status(o.status),
    delayMs: Number.isFinite(delay) && delay > 0 ? Math.min(MOCK_DELAY_MAX, Math.round(delay)) : 0,
    contentType: contentType(o.contentType),
    body: body(o.body),
    enabled: o.enabled !== false,
    recorded: rec
      ? { status: status(rec.status), contentType: contentType(rec.contentType), body: body(rec.body), at: text(rec.at ?? "", 40, "date"), eventId: Number.isInteger(rec.eventId) ? (rec.eventId as number) : 0 }
      : { status: 200, contentType: "application/json", body: "", at: "", eventId: 0 },
    updatedAt: typeof o.updatedAt === "string" && o.updatedAt.length <= 40 ? o.updatedAt : new Date().toISOString(),
  };
  const query = opt(o.query, 2000, "query", /^\?[^\r\n]*$/);
  const bodyKey = opt(o.bodyKey, 64, "body key", /^[a-f0-9]+$/);
  const requestBody = opt(o.requestBody, 64 * 1024, "request body");
  const service = opt(o.service, 60, "service", /^[\w.-]+$/);
  const pattern = opt(o.pattern, 500, "path template", /^\/[^\r\n]*$/);
  const operation = opt(o.operation, 200, "name");
  const example = opt(o.example, 200, "example");
  const api = opt(o.api, 40, "API", /^[a-z0-9-]+$/);
  const apiName = opt(o.apiName, 60, "API name");
  Object.assign(ep, {
    ...(api ? { api } : {}),
    ...(api && apiName ? { apiName } : {}),
    ...(query ? { query } : {}),
    ...(bodyKey ? { bodyKey } : {}),
    ...(requestBody ? { requestBody } : {}),
    ...(service ? { service } : {}),
    ...(pattern ? { pattern } : {}),
    ...(operation ? { operation } : {}),
    ...(example ? { example } : {}),
    ...(o.offline === true ? { offline: true } : {}),
    ...(o.edited === true ? { edited: true } : {}),
    ...(MOCK_SOURCES.includes(o.source as MockSource) ? { source: o.source as MockSource } : {}),
  });
  if (/json/i.test(ep.contentType) && ep.body.trim()) {
    try {
      JSON.parse(ep.body);
    } catch {
      throw new MockError("A mock's body isn't valid JSON, and its content type says it is.");
    }
  }
  return ep;
}

/** Fail with 500, an empty list, slow (3 s), offline, or back to what was recorded. */
export function applyMockPreset(ep: MockEndpoint, preset: MockPreset): MockEndpoint {
  if (preset === "reset") {
    Object.assign(ep, { status: ep.recorded.status, contentType: ep.recorded.contentType, body: ep.recorded.body, delayMs: 0 });
    delete ep.offline;
  } else if (preset === "fail") {
    Object.assign(ep, { status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal Server Error (a dx mock)" }) });
    delete ep.offline;
  } else if (preset === "empty") {
    Object.assign(ep, { status: 200, contentType: "application/json", body: emptied(ep.body) });
    delete ep.offline;
  } else if (preset === "slow") {
    ep.delayMs = 3000;
  } else if (preset === "offline") {
    ep.offline = true;
  }
  return ep;
}

/** The body with its lists emptied: [] for a list, { items: [] } for an object holding one; [] otherwise. */
function emptied(body: string): string {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return "[]";
  }
  if (Array.isArray(v)) return "[]";
  if (v && typeof v === "object") {
    const o = { ...(v as Record<string, unknown>) };
    let changed = false;
    for (const [k, x] of Object.entries(o)) {
      if (Array.isArray(x)) ((o[k] = []), (changed = true));
      else if (/^(total|count|total_count|totalCount)$/.test(k) && typeof x === "number") o[k] = 0;
    }
    return changed ? JSON.stringify(o) : "[]";
  }
  return "[]";
}

export function removeMock(dir: string, id: string): MockSet {
  const set = loadMocks(dir);
  const before = set.endpoints.length;
  set.endpoints = set.endpoints.filter((e) => e.id !== id);
  if (set.endpoints.length === before) throw new MockError("That mock isn't there any more.", 404);
  if (!set.endpoints.length) set.on = false;
  return saveMocks(set);
}

export function clearMocks(dir: string): void {
  fs.rmSync(mockFile(dir), { force: true });
}

/** Whether any mock for this method and path tells calls apart by their body (so the body must be read first). */
export function mockNeedsBody(set: MockSet, method: string, url: string, service?: string): boolean {
  return candidates(set, method, url, service).some((e) => e.bodyKey);
}

function candidates(set: MockSet, method: string, url: string, service?: string): MockEndpoint[] {
  const m = method.toUpperCase();
  const p = foldPath(url);
  return set.endpoints.filter(
    (e) => e.enabled && e.method === m && (e.pattern ? templateMatches(e.pattern, url) : e.path === p) && (!e.service || !service || e.service === service),
  );
}

// Real answers beat an API spec's example, which beats data made up from its schema; Claude's data
// was asked for, so it counts as real. Anything edited by hand wins.
const SOURCE_RANK: Record<MockSource, number> = { generated: 0, spec: 1, recorded: 2, cache: 2, ai: 2 };

/** Which answer a caller asks for, as with Postman's mock servers: x-mock-response-code / -name. */
export interface MockWanted {
  code?: number;
  name?: string;
}

/**
 * The mock that answers a call: same method, and the same folded path or a spec template it fits.
 * Of those: the status or example the caller asked for; an exact path over a template; query and
 * body matching best (an exact match beats one recorded without them, which beats a different
 * one); edited, then real answers over made-up ones; the most recently changed on a tie.
 */
export function matchMock(
  set: MockSet,
  req: { method: string; url: string; body?: string; contentType?: string; service?: string },
  want: MockWanted = {},
): MockEndpoint | undefined {
  let list = candidates(set, req.method, req.url, req.service);
  if (want.code !== undefined) list = list.filter((e) => e.status === want.code);
  if (want.name) list = list.filter((e) => e.example === want.name || e.operation === want.name);
  if (!list.length) return undefined;
  const q = queryOf(req.url);
  const key = list.some((e) => e.bodyKey) ? bodyKeyOf(req.body, req.contentType ?? "") : undefined;
  const score = (e: MockEndpoint) =>
    (e.pattern ? 0 : 8) +
    (e.query === undefined ? 1 : e.query === q ? 2 : 0) +
    (e.bodyKey === undefined ? 1 : e.bodyKey === key ? 2 : 0) +
    (e.edited ? 4 : 0) +
    SOURCE_RANK[e.source ?? "recorded"] +
    // Without a code asked for, a success is the usual answer.
    (want.code === undefined && e.status < 400 ? 1 : 0);
  return [...list].sort((a, b) => score(b) - score(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}
