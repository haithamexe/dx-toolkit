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
}

export interface MockSet {
  format: "dx-mocks";
  version: 1;
  dir: string;
  project: string;
  /** Mock mode is on: matching API calls are answered from here. */
  on: boolean;
  /** Also answer API calls that have no mock with a 404, instead of passing them to the dev server. */
  strict: boolean;
  endpoints: MockEndpoint[];
  updatedAt: string;
}

export type MockPreset = "fail" | "empty" | "slow" | "offline" | "reset";
export const MOCK_PRESETS: MockPreset[] = ["fail", "empty", "slow", "offline", "reset"];

export const MOCK_BODY_MAX = 1024 * 1024;
export const MOCK_DELAY_MAX = 30_000;
export const MOCK_ENDPOINTS_MAX = 200;

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
    return { ...emptySet(dir, project), ...raw, on: raw.on === true, strict: raw.strict === true };
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
    (e) => e.type === "request" && (e.from === "proxy" || e.from === "check") && !e.mocked && !e.error && e.status !== undefined && !!e.url && e.url.startsWith("/") && !e.url.startsWith("/__dx/"),
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
export function addMocks(dir: string, project: string, events: ActivityEvent[]): { set: MockSet; added: number; replaced: number; kept: number } {
  const made = mocksFromActivity(events);
  const set = loadMocks(dir, project);
  set.project = project;
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

export function setMockMode(dir: string, project: string, mode: { on?: boolean; strict?: boolean }): MockSet {
  const set = loadMocks(dir, project);
  if (mode.on !== undefined) {
    if (mode.on && !set.endpoints.length) throw new MockError(`${project} has no mocks yet. Make them from its activity first (dx mock make, or the Activity page).`);
    set.on = mode.on;
  }
  if (mode.strict !== undefined) set.strict = mode.strict;
  return saveMocks(set);
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
  return set.endpoints.filter((e) => e.enabled && e.method === m && e.path === p && (!e.service || !service || e.service === service));
}

/**
 * The mock that answers a call: same method and folded path; of those, one whose query and body
 * match best (an exact match beats one recorded without them, which beats a different one), the
 * most recently changed on a tie. Undefined when none is for that path.
 */
export function matchMock(set: MockSet, req: { method: string; url: string; body?: string; contentType?: string; service?: string }): MockEndpoint | undefined {
  const list = candidates(set, req.method, req.url, req.service);
  if (!list.length) return undefined;
  const q = queryOf(req.url);
  const key = list.some((e) => e.bodyKey) ? bodyKeyOf(req.body, req.contentType ?? "") : undefined;
  const score = (e: MockEndpoint) => (e.query === undefined ? 1 : e.query === q ? 2 : 0) + (e.bodyKey === undefined ? 1 : e.bodyKey === key ? 2 : 0);
  return [...list].sort((a, b) => score(b) - score(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}
