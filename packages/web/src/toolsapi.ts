import fs from "node:fs";
import path from "node:path";
import {
  applyAnswerTool,
  columnValues,
  toolPathMatches,
  type RulePlan,
  AI_EFFORTS,
  AI_MODELS,
  aiCli,
  aiClis,
  aiFailure,
  alertSettings,
  askAi,
  cleanAiEffort,
  loadConfig,
  cleanAiModel,
  type AiEffort,
  bodyData,
  cleanTool,
  deleteTool,
  exportTools,
  fillTemplate,
  importTools,
  jsonFromAnswer,
  loadTools,
  matchesWatch,
  hideToolSecrets,
  restoreToolSecrets,
  matchesWhere,
  pathValue,
  readActivity,
  readToolBundle,
  recordedData,
  recordRun,
  runSteps,
  saveTool,
  toolContext,
  ToolError,
  toolPrompt,
  toolsFile,
  type ActivityEvent,
  type CustomTool,
  type Project,
  type ToolChatTurn,
} from "@dx/core";
import { flushActivity, recentActivity } from "./activity.js";
import { sendRequest, type SendResult } from "./apilab.js";
import { HttpError, knownProject, type ApiRequest } from "./api.js";
import { localRoutes, type LocalRoute } from "./dev.js";

/**
 * Custom tools on the Tools page: a project's own views, watches and operations, made in a chat
 * with Claude Code or Codex and then run by dx with no AI. Every tool goes through `cleanTool`
 * (core/customtools.ts), whether it comes from the AI, the page or an imported file; requests go
 * only to the project's own dev server, through the Repeater's sender.
 */

function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ToolError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

function routeOf(project: Project): LocalRoute {
  const all = [...localRoutes().values()].filter((r) => r.dir.toLowerCase() === project.dir.toLowerCase());
  const route = all.find((r) => !r.service) ?? all[0];
  if (!route) throw new HttpError(409, `${project.name}'s dev server isn't running in dx. Run it from its Overview first: this tool asks the dev server dx runs.`);
  return route;
}

/** A saved tool by its id, or a draft from the page (checked like any other). */
function toolOf(project: Project, body: Record<string, unknown>): CustomTool {
  if (typeof body.id === "string" && body.tool === undefined) {
    const t = loadTools(project.dir).find((x) => x.id === body.id);
    if (!t) throw new HttpError(404, "That tool isn't there any more. Refresh the page.");
    return t;
  }
  return call(() => cleanTool(body.tool));
}

const HIDDEN = "•••";
const PATH_OK = (p: string) => p.startsWith("/") && !p.startsWith("//") && !/[\s\r\n\\]/.test(p);

/** The answer, clipped for the page: a list of at most 1000, a text of at most 1 MB. */
function clip(v: unknown): unknown {
  if (Array.isArray(v)) return v.slice(0, 1000);
  if (typeof v === "string") return v.slice(0, 1024 * 1024);
  return v;
}

function events(dir: string, since: Date): ActivityEvent[] {
  flushActivity();
  return readActivity({ dir, since, limit: 20_000 });
}

async function runView(project: Project, tool: CustomTool) {
  const src = tool.source!;
  let data: unknown;
  let meta: { status?: number; ms?: number; error?: string; at?: string } = {};
  if ("request" in src) {
    const r = src.request;
    const hidden = Object.entries(r.headers ?? {}).find(([, v]) => v.includes(HIDDEN));
    if (hidden) throw new HttpError(400, `dx hid the value of ${hidden[0]} when it recorded it. Type the real value into the tool, or take the header out.`);
    const res: SendResult = await sendRequest({ route: routeOf(project), method: r.method, path: r.path, headers: r.headers ?? {}, body: r.body });
    meta = { status: res.status, ms: res.ms, error: res.error, at: res.at };
    if (res.error) return { kind: "view", meta, data: undefined, display: tool.display };
    data = bodyData(res.responseBody);
  } else {
    data = recordedData(events(project.dir, new Date(Date.now() - 7 * 86_400_000)), src.recorded);
    if (data === undefined || (Array.isArray(data) && !data.length)) meta = { error: `Nothing recorded for ${src.recorded.method ?? ""} ${src.recorded.path} in the last 7 days. Use the app through dx and it fills in.`.replace("  ", " ") };
  }
  const shaped = clip(runSteps(data, tool.steps));
  // Each row's tone (danger, warn, ok) from the display's highlights, worked out here with the same conditions as the steps.
  const d = tool.display;
  const highlight = d && (d.as === "table" || d.as === "cards") ? d.highlight : undefined;
  const tones = highlight && Array.isArray(shaped) ? shaped.map((row) => highlight.find((x) => matchesWhere(x.when, row))?.tone ?? null) : undefined;
  return { kind: "view", meta, data: shaped, display: tool.display, ...(tones ? { tones } : {}) };
}

function runWatch(project: Project, tool: CustomTool, sinceRaw: unknown) {
  const since = typeof sinceRaw === "string" && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw) : new Date(Date.now() - 86_400_000);
  const hits = events(project.dir, since).filter((e) => matchesWatch(tool.match!, e)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const hour = Date.now() - 3_600_000;
  return {
    kind: "watch",
    count: hits.length,
    lastHour: hits.filter((e) => Date.parse(e.at) >= hour).length,
    matches: hits.slice(0, 50).map((e) => ({ id: e.id, at: e.at, type: e.type, method: e.method, url: e.url, status: e.status, ms: e.ms, text: e.text.slice(0, 300) })),
  };
}

/**
 * An answer tool on an answer it would change, before and after. A GET to a plain path is asked of
 * the dev server; otherwise the latest recorded answer no tool changed (the history holds answers
 * as the app got them).
 */
async function previewAnswer(project: Project, tool: CustomTool) {
  const t = tool.target!;
  const plain = (t.method ?? "GET") === "GET" && !/[*{}:]/.test(t.path);
  const running = [...localRoutes().values()].some((r) => r.dir.toLowerCase() === project.dir.toLowerCase());
  let before: unknown;
  if (plain && running) {
    const res = await sendRequest({ route: routeOf(project), method: "GET", path: t.path, headers: { accept: "application/json" } });
    before = res.error ? undefined : bodyData(res.responseBody);
  } else
    before = recordedData(
      events(project.dir, new Date(Date.now() - 7 * 86_400_000)).filter((e) => !e.rules?.some((r) => r.startsWith("tool: "))),
      { method: t.method, path: t.path },
    );
  if (before === undefined) return { kind: "answer", note: `Nothing recorded for ${t.method ?? ""} ${t.path} in the last 7 days. Use the app through dx and the preview fills in.`.replace("  ", " ") };
  const after = applyAnswerTool(JSON.parse(JSON.stringify(before)), tool);
  return { kind: "answer", before: clip(before), after: clip(after) };
}

/** A page tool's changes as they'd show: each panel's, section's and column's data, worked out here. */
async function previewPage(project: Project, tool: CustomTool) {
  const out: { type: string; title?: string; data?: unknown; display?: unknown; tones?: unknown; note?: string }[] = [];
  for (const c of tool.changes ?? []) {
    if ("highlight" in c) out.push({ type: "highlight", note: `Marks ${c.highlight.selector}${c.highlight.text ? ` containing "${c.highlight.text}"` : ""} (${c.highlight.tone}).` });
    else if ("hide" in c) out.push({ type: "hide", note: `Hides ${c.hide.selector}.` });
    else {
      const part = "panel" in c ? c.panel : "section" in c ? c.section : { ...c.column, display: { as: "table" as const } };
      try {
        const r = await runView(project, { id: tool.id, name: tool.name, kind: "view", source: part.source, steps: part.steps, display: part.display });
        out.push({ type: "panel" in c ? "panel" : "section" in c ? "section" : "column", title: "panel" in c ? c.panel.title : "section" in c ? c.section.title : c.column.header, data: r.data, display: r.display, tones: r.tones, note: r.meta?.error });
      } catch (err) {
        out.push({ type: "panel" in c ? "panel" : "section", note: (err as Error).message });
      }
    }
  }
  return { kind: "page", path: tool.path, changes: out };
}

// ------------------------------------------------------------------ tools in the proxy and on the app's pages

const toolCache = new Map<string, { sig: string; tools: CustomTool[] }>();
/** A project's tools, read again only when its tools file changes (the proxy asks on every call); a save here forgets them at once. */
function cachedTools(dir: string): CustomTool[] {
  let sig = "";
  try {
    const st = fs.statSync(toolsFile(dir));
    sig = `${st.mtimeMs}:${st.size}`;
  } catch {
    return [];
  }
  const key = dir.toLowerCase();
  const c = toolCache.get(key);
  if (c && c.sig === sig) return c.tools;
  const tools = loadTools(dir);
  toolCache.set(key, { sig, tools });
  return tools;
}

/** The answer tools that change this call (API calls only: never page loads or dx's own paths). */
export function answerToolsFor(req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }, route: LocalRoute): NonNullable<RulePlan["answerTools"]> {
  const url = req.url ?? "/";
  const m = (req.method ?? "GET").toUpperCase();
  if (url.startsWith("/__dx/") || req.headers.upgrade || (m === "GET" && /text\/html/i.test(String(req.headers.accept ?? "")))) return [];
  return cachedTools(route.dir)
    .filter((t) => t.kind === "answer" && !t.off && (!t.target!.method || t.target!.method === m) && toolPathMatches(t.target!.path, url))
    .map((t) => ({ name: t.name, at: t.at, set: t.set, remove: t.remove }));
}

/** Adds answer tools to the call's plan (or makes one): the answer is read whole, changed, and sent on. */
export function withAnswerTools(plan: RulePlan | undefined, tools: NonNullable<RulePlan["answerTools"]>): RulePlan {
  const p: RulePlan = plan ?? { rules: [], delayMs: 0, interceptRequest: false, interceptResponse: false, request: [], response: [], needsRequestBody: false, needsResponseBody: false };
  p.answerTools = tools;
  p.needsResponseBody = true;
  return p;
}

/** What the page script gets: the project's page tools that are on, their changes without their sources (data comes from dx). */
export function pageToolsFor(route: LocalRoute): { id: string; name: string; path: string; changes: unknown[] }[] {
  return cachedTools(route.dir)
    .filter((t) => t.kind === "page" && !t.off)
    .map((t) => ({
      id: t.id,
      name: t.name,
      path: t.path!,
      changes: t.changes!.map((c) => {
        if ("panel" in c) return { panel: { title: c.panel.title } };
        if ("section" in c) return { section: { title: c.section.title, at: c.section.at, place: c.section.place ?? "after" } };
        if ("column" in c) return { column: { table: c.column.table, header: c.column.header, key: c.column.key, value: c.column.value, format: c.column.format } };
        return c;
      }),
    }));
}

/** The data for one change of a page tool, asked for by the page script at /__dx/tools/<id>/<n>: run here, on the dev server dx runs. */
export async function pageToolData(route: LocalRoute, id: string, n: number): Promise<unknown> {
  const t = cachedTools(route.dir).find((x) => x.id === id && x.kind === "page" && !x.off);
  const c = t?.changes?.[n];
  if (!t || !c || "highlight" in c || "hide" in c) return undefined;
  const part = "panel" in c ? c.panel : "section" in c ? c.section : { ...c.column, display: { as: "table" as const } };
  const project = { name: path.basename(route.dir), dir: route.dir } as Project;
  return runView(project, { id: t.id, name: t.name, kind: "view", source: part.source, steps: part.steps, display: part.display });
}

const MAX_SENT = 200;

async function runOperation(project: Project, tool: CustomTool, rawInputs: unknown) {
  const route = routeOf(project);
  const vars: Record<string, string> = {};
  for (const i of tool.inputs ?? []) vars[i.name] = i.default ?? "";
  if (rawInputs && typeof rawInputs === "object" && !Array.isArray(rawInputs)) {
    for (const i of tool.inputs ?? []) {
      const v = (rawInputs as Record<string, unknown>)[i.name];
      if (v !== undefined) vars[i.name] = String(v).slice(0, 2000);
    }
  }
  const steps: { name: string; method: string; path: string; status?: number; ms: number; error?: string; body?: string; ok: boolean }[] = [];
  let sent = 0;
  let stopped: string | undefined;
  outer: for (const [n, r] of (tool.requests ?? []).entries()) {
    const label = r.name ?? `Request ${n + 1}`;
    let times = 1;
    if (r.repeat !== undefined) {
      times = typeof r.repeat === "number" ? r.repeat : Number(fillTemplate(r.repeat, vars));
      if (!Number.isInteger(times) || times < 1 || times > 50) {
        stopped = `${label}: repeat came to "${typeof r.repeat === "number" ? r.repeat : fillTemplate(r.repeat, vars)}", but it has to be a whole number from 1 to 50.`;
        break;
      }
    }
    for (let i = 1; i <= times; i++) {
      if (++sent > MAX_SENT) {
        stopped = `An operation sends at most ${MAX_SENT} requests.`;
        break outer;
      }
      const v = { ...vars, i: String(i), now: String(Date.now()) };
      const p = fillTemplate(r.path, v);
      if (!PATH_OK(p)) {
        stopped = `${label}: the path came to "${p.slice(0, 200)}", which isn't a path on the app.`;
        break outer;
      }
      const headers: Record<string, string> = {};
      for (const [k, raw] of Object.entries(r.headers ?? {})) {
        const value = fillTemplate(raw, v);
        if (/[\r\n]/.test(value)) {
          stopped = `${label}: the header ${k} came to a value that can't be sent.`;
          break outer;
        }
        headers[k] = value;
      }
      const hidden = Object.entries(headers).find(([, x]) => x.includes(HIDDEN));
      if (hidden) {
        stopped = `${label}: dx hid the value of ${hidden[0]} when it recorded it. Put the real value in the tool.`;
        break outer;
      }
      const body = r.body === undefined ? undefined : fillTemplate(r.body, v);
      const res = await sendRequest({ route, method: r.method, path: p, headers, body });
      const ok = !res.error && (r.expect === undefined ? res.status !== undefined && res.status < 400 : res.status === r.expect);
      steps.push({ name: times > 1 ? `${label} (${i} of ${times})` : label, method: r.method, path: p, status: res.status, ms: res.ms, error: res.error, body: res.responseBody?.slice(0, 4000), ok });
      if (r.save && res.responseBody !== undefined) {
        const data = bodyData(res.responseBody);
        for (const [name, at] of Object.entries(r.save)) {
          const got = pathValue(data, at);
          if (got !== undefined && got !== null) vars[name] = typeof got === "object" ? JSON.stringify(got) : String(got);
        }
      }
      if (r.expect !== undefined && !ok) {
        stopped = `${label} answered ${res.error ?? res.status}, not ${r.expect}: the rest wasn't sent.`;
        break outer;
      }
    }
  }
  return { kind: "operation", ok: !stopped && steps.every((s) => s.ok), stopped, steps };
}

function historyOf(raw: unknown): ToolChatTurn[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 40) throw new HttpError(400, "The conversation is a list of turns.");
  return raw.map((t) => {
    const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
    if ((o.role !== "user" && o.role !== "assistant") || typeof o.text !== "string") throw new HttpError(400, "Each turn has a role and a text.");
    return { role: o.role, text: o.text };
  });
}

/** Asks the agent for the tool, once, and once more with what was wrong if its answer doesn't fit the format. */
async function chat(project: Project, body: Record<string, unknown>) {
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) throw new HttpError(400, "Say what the tool should do.");
  const history = historyOf(body.history);
  const current = body.tool === undefined || body.tool === null ? undefined : call(() => cleanTool(body.tool));
  // Which agent, model and effort: chosen on the page, checked here; each goes to the CLI as one fixed argument.
  if (body.agent !== undefined && body.agent !== "claude" && body.agent !== "codex") throw new HttpError(400, "The agent is Claude Code or Codex.");
  let model: string | undefined;
  let effort: AiEffort | undefined;
  try {
    model = cleanAiModel(body.model);
    effort = cleanAiEffort(body.effort);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const cli = await aiCli(body.agent as "claude" | "codex" | undefined);
  if (!cli) throw new HttpError(409, body.agent ? `${body.agent === "codex" ? "Codex" : "Claude Code"} isn't installed.` : "Making a tool in a chat needs Claude Code or Codex installed and signed in. You can still write one by hand.");
  const context = toolContext(project.dir);
  // The tool so far goes to the agent without its credential headers' values; they're put back in its answer.
  const hidden = current ? hideToolSecrets(current) : undefined;
  let problem: string | undefined;
  let reply = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await askAi(cli, toolPrompt({ project: project.name, context, current: hidden?.shown, history, message, problem }), { model, effort, free: { cwd: project.dir } });
    if (r.code !== 0 || r.timedOut) throw new HttpError(502, aiFailure(r, `${cli.name} didn't answer`));
    let answer: Record<string, unknown>;
    try {
      const parsed = jsonFromAnswer(r.text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      answer = parsed as Record<string, unknown>;
    } catch {
      problem = "it wasn't one JSON object";
      continue;
    }
    reply = typeof answer.reply === "string" ? answer.reply.slice(0, 2000) : "";
    if (answer.tool === undefined || answer.tool === null) return { reply: reply || "Tell me a bit more.", by: cli.name };
    try {
      return { reply, tool: restoreToolSecrets(cleanTool({ ...(answer.tool as object), id: current?.id }), hidden?.kept), by: cli.name };
    } catch (err) {
      problem = (err as Error).message;
    }
  }
  return { reply: reply || `${cli.name}'s tool didn't fit the format.`, problem, by: cli.name };
}

export const toolRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/tools": async (req) => {
    const project = knownProject(req.query.get("dir"));
    const running = [...localRoutes().values()].some((r) => r.dir.toLowerCase() === project.dir.toLowerCase());
    // The agents on this computer (the configured one first), each with model names to offer, and the effort levels.
    const agents = (await aiClis()).map((c) => ({ id: c.tool, name: c.name, models: AI_MODELS[c.tool] }));
    return { tools: loadTools(project.dir), running, agents, efforts: AI_EFFORTS };
  },
  // A tool written or edited by hand, checked without saving or running it.
  "POST /api/tools/check": (req) => {
    knownProject(req.body.dir);
    return call(() => cleanTool(req.body.tool));
  },
  // For the toasts on every page: what the project's watches with `toast` matched since a moment (from memory).
  // Watches with toasts, for events after the newest id the page has seen (ids are arrival order;
  // an event's time is when its request started, so a slow one can be older than one already shown).
  // Without an id, the page is told where things stand now.
  "GET /api/tools/alerts": (req) => {
    const project = knownProject(req.query.get("dir"));
    const recent = recentActivity(Date.now() - 600_000);
    const last = recent.reduce((n, e) => Math.max(n, e.id), 0);
    const after = Number(req.query.get("after"));
    if (!req.query.get("after") || !Number.isFinite(after) || !alertSettings(project.dir, loadConfig()).on) return { alerts: [], last };
    const watches = loadTools(project.dir).filter((t) => t.kind === "watch" && t.alert?.toast);
    const alerts: { tool: string; text: string; at: string; id: number }[] = [];
    for (const e of recent) {
      if (e.id <= after || e.dir.toLowerCase() !== project.dir.toLowerCase()) continue;
      for (const w of watches) if (matchesWatch(w.match!, e)) alerts.push({ tool: w.name, text: eventLine(e), at: e.at, id: e.id });
    }
    return { alerts: alerts.sort((a, b) => a.id - b.id).slice(-20), last };
  },
  "POST /api/tools/save": (req) => {
    const project = knownProject(req.body.dir);
    const saved = call(() => saveTool(project.dir, req.body.tool));
    forgetAlertTools();
    recordRun("tool", true, `${project.name}: saved the ${saved.kind} "${saved.name}"`, "web", { project: project.name });
    return saved;
  },
  "POST /api/tools/delete": (req) => {
    const project = knownProject(req.body.dir);
    const gone = call(() => deleteTool(project.dir, String(req.body.id ?? "")));
    forgetAlertTools();
    recordRun("tool", true, `${project.name}: deleted "${gone.name}"`, "web", { project: project.name });
    return { ok: true };
  },
  // Runs a saved tool by id, or the draft being made (checked like any tool): no AI, ever.
  "POST /api/tools/run": async (req) => {
    const project = knownProject(req.body.dir);
    const tool = toolOf(project, req.body);
    if (tool.kind === "view") return runView(project, tool);
    if (tool.kind === "watch") return runWatch(project, tool, req.body.since);
    if (tool.kind === "answer") return previewAnswer(project, tool);
    if (tool.kind === "page") return previewPage(project, tool);
    if (tool.kind === "column") return { kind: "column", label: tool.label, format: tool.format, rows: columnValues(tool, events(project.dir, new Date(Date.now() - 7 * 86_400_000))) };
    const r = await runOperation(project, tool, req.body.inputs);
    recordRun("tool", r.ok, `${project.name}: ran "${tool.name}", ${r.steps.length} request${r.steps.length === 1 ? "" : "s"}${r.stopped ? ", stopped" : ""}`, "web", { project: project.name });
    return r;
  },
  // One turn of the chat: dx builds the prompt (the format, the project's spec and recorded calls, the conversation); only the JSON tool in the answer is used.
  "POST /api/tools/chat": async (req) => {
    const project = knownProject(req.body.dir);
    const r = await chat(project, req.body);
    recordRun("tool-chat", !r.problem, `${project.name}: ${r.by} ${r.tool ? `drafted "${r.tool.name}"` : r.problem ? "answered with a tool that didn't fit" : "asked a question"}`, "web", { project: project.name });
    return r;
  },
  "GET /api/tools/export": (req) => {
    const project = knownProject(req.query.get("dir"));
    return exportTools(project.dir, project.name);
  },
  // An imported file is read strictly and shown before anything is kept.
  "POST /api/tools/import/check": (req) => {
    const project = knownProject(req.body.dir);
    const bundle = call(() => readToolBundle(req.body.file));
    const have = loadTools(project.dir);
    return {
      project: bundle.project,
      tools: bundle.tools.map((t, i) => ({ index: i, name: t.name, kind: t.kind, description: t.description, conflict: have.some((x) => x.name.toLowerCase() === t.name.toLowerCase()) })),
    };
  },
  "POST /api/tools/import": (req) => {
    const project = knownProject(req.body.dir);
    const bundle = call(() => readToolBundle(req.body.file));
    const pick = Array.isArray(req.body.pick) ? req.body.pick.filter((n): n is number => Number.isInteger(n)) : undefined;
    const r = call(() => importTools(project.dir, bundle.tools, { pick, replace: req.body.replace === true }));
    forgetAlertTools();
    recordRun("tool", true, `${project.name}: imported ${r.added + r.replaced} tool${r.added + r.replaced === 1 ? "" : "s"}${r.replaced ? ` (${r.replaced} replaced)` : ""}`, "web", { project: project.name });
    return r;
  },
};

// ------------------------------------------------------------------ watches on Floppy's line

const alertTools = new Map<string, { mtime: number; watches: CustomTool[] }>();
export function forgetAlertTools(): void {
  alertTools.clear();
  toolCache.clear();
}

/** A project's watches that show on Floppy's line, read again only when its tools file changes. */
function floppyWatches(dir: string): CustomTool[] {
  let mtime = 0;
  try {
    mtime = fs.statSync(toolsFile(dir)).mtimeMs;
  } catch {
    return [];
  }
  const key = dir.toLowerCase();
  const cached = alertTools.get(key);
  if (cached && cached.mtime === mtime) return cached.watches;
  const watches = loadTools(dir).filter((t) => t.kind === "watch" && t.alert?.floppy);
  alertTools.set(key, { mtime, watches });
  return watches;
}

/** The newest event of the last two minutes a watch with `floppy` matched, for Floppy's line. */
export function toolAlert(): { key: string; project: string; tool: string; text: string; at: string } | undefined {
  const recent = recentActivity(Date.now() - 120_000);
  const config = loadConfig();
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (e.dir.startsWith("site:") || !alertSettings(e.dir, config).on) continue;
    for (const w of floppyWatches(e.dir)) {
      if (!matchesWatch(w.match!, e)) continue;
      return { key: `${w.id}|${e.id}`, project: e.project, tool: w.name, text: eventLine(e), at: e.at };
    }
  }
  return undefined;
}

/** An event in one short line: "POST /api/checkout → 500", or the first line of a message. */
function eventLine(e: ActivityEvent): string {
  return e.type === "request" || e.type === "page" ? `${(e.method ?? "GET").toUpperCase()} ${(e.url ?? "").replace(/^https?:\/\/[^/]+/, "").split("?")[0]} → ${e.error ?? e.status ?? "?"}` : e.text.split("\n")[0].slice(0, 120);
}
