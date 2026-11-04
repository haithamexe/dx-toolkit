import os from "node:os";
import { ACTIVITY_TYPES, byTime, readActivity, type ActivityEvent, type ActivityType } from "./activity.js";
import { replayFromVisit, reportContext } from "./activityReport.js";
import { isLoopbackUrl, type PageCheck, type PageStep } from "./browser.js";
import type { DevError } from "./devErrors.js";
import { gitRoot, gitRun } from "./git.js";
import { foldPath } from "./mocks.js";
import { maskBody, maskHeaders, maskText, maskUrl } from "./mask.js";
import { commitAt } from "./snapshots.js";

/**
 * A bug a teammate can replay: one `.dxbug.json` file with the visit's steps, what happened
 * (requests with their masked payloads and answers, console, errors), the error itself and the
 * commit it happened at. It carries no host: on import the steps run against the importer's own
 * dev server for the project, and the bundle is checked field by field before anything runs.
 */

export const BUG_FORMAT = "dx-bug";
export const BUG_VERSION = 1;
/** The largest bundle taken, as JSON text. */
export const BUG_MAX_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 500;
const MAX_STEPS = 50;
const MAX_BODY = 32 * 1024;

/** What one event keeps in a bundle: no folder, no host, nothing that names this computer. */
export interface BugEvent {
  id: number;
  at: string;
  type: ActivityType;
  text: string;
  level?: ActivityEvent["level"];
  service?: string;
  page?: string;
  url?: string;
  method?: string;
  status?: number;
  ms?: number;
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  truncated?: boolean;
  target?: string;
  source?: string;
  stack?: string;
  from?: ActivityEvent["from"];
  visit?: string;
  mocked?: boolean;
}

export interface BugBundle {
  format: typeof BUG_FORMAT;
  version: typeof BUG_VERSION;
  createdAt: string;
  project: { name: string };
  /** The commit HEAD was on when it happened (or HEAD at export when that isn't known), and the state of the working copy at export. */
  git?: { commit: string; branch?: string; dirty: boolean; from: "reflog" | "history" | "head" };
  /** Where on the dev server: the page the visit started on (the replay's start) and the page the error was on. Paths only. */
  dev: { start: string; page?: string; service?: string };
  steps: PageStep[];
  /** What can't be done again, in words. */
  notes: string[];
  error: BugEvent;
  events: BugEvent[];
}

export class BugBundleError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ export

export interface BundleContext {
  projectName: string;
  /** The project's folder, made relative in stacks and messages. */
  projectDir: string;
  /** The user's home folder, made ~ (defaults to this computer's). */
  home?: string;
  git?: BugBundle["git"];
  steps?: PageStep[];
  start?: string;
  notes?: string[];
  now?: Date;
}

/** The bundle for one error and the events around it. Pure: everything it needs is passed in. */
export function buildBugBundle(target: ActivityEvent, events: ActivityEvent[], ctx: BundleContext): BugBundle {
  const strip = pathStripper(ctx.projectDir, ctx.home ?? os.homedir());
  const list = byTime([...events.filter((e) => e.id !== target.id), target]).slice(-MAX_EVENTS);
  const page = target.page ?? list.find((e) => e.page)?.page;
  const start = ctx.start ?? page ?? "/";
  return {
    format: BUG_FORMAT,
    version: BUG_VERSION,
    createdAt: (ctx.now ?? new Date()).toISOString(),
    project: { name: ctx.projectName.slice(0, 200) },
    git: ctx.git,
    dev: { start: pathOnly(maskUrl(start)), page: page ? pathOnly(maskUrl(page)) : undefined, service: target.service },
    steps: (ctx.steps ?? []).slice(0, MAX_STEPS).map((s) => cleanStep(s, strip)),
    notes: (ctx.notes ?? []).slice(0, 20),
    error: bugEvent(target, strip),
    events: list.map((e) => bugEvent(e, strip)),
  };
}

/**
 * The bundle for event `id` of a project's history: the visit's steps, the events around it,
 * and the commit HEAD was on at that moment (HEAD now when git can't say).
 */
export async function exportBugBundle(project: { name: string; dir: string; hasGit?: boolean }, id: number): Promise<BugBundle> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new BugBundleError("Which event? Give its id.");
  const { target, events } = reportContext(project.dir, id);
  if (!target) throw new BugBundleError("That event isn't in the history any more.", 404);
  const at = Date.parse(target.at);
  let steps: PageStep[] = [];
  let start: string | undefined;
  let notes: string[] = [];
  if (target.visit) {
    const visit = readActivity({ dir: project.dir, since: new Date(at - 60 * 60_000), until: new Date(at + 60_000), limit: 5000 }).filter((e) => e.visit === target.visit);
    const replay = replayFromVisit(visit);
    if (replay) {
      steps = replay.steps;
      notes = [...replay.notes];
      start = replay.url;
    }
  }
  const git = project.hasGit === false ? undefined : await gitState(project.dir, at);
  if (git?.dirty) notes.push("The working copy had changes that weren't committed when this was exported, so what ran may differ from the commit.");
  if (!steps.length) notes.push("No clicks were recorded before it, so a replay only loads the page.");
  return buildBugBundle(target, events, { projectName: project.name, projectDir: project.dir, git, steps, start, notes });
}

async function gitState(dir: string, at: number): Promise<BugBundle["git"] | undefined> {
  let root: string;
  try {
    root = await gitRoot(dir);
  } catch {
    return undefined;
  }
  let commit: string | undefined;
  let from: "reflog" | "history" | "head" = "head";
  try {
    const c = await commitAt(dir, at);
    if (c) ((commit = c.hash), (from = c.from));
  } catch {
    // no history to read: HEAD below
  }
  if (!commit) {
    const head = await gitRun(root, ["rev-parse", "HEAD"]);
    if (head.code !== 0) return undefined;
    commit = head.stdout.trim();
  }
  const [branch, status] = await Promise.all([gitRun(root, ["rev-parse", "--abbrev-ref", "HEAD"]), gitRun(root, ["status", "--porcelain"])]);
  const b = branch.code === 0 ? branch.stdout.trim() : "";
  return { commit, branch: b && b !== "HEAD" ? b : undefined, dirty: status.code === 0 && status.stdout.trim() !== "", from };
}

/** A safe file name for a bundle: shop-website-abc1234-20261104-1530.dxbug.json */
export function bugBundleFileName(b: BugBundle): string {
  const d = new Date(b.createdAt);
  const p = (n: number) => String(n).padStart(2, "0");
  const name = b.project.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "project";
  return `${name}${b.git ? `-${b.git.commit.slice(0, 7)}` : ""}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.dxbug.json`;
}

const SAFE_HEADERS = new Set(["content-type", "content-length", "content-encoding", "accept", "cache-control", "etag", "last-modified", "allow", "retry-after", "x-dx-mock"]);

function bugEvent(e: ActivityEvent | BugEvent, strip: (s: string) => string): BugEvent {
  const s = (v: string | undefined, max = 8000) => (v === undefined ? undefined : strip(maskText(v)).slice(0, max));
  const reqType = e.requestHeaders?.["content-type"] ?? "";
  const resType = e.responseHeaders?.["content-type"] ?? "";
  const out: BugEvent = {
    id: e.id,
    at: e.at,
    type: e.type,
    text: s(e.text) ?? "",
    level: e.level,
    service: e.service,
    page: e.page !== undefined ? pathOnly(strip(maskUrl(e.page))) : undefined,
    url: e.url !== undefined ? strip(maskUrl(e.url)).slice(0, 2000) : undefined,
    method: e.method,
    status: e.status,
    ms: e.ms,
    error: s(e.error, 300),
    requestHeaders: headers(e.requestHeaders, strip),
    responseHeaders: headers(e.responseHeaders, strip),
    // Masked when recorded; masked again here in case a rule was added since.
    requestBody: e.requestBody !== undefined ? strip(maskBody(e.requestBody, reqType)).slice(0, MAX_BODY) : undefined,
    responseBody: e.responseBody !== undefined ? strip(maskBody(e.responseBody, resType)).slice(0, MAX_BODY) : undefined,
    truncated: e.truncated,
    target: e.target?.slice(0, 300),
    source: s(e.source, 500),
    stack: s(e.stack),
    from: e.from,
    visit: e.visit?.slice(0, 40),
    mocked: (e as BugEvent).mocked,
  };
  for (const k of Object.keys(out) as (keyof BugEvent)[]) if (out[k] === undefined) delete out[k];
  return out;
}

function headers(h: Record<string, string> | undefined, strip: (s: string) => string): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(maskHeaders(h))) if (SAFE_HEADERS.has(k)) out[k] = strip(v).slice(0, 500);
  return Object.keys(out).length ? out : undefined;
}

function cleanStep(s: PageStep, strip: (s: string) => string): PageStep {
  const out: PageStep = {};
  if (s.goto !== undefined) out.goto = pathOnly(strip(s.goto));
  if (s.click !== undefined) out.click = s.click.slice(0, 500);
  if (s.type !== undefined) out.type = s.type.slice(0, 500);
  if (s.into !== undefined) out.into = s.into.slice(0, 500);
  if (s.press !== undefined) out.press = s.press.slice(0, 40);
  if (s.waitFor !== undefined) out.waitFor = strip(s.waitFor).slice(0, 500);
  if (s.timeoutMs !== undefined) out.timeoutMs = s.timeoutMs;
  return out;
}

/** "http://shop.localhost:1355/cart?x=1#a" → "/cart?x=1#a"; a path stays as it is. */
function pathOnly(raw: string): string {
  try {
    const u = new URL(raw, "http://same.origin");
    return `${u.pathname}${u.search}${u.hash}`.replace(/%E2%80%A2/g, "•").slice(0, 2000) || "/";
  } catch {
    return "/";
  }
}

const LOOPBACK_ORIGIN = /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|[\w.-]+\.localhost)(?::\d+)?/gi;

/**
 * Makes text say nothing about this computer: the project's folder becomes project-relative
 * (also as a file:// address and with JSON's doubled backslashes), the home folder `~`, any other
 * user folder `~`, and addresses on this computer lose their host and port.
 */
export function pathStripper(projectDir: string, home = os.homedir()): (s: string) => string {
  const variants = (p: string) => {
    const fwd = p.replace(/\\/g, "/").replace(/\/+$/, "");
    const back = fwd.replace(/\//g, "\\");
    return [...new Set([`file:///${fwd.replace(/^\//, "")}`, `file://${fwd}`, fwd, back, back.replace(/\\/g, "\\\\")])].filter((v) => v.length > 3);
  };
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = (paths: string[], to: string, sep: boolean) =>
    paths.length ? { re: new RegExp(`(?:${paths.sort((a, b) => b.length - a.length).map(escape).join("|")})${sep ? "(?:\\\\\\\\|[\\\\/])" : "(?=[\\\\/\"'\\s:)]|$)"}`, "gi"), to } : undefined;
  const rules = [rule(variants(projectDir), "", true), rule(variants(projectDir), ".", false), rule(home ? variants(home) : [], "~", false)].filter((r): r is { re: RegExp; to: string } => !!r);
  return (s) => {
    let out = s;
    for (const r of rules) out = out.replace(r.re, r.to);
    return out
      .replace(LOOPBACK_ORIGIN, "")
      .replace(/\b[A-Za-z]:(?:\\\\|[\\/])(?:Users|Documents and Settings)(?:\\\\|[\\/])[^\\/"'\s:]+/g, "~")
      .replace(/(^|[\s"'(=:])\/(?:Users|home)\/[^/"'\s:]+/g, "$1~");
  };
}

// ------------------------------------------------------------------ import

const TOP_KEYS = new Set(["format", "version", "createdAt", "project", "git", "dev", "steps", "notes", "error", "events"]);
const STEP_KEYS = new Set(["goto", "click", "type", "into", "press", "waitFor", "timeoutMs"]);
const EVENT_STRINGS: (keyof BugEvent)[] = ["text", "service", "page", "url", "method", "error", "requestBody", "responseBody", "target", "source", "stack", "visit"];
const LEVELS = new Set(["log", "info", "warn", "error", "debug"]);
const FROMS = new Set(["proxy", "browser", "server", "check", "dx-browser"]);

/**
 * A bundle from a file, checked strictly: the format and version, its size, only the fields a
 * bundle has, a commit that is a hex hash, steps with only the fields a page check takes, and
 * addresses as paths: a step's address on another computer is refused, one on a loopback
 * address keeps only its path, so the importer's own dev server is what's reached.
 */
export function readBugBundle(raw: unknown): BugBundle {
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw) > BUG_MAX_BYTES) throw new BugBundleError(`That bundle is too large (over ${BUG_MAX_BYTES / 1024 / 1024} MB).`, 413);
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new BugBundleError("That file isn't a dx bug bundle (it isn't JSON).");
    }
  } else if (Buffer.byteLength(JSON.stringify(raw ?? null)) > BUG_MAX_BYTES) {
    throw new BugBundleError(`That bundle is too large (over ${BUG_MAX_BYTES / 1024 / 1024} MB).`, 413);
  }
  const b = obj(raw, "The bundle");
  if (b.format !== BUG_FORMAT) throw new BugBundleError("That file isn't a dx bug bundle (format isn't dx-bug).");
  if (b.version !== BUG_VERSION) throw new BugBundleError(`This dx reads bug bundles of version ${BUG_VERSION}; that one is version ${String(b.version)}. Update dx.`);
  for (const k of Object.keys(b)) if (!TOP_KEYS.has(k)) throw new BugBundleError(`A bug bundle has no field "${k.slice(0, 40)}".`);
  const project = obj(b.project, "project");
  const name = str(project.name, 200);
  if (!name) throw new BugBundleError("The bundle doesn't say which project it's from.");

  let git: BugBundle["git"];
  if (b.git !== undefined && b.git !== null) {
    const g = obj(b.git, "git");
    for (const k of Object.keys(g)) if (!["commit", "branch", "dirty", "from"].includes(k)) throw new BugBundleError(`git has no field "${k.slice(0, 40)}".`);
    if (typeof g.commit !== "string" || !/^[0-9a-f]{4,64}$/i.test(g.commit)) throw new BugBundleError("The bundle's commit isn't a commit hash (4 to 40 hex characters).");
    const from = g.from === "reflog" || g.from === "history" ? g.from : "head";
    git = { commit: g.commit.toLowerCase(), branch: str(g.branch, 200) || undefined, dirty: g.dirty === true, from };
  }

  const dev = obj(b.dev ?? {}, "dev");
  const start = localPath(dev.start ?? "/", "The page the bundle starts on");
  const page = dev.page === undefined ? undefined : localPath(dev.page, "The page the error was on");

  if (!Array.isArray(b.steps ?? [])) throw new BugBundleError("steps must be a list.");
  const rawSteps = (b.steps ?? []) as unknown[];
  if (rawSteps.length > MAX_STEPS) throw new BugBundleError(`A bundle has at most ${MAX_STEPS} steps.`);
  const steps = rawSteps.map((x, i) => readStep(x, i + 1));

  if (!Array.isArray(b.events ?? [])) throw new BugBundleError("events must be a list.");
  const rawEvents = (b.events ?? []) as unknown[];
  if (rawEvents.length > MAX_EVENTS) throw new BugBundleError(`A bundle has at most ${MAX_EVENTS} events.`);
  const error = readEvent(b.error, "error");
  const events = rawEvents.map((e, i) => readEvent(e, `event ${i + 1}`));
  const notes = Array.isArray(b.notes) ? b.notes.slice(0, 20).map((n) => str(n, 500)).filter(Boolean) : [];
  const createdAt = typeof b.createdAt === "string" && !Number.isNaN(Date.parse(b.createdAt)) ? new Date(b.createdAt).toISOString() : new Date().toISOString();
  return { format: BUG_FORMAT, version: BUG_VERSION, createdAt, project: { name }, git, dev: { start, page, service: str(dev.service, 100) || undefined }, steps, notes, error, events };
}

function readStep(x: unknown, n: number): PageStep {
  const o = obj(x, `Step ${n}`);
  for (const k of Object.keys(o)) if (!STEP_KEYS.has(k)) throw new BugBundleError(`Step ${n} has a field a replay doesn't take: "${k.slice(0, 40)}".`);
  const s: PageStep = {};
  if (o.goto !== undefined) s.goto = localPath(o.goto, `Step ${n}'s address`);
  for (const k of ["click", "type", "into", "waitFor"] as const) if (o[k] !== undefined) s[k] = strict(o[k], 500, `Step ${n}'s ${k}`);
  if (o.press !== undefined) s.press = strict(o.press, 40, `Step ${n}'s key`);
  if (o.timeoutMs !== undefined) {
    if (typeof o.timeoutMs !== "number" || !Number.isFinite(o.timeoutMs)) throw new BugBundleError(`Step ${n}'s timeoutMs must be a number.`);
    s.timeoutMs = Math.min(60_000, Math.max(500, Math.round(o.timeoutMs)));
  }
  if (!Object.keys(s).length) throw new BugBundleError(`Step ${n} doesn't say what to do.`);
  return s;
}

function readEvent(x: unknown, what: string): BugEvent {
  const o = obj(x, what);
  const type = o.type;
  if (typeof type !== "string" || !(ACTIVITY_TYPES as string[]).includes(type)) throw new BugBundleError(`The bundle's ${what} isn't a kind of event dx records.`);
  const e: BugEvent = { id: Number.isSafeInteger(o.id) ? (o.id as number) : 0, at: typeof o.at === "string" && !Number.isNaN(Date.parse(o.at)) ? new Date(o.at).toISOString() : new Date(0).toISOString(), type: type as ActivityType, text: "" };
  const max: Partial<Record<keyof BugEvent, number>> = { requestBody: MAX_BODY, responseBody: MAX_BODY, stack: 8000, text: 8000, url: 2000, page: 2000 };
  for (const k of EVENT_STRINGS) if (typeof o[k] === "string") (e as unknown as Record<string, string>)[k] = maskText((o[k] as string).slice(0, max[k] ?? 500));
  e.text ||= type;
  if (e.page !== undefined) e.page = pathOnly(e.page);
  if (e.url !== undefined) e.url = maskUrl(e.url);
  // Bodies masked again on the way in: whatever the file says, nothing credential-like is kept.
  const reqType = typeof (o.requestHeaders as Record<string, unknown> | undefined)?.["content-type"] === "string" ? String((o.requestHeaders as Record<string, unknown>)["content-type"]) : "";
  const resType = typeof (o.responseHeaders as Record<string, unknown> | undefined)?.["content-type"] === "string" ? String((o.responseHeaders as Record<string, unknown>)["content-type"]) : "";
  if (e.requestBody !== undefined) e.requestBody = maskBody(e.requestBody, reqType);
  if (e.responseBody !== undefined) e.responseBody = maskBody(e.responseBody, resType);
  if (typeof o.level === "string" && LEVELS.has(o.level)) e.level = o.level as BugEvent["level"];
  if (typeof o.from === "string" && FROMS.has(o.from)) e.from = o.from as BugEvent["from"];
  for (const k of ["status", "ms"] as const) if (typeof o[k] === "number" && Number.isFinite(o[k])) e[k] = Math.round(o[k] as number);
  if (o.truncated === true) e.truncated = true;
  if (o.mocked === true) e.mocked = true;
  for (const k of ["requestHeaders", "responseHeaders"] as const) {
    const h = o[k];
    if (!h || typeof h !== "object" || Array.isArray(h)) continue;
    const out: Record<string, string> = {};
    for (const [name, v] of Object.entries(h as Record<string, unknown>).slice(0, 50)) if (typeof v === "string" && SAFE_HEADERS.has(name.toLowerCase())) out[name.toLowerCase()] = v.slice(0, 500);
    if (Object.keys(out).length) e[k] = out;
  }
  return e;
}

/** A path on the importer's dev server. A loopback address keeps only its path; any other host is refused. */
function localPath(v: unknown, what: string): string {
  if (typeof v !== "string" || !v || v.length > 2000) throw new BugBundleError(`${what} must be a path like /cart.`);
  if (/^[a-z][\w+.-]*:/i.test(v) || v.startsWith("//")) {
    if (!isLoopbackUrl(v)) throw new BugBundleError(`${what} is on another computer (${v.slice(0, 80)}). Bundles only replay on your own dev server.`);
    return pathOnly(v);
  }
  if (!v.startsWith("/")) throw new BugBundleError(`${what} must start with /.`);
  return pathOnly(v);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BugBundleError(`${what} must be an object.`);
  return v as Record<string, unknown>;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function strict(v: unknown, max: number, what: string): string {
  if (typeof v !== "string" || v.length > max) throw new BugBundleError(`${what} must be text of at most ${max} characters.`);
  return v;
}

/** The address to replay a bundle at: its start path on `base` (the importer's dev server), never anywhere else. */
export function bundleUrl(base: string, b: Pick<BugBundle, "dev">): string {
  const root = new URL(base);
  const url = new URL(b.dev.start, root);
  if (url.origin !== root.origin || !isLoopbackUrl(url.href)) throw new BugBundleError("The replay can only open the project's own dev server.");
  return url.href;
}

// ------------------------------------------------------------------ comparing

export interface ReplayVerdict {
  reproduced: boolean;
  /** "Reproduced: same error at src/cart.js:12", "Not reproduced: 2 other problems". */
  summary: string;
  /** The problem found now that matches the original, in words. */
  match?: { text: string; source?: string };
  /** Every problem the replay found, in words. */
  now: string[];
}

/** Whether a replay ran into the bundle's error again: the same message (numbers aside), or the same file and line. */
export function compareReplay(original: BugEvent, page: PageCheck | undefined, serverErrors: DevError[] = []): ReplayVerdict {
  const found: { text: string; source?: string; kind: "browser" | "request" | "server" }[] = [];
  for (const m of [...(page?.exceptions ?? []), ...(page?.consoleErrors ?? [])]) found.push({ text: m.text, source: m.source, kind: "browser" });
  for (const f of page?.failedRequests ?? []) found.push({ text: `${(f.method ?? "GET").toUpperCase()} ${f.url} → ${f.status ?? f.error ?? "failed"}`, kind: "request" });
  for (const e of serverErrors) found.push({ text: e.message, source: e.file ? `${e.file}${e.line ? `:${e.line}` : ""}` : undefined, kind: "server" });
  if (page?.overlay) found.push({ text: page.overlay.split("\n")[0], kind: "browser" });
  const now = found.map((f) => `${f.text.split("\n")[0].slice(0, 300)}${f.source ? ` (${stripOrigin(f.source)})` : ""}`);

  const want = message(original.text);
  const wantAt = place(original.source);
  const wantRequest = original.type === "request" || original.type === "page" ? requestKey(original.method, original.url, original.status ?? original.error) : undefined;
  const match = found.find((f) => {
    if (wantRequest) return f.kind === "request" && requestKey(f.text.split(" ")[0], f.text.split(" ")[1], f.text.split(" → ")[1]) === wantRequest;
    const got = message(f.text);
    if (want && got && (got === want || got.includes(want) || want.includes(got))) return true;
    return !!wantAt && place(f.source) === wantAt;
  });
  const at = wantAt ?? place(match?.source);
  if (match) return { reproduced: true, summary: `Reproduced: the same error${at ? ` at ${at}` : ""}`, match: { text: match.text.split("\n")[0], source: match.source && stripOrigin(match.source) }, now };
  if (page?.error) return { reproduced: false, summary: `Not reproduced: the page didn't load (${page.error})`, now };
  return { reproduced: false, summary: found.length ? `Not reproduced: ${found.length} other problem${found.length === 1 ? "" : "s"} this time` : "Not reproduced: no problems this time", now };
}

function message(text: string | undefined): string {
  return stripOrigin(String(text ?? "").split("\n")[0])
    .replace(/^(uncaught\s+(\(in promise\)\s+)?)/i, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** "http://localhost:5173/src/cart.js?t=123:12:5" → "src/cart.js:12" */
function place(source: string | undefined): string | undefined {
  // dx's own recorder script is never where an app's error is.
  if (!source || source.includes("/__dx/")) return undefined;
  const m = /^(.*?)(?:\?[^:]*)?:(\d+)(?::\d+)?$/.exec(stripOrigin(source.trim()));
  if (!m) return undefined;
  return `${m[1].replace(/^[./\\]+/, "").replace(/\\/g, "/")}:${m[2]}`;
}

function requestKey(method: string | undefined, url: string | undefined, status: unknown): string {
  let p = stripOrigin(String(url ?? ""));
  try {
    p = new URL(p, "http://same.origin").pathname;
  } catch {
    // as it is
  }
  return `${String(method ?? "GET").toUpperCase()} ${foldPath(p)} ${String(status ?? "")}`;
}

function stripOrigin(s: string): string {
  return s.replace(LOOPBACK_ORIGIN, "");
}
