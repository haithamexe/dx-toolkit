import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  addJournalEntry,
  auditDependencies,
  buildSummary,
  checkEnv,
  cloneProject,
  commandExists,
  findUnsavedWork,
  fixDependencies,
  leaveNote,
  sessionLookup,
  runTests,
  buildYearReview,
  formatYearReview,
  saveYearReview,
  connectAiTools,
  copyProject,
  deleteCleanup,
  detectStack,
  disconnectAiTools,
  expandHome,
  findCleanup,
  formatSummary,
  isValidProjectName,
  killPort,
  listAiTools,
  listListeningPorts,
  listTemplates,
  loadConfig,
  openFileInEditor,
  openInEditor,
  openTerminal,
  openUrl,
  readJournal,
  readProject,
  readRuns,
  recordRun,
  revealInFileManager,
  runDoctor,
  saveAsTemplate,
  saveConfig,
  saveSummary,
  scanProjects,
  ACTIVITY_TYPES,
  clearActivity,
  activityUsage,
  bugReport,
  DAY_LIMIT_BYTES,
  isLoopbackUrl,
  readActivity,
  replayFromVisit,
  reportContext,
  type Replay,
  listTerminals,
  parseSince,
  terminalIds,
  type ActivityType,
  type AiToolId,
  type DepsReport,
  type PageStep,
  type Project,
  type Source,
} from "@dx/core";
import { activitySettings, flushActivity, forgetActivitySettings, forgetRecentActivity, listActivity } from "./activity.js";
import { checkUrl } from "./check.js";
import { clearTraffic, listTraffic } from "./traffic.js";
import {
  clearDevServer,
  devErrors,
  devLogs,
  listDevServers,
  restartDevServer,
  startDevServer,
  stopDevServer,
  waitForDevServer,
  type StartedBy,
} from "./dev.js";

/** A request the page made, already parsed. */
export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (req: ApiRequest) => Promise<unknown> | unknown;

const routes: Record<string, Handler> = {
  "GET /api/ping": () => ({ ok: true, pid: process.pid }),

  // ------------------------------------------------------------ projects
  "GET /api/projects": () => {
    const running = new Map(listDevServers().map((d) => [d.dir.toLowerCase(), d]));
    const sessionOf = sessionLookup();
    return scanProjects(loadConfig()).map((p) => {
      const stack = detectStack(p);
      const s = sessionOf(p.dir);
      return {
      session: s && { at: s.at, branch: s.branch, note: s.note, noteBy: s.noteBy, noteAt: s.noteAt },
      name: p.name,
      dir: p.dir,
      kind: p.kind,
      packageManager: p.packageManager,
      devCommand: p.devCommand,
      url: p.url,
      hasGit: p.hasGit,
      lastActive: p.lastActive,
      dev: running.get(p.dir.toLowerCase()),
      stack: stack && { source: stack.source, services: stack.services.map((s) => ({ name: s.name, role: s.role, kind: s.kind, command: s.command })) },
    };
    });
  },

  "POST /api/projects/open": async (req) => {
    const project = knownProject(req.body.dir);
    const config = loadConfig();
    const action = String(req.body.action);
    if (action === "editor") {
      const editor = project.editor ?? config.editor;
      await openInEditor(project.dir, editor);
      recordRun("go", true, project.name, "web", { project: project.name });
      return { message: `Opened ${project.name} in ${editor}` };
    }
    if (action === "browser") {
      const url = String(req.body.url || project.url || "");
      if (!url) throw new HttpError(400, `${project.name} has no URL. Start its dev server first, or set "url" in .devrc.json.`);
      await openUrl(url);
      return { message: `Opened ${url}` };
    }
    if (action === "folder") {
      await revealInFileManager(project.dir);
      return { message: `Showed ${project.name} in the file manager` };
    }
    if (action === "terminal") {
      if (!project.devCommand) throw new HttpError(400, `${project.name} has no dev command.`);
      const command = (await commandExists("dx")) ? "dx go . --no-editor" : project.devCommand;
      const used = await openTerminal(project.dir, command, project.name);
      recordRun("go", true, project.name, "web", { project: project.name });
      return { message: `Started ${project.devCommand} in a new ${used} window` };
    }
    if (action === "shell") {
      // Just a terminal in the project's folder, in the terminal picked in settings (or this one).
      const terminal = typeof req.body.terminal === "string" && terminalIds().includes(req.body.terminal) ? req.body.terminal : undefined;
      const used = await openTerminal(project.dir, undefined, project.name, terminal);
      recordRun("terminal", true, `${project.name} in ${used}`, "web", { project: project.name });
      return { message: `Opened ${project.name} in ${used}` };
    }
    throw new HttpError(400, `Unknown action: ${action}`);
  },
  "GET /api/terminals": () => listTerminals(),

  // ------------------------------------------------------------ dev servers
  "POST /api/note": (req) => {
    const project = knownProject(req.body.dir);
    const s = leaveNote(project.dir, project.name, String(req.body.note ?? ""), "you");
    recordRun("resume", true, `${project.name}: note ${s.note ? "left" : "removed"}`, "web", { project: project.name });
    return { note: s.note ?? null };
  },
  "GET /api/traffic": (req) => {
    const q = req.query;
    const dir = q.get("dir") ? knownProject(q.get("dir")).dir : undefined;
    return listTraffic({
      dir,
      service: q.get("service") || undefined,
      after: q.get("after") ? Number(q.get("after")) : undefined,
      all: q.get("all") === "1",
      failed: q.get("failed") === "1",
      path: q.get("path") || undefined,
      limit: clampInt(q.get("limit"), 1, 1000, 200),
    });
  },
  "POST /api/traffic/clear": (req) => {
    clearTraffic(knownProject(req.body.dir).dir);
    return { ok: true };
  },
  "GET /api/activity": (req) => {
    const q = req.query;
    const since = q.get("since") ? parseSince(q.get("since")!) : undefined;
    if (q.get("since") && !since) throw new HttpError(400, "since takes 30m, 2h, 3d, today, yesterday or a date.");
    return listActivity({
      dir: q.get("dir") ? knownProject(q.get("dir")).dir : undefined,
      types: (q.get("types") ?? "")
        .split(",")
        .filter((t): t is ActivityType => (ACTIVITY_TYPES as string[]).includes(t)),
      problems: q.get("problems") === "1",
      after: q.get("after") ? clampInt(q.get("after"), 0, Number.MAX_SAFE_INTEGER, 0) : undefined,
      since,
      search: q.get("q") || undefined,
      limit: clampInt(q.get("limit"), 1, 2000, 200),
    });
  },
  "GET /api/activity/usage": () => {
    const s = activitySettings();
    return { ...activityUsage(), maxBytes: s.maxBytes, dayLimitBytes: DAY_LIMIT_BYTES, days: s.days, on: s.on };
  },
  "GET /api/activity/report": (req) => {
    const project = knownProject(req.query.get("dir"));
    const id = Number(req.query.get("id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "Which event? Give its id.");
    flushActivity();
    const { target, events } = reportContext(project.dir, id);
    if (!target) throw new HttpError(404, "That event isn't in the history any more.");
    return { title: target.text.split("\n")[0], markdown: bugReport(target, events) };
  },
  "POST /api/activity/replay": async (req) => {
    const project = knownProject(req.body.dir);
    const visit = typeof req.body.visit === "string" ? req.body.visit.slice(0, 40) : "";
    if (!visit) throw new HttpError(400, "Which visit? Give its id.");
    const replay = replayOf(project.dir, visit);
    const result = await checkUrl({ url: replay.url, browser: true, steps: replay.steps, timeoutMs: 60_000 });
    // The replay worked when every step could be done; what it found on the page is the detail.
    const page = result.page;
    const done = !!page && !page.error && (page.steps ?? []).every((s) => s.ok);
    const found = page ? page.exceptions.length + page.consoleErrors.length + page.failedRequests.length : 0;
    recordRun("replay", done, `${project.name}: replayed ${replay.steps.length} step(s)${found ? `, ${found} problem(s) on the page` : ", no problems"}`, "web", { project: project.name });
    return { replay, result };
  },
  "POST /api/activity/clear": (req) => {
    const dir = req.body.dir === undefined ? undefined : knownProject(req.body.dir).dir;
    forgetRecentActivity(dir);
    clearActivity(dir);
    recordRun("activity", true, dir ? `${path.basename(dir)}: history cleared` : "all history cleared", "web");
    return { ok: true };
  },
  "POST /api/tests": (req) =>
    runTests(knownProject(req.body.dir), {
      match: typeof req.body.match === "string" && req.body.match ? req.body.match : undefined,
      changed: req.body.changed === true,
      source: "web",
    }),
  "GET /api/env": (req) => checkEnv(knownProject(req.query.get("dir")).dir),
  "GET /api/unsaved": () => findUnsavedWork(),
  "POST /api/clone": async (req) => {
    const url = String(req.body.url ?? "");
    const name = typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim() : undefined;
    // Only a git address gets through (normalizeGitUrl), and git gets it as one argument after "--".
    try {
      return await cloneProject({ url, name, install: req.body.install !== false, source: "web" });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  },

  "GET /api/dev": () => listDevServers(),
  "POST /api/dev/start": (req) => startDevServer(knownProject(req.body.dir), startedBy(req.body.by)),
  "POST /api/dev/restart": (req) => restartDevServer(knownProject(req.body.dir), startedBy(req.body.by)),
  "GET /api/dev/errors": (req) =>
    devErrors(req.query.get("dir") || undefined, {
      all: req.query.get("all") === "1",
      after: req.query.get("after") ? Number(req.query.get("after")) : undefined,
    }),
  "POST /api/dev/wait": (req) =>
    waitForDevServer(String(req.body.dir ?? ""), {
      after: req.body.after === undefined ? undefined : Number(req.body.after),
      until: req.body.until === "ready" ? "ready" : "quiet",
      quietMs: clampInt(req.body.quietMs, 200, 10_000, 1000),
      settleMs: clampInt(req.body.settleMs, 0, 30_000, 4000),
      timeoutMs: clampInt(req.body.timeoutMs, 1000, 120_000, 60_000),
    }),
  "POST /api/check": async (req) => {
    let url = typeof req.body.url === "string" ? req.body.url : "";
    if (!url) {
      const project = knownProject(req.body.dir);
      const dev = listDevServers().find((s) => s.dir.toLowerCase() === project.dir.toLowerCase());
      // A browser check goes through the local domain when there is one, so its requests are logged.
      const base = (req.body.browser === true || Array.isArray(req.body.steps) ? dev?.localUrl : undefined) ?? dev?.url ?? project.url;
      if (!base) throw new HttpError(400, `${project.name} has no URL yet. Start its dev server first.`);
      url = new URL(String(req.body.path ?? "/"), base).href;
    }
    try {
      return await checkUrl({
        url,
        method: typeof req.body.method === "string" ? req.body.method : undefined,
        headers: req.body.headers && typeof req.body.headers === "object" ? (req.body.headers as Record<string, string>) : undefined,
        body: typeof req.body.body === "string" ? req.body.body : req.body.body === undefined ? undefined : JSON.stringify(req.body.body),
        timeoutMs: clampInt(req.body.timeoutMs, 500, 120_000, req.body.browser === true ? 30_000 : 15_000),
        browser: req.body.browser === true || Array.isArray(req.body.steps),
        steps: stepsOf(req.body.steps),
        screenshot: req.body.screenshot === true,
      });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  },
  "POST /api/open-file": async (req) => {
    const project = knownProject(req.body.dir);
    const raw = String(req.body.file ?? "");
    const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    // The project's folder, and for a stack the folders its services run in (another repository, say).
    const roots = [project.dir, ...(detectStack(project)?.services.map((s) => s.dir) ?? [])];
    const inside = (p: string) => roots.some((r) => norm(p).startsWith(norm(r) + path.sep));
    // Dev servers print paths absolute, relative to their folder, or from its root ("/src/App.tsx").
    const candidates = roots.flatMap((r) => [path.resolve(r, raw), path.resolve(r, raw.replace(/^[\\/]+/, ""))]);
    const file = candidates.find((p) => inside(p) && fs.existsSync(p));
    if (!file) {
      if (!candidates.some(inside)) throw new HttpError(400, "Only files inside the project can be opened.");
      throw new HttpError(404, `${raw} doesn't exist in ${project.name}.`);
    }
    const line = req.body.line ? clampInt(req.body.line, 1, 10_000_000, 1) : undefined;
    const column = req.body.column ? clampInt(req.body.column, 1, 100_000, 1) : undefined;
    await openFileInEditor(file, line, column, project.editor ?? loadConfig().editor);
    return { message: `Opened ${path.basename(file)}${line ? `:${line}` : ""}` };
  },
  "POST /api/dev/stop": async (req) => (await stopDevServer(String(req.body.dir))) ?? null,
  "POST /api/dev/clear": (req) => {
    clearDevServer(String(req.body.dir));
    return { ok: true };
  },
  "GET /api/dev/logs": (req) => devLogs(String(req.query.get("dir") ?? ""), Number(req.query.get("after") ?? 0)),

  // ------------------------------------------------------------ ports
  "GET /api/ports": async (req) => {
    const all = req.query.get("all") === "1";
    const entries = await listListeningPorts();
    return all ? entries : entries.filter((e) => e.port >= 1024 && !e.system);
  },
  "POST /api/ports/kill": async (req) => {
    const port = Number(req.body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "Not a valid port.");
    const { entries, results } = await killPort(port);
    if (entries.length === 0) return { ok: true, message: `Nothing was listening on port ${port}.` };
    const ok = results.every((r) => r.ok);
    recordRun("port.kill", ok, `port ${port}: ${results.map((r) => r.message).join("; ")}`, "web");
    if (!ok) throw new HttpError(500, results.map((r) => r.message).join(" "));
    return { ok, message: results.map((r) => r.message).join(" ") };
  },

  // ------------------------------------------------------------ journal
  "GET /api/journal": (req) => readJournal({ sinceDays: clampInt(req.query.get("days"), 1, 3660, 7) }),
  "POST /api/journal": (req) => {
    const text = String(req.body.text ?? "");
    if (!text.trim()) throw new HttpError(400, "Nothing to log: the entry is empty.");
    const entry = addJournalEntry(text);
    recordRun("log", true, undefined, "web");
    return entry;
  },

  // ------------------------------------------------------------ summary
  "GET /api/summary": async (req) => {
    const summary = await buildSummary({
      days: clampInt(req.query.get("days"), 1, 366, 7),
      allAuthors: req.query.get("allAuthors") === "1",
      github: req.query.get("github") !== "0",
    });
    return { summary, markdown: formatSummary(summary) };
  },
  "GET /api/summary/year": async (req) => {
    const year = clampInt(req.query.get("year"), 1990, new Date().getFullYear(), new Date().getFullYear());
    const review = await buildYearReview(year, { allAuthors: req.query.get("allAuthors") === "1", github: req.query.get("github") !== "0" });
    const markdown = formatYearReview(review);
    if (req.query.get("save") === "1") saveYearReview(markdown, year);
    return { year, commits: review.commits, activeDays: review.activeDays, projects: review.projects.length, markdown };
  },
  "POST /api/summary/save": async (req) => {
    const summary = await buildSummary({
      days: clampInt(req.body.days, 1, 366, 7),
      allAuthors: req.body.allAuthors === true,
      github: req.body.github !== false,
    });
    const file = saveSummary(formatSummary(summary), summary);
    recordRun("summary", true, `saved from the dashboard: ${file}`, "web");
    return { file };
  },

  // ------------------------------------------------------------ cleanup
  "GET /api/cleanup": (req) => findCleanup({ days: clampInt(req.query.get("days"), 0, 3650, 30) }),
  "POST /api/cleanup/delete": async (req) => {
    // Never trust paths from the page: scan again and delete only what the scan still offers.
    const wanted = new Set((Array.isArray(req.body.dirs) ? req.body.dirs : []).map((d) => String(d).toLowerCase()));
    const scan = await findCleanup({ days: clampInt(req.body.days, 0, 3650, 30) });
    const items = scan.items.filter((i) => wanted.has(i.dir.toLowerCase()));
    if (items.length === 0) throw new HttpError(400, "Nothing to delete: those folders aren't in the cleanup list any more.");
    const results = await deleteCleanup(items);
    const freed = results.reduce((n, r) => n + r.bytes, 0);
    const failed = results.filter((r) => !r.ok);
    recordRun("clean", failed.length === 0, `${freed} bytes freed from the dashboard, ${failed.length} failed`, "web");
    return { freed, deleted: results.length - failed.length, failed };
  },

  // ------------------------------------------------------------ dependencies
  "GET /api/deps": () => depsJob,
  "POST /api/deps/run": (req) => {
    if (depsJob.running) return depsJob;
    const activeDays = req.body.activeDays === undefined || req.body.activeDays === "" ? undefined : clampInt(req.body.activeDays, 1, 3650, 30);
    depsJob = { running: true, done: 0, total: 0, current: "", startedAt: new Date().toISOString(), activeDays };
    auditDependencies({
      activeDays,
      onProgress: (done, total, current) => Object.assign(depsJob, { done, total, current }),
    }).then(
      (reports) => {
        depsJob = { ...depsJob, running: false, reports, finishedAt: new Date().toISOString(), current: "" };
        const vulnerable = reports.filter((r) => (r.vulnerabilities?.total ?? 0) > 0).length;
        recordRun("deps", true, `${reports.length} checked, ${vulnerable} vulnerable (dashboard)`, "web");
      },
      (err: Error) => {
        depsJob = { ...depsJob, running: false, error: err.message, finishedAt: new Date().toISOString() };
        recordRun("deps", false, err.message, "web");
      },
    );
    return depsJob;
  },
  "POST /api/deps/fix": async (req) => {
    const project = knownProject(req.body.dir);
    const r = await fixDependencies(project);
    recordRun("deps", r.ok, `${project.name} fixed (dashboard)`, "web", { project: project.name });
    // Swap the fresh report into the last run, so the page shows the new numbers.
    if (r.after && depsJob.reports) depsJob.reports = depsJob.reports.map((x) => (x.dir === project.dir ? r.after! : x));
    return r;
  },

  // ------------------------------------------------------------ new project
  "GET /api/templates": () => ({
    templates: listTemplates(loadConfig()).map((t) => t.name),
    projects: scanProjects(loadConfig()).map((p) => ({ name: p.name, dir: p.dir })),
    roots: loadConfig().projectsRoots,
  }),
  "POST /api/new": async (req) => {
    const config = loadConfig();
    const name = String(req.body.name ?? "").trim();
    if (!isValidProjectName(name)) throw new HttpError(400, "Use lowercase letters, digits, - _ or . for the name, e.g. my-app.");
    const source = sourceFrom(req.body.source);
    const parent = req.body.in ? path.resolve(expandHome(String(req.body.in))) : config.projectsRoots[0];
    if (!parent) throw new HttpError(400, "No projects folder is set. Add one on the Health page.");
    const dest = path.join(parent, name);
    if (fs.existsSync(dest)) throw new HttpError(400, `${dest} already exists. Pick another name.`);

    const steps: string[] = [];
    const result = copyProject(source, dest, name);
    steps.push(`Copied ${result.files} files from ${source.kind} ${source.name}`);
    if (req.body.git !== false) {
      steps.push((await run("git", ["init", "-q"], dest)) ? "Created a git repository" : "Couldn't create a git repository");
    }
    const project = readProject(dest);
    if (req.body.install !== false && project?.kind === "node") {
      const pm = project.packageManager ?? "npm";
      const code = await shell(`${pm} install`, dest);
      steps.push(code === 0 ? `Installed packages with ${pm}` : `${pm} install exited with ${code}; run it again in the project`);
    }
    if (req.body.open !== false) {
      await openInEditor(dest, project?.editor ?? config.editor).then(
        () => steps.push(`Opened in ${config.editor}`),
        (err: Error) => steps.push(`Couldn't open the editor: ${err.message}`),
      );
    }
    recordRun("new", true, `${name} from ${source.kind} ${source.name} (dashboard)`, "web", { project: name });
    return { dir: dest, name, steps };
  },
  "POST /api/templates/save": (req) => {
    const project = knownProject(req.body.dir);
    const name = String(req.body.name ?? "").trim();
    if (!isValidProjectName(name)) throw new HttpError(400, "Use lowercase letters, digits, - _ or . for the template name.");
    const result = saveAsTemplate({ kind: "project", name: project.name, dir: project.dir }, name);
    recordRun("new.template", true, `${project.name} → ${name} (dashboard)`, "web");
    return { name, files: result.files, dir: result.dir };
  },

  // ------------------------------------------------------------ AI tools
  "GET /api/ai-tools": () => listAiTools(),
  "POST /api/ai-tools/connect": (req) => connectAiTools(aiIds(req.body.ids)),
  "POST /api/ai-tools/disconnect": (req) => disconnectAiTools(aiIds(req.body.ids)),

  // ------------------------------------------------------------ health and settings
  "GET /api/health": async () => ({
    checks: await runDoctor(),
    runs: readRuns(50).reverse(),
    config: loadConfig(),
  }),
  "POST /api/config": (req) => {
    const config = loadConfig();
    if (typeof req.body.editor === "string") {
      const editor = req.body.editor.trim();
      if (!editor) throw new HttpError(400, "The editor command can't be empty, e.g. code or cursor.");
      config.editor = editor;
    }
    if (typeof req.body.githubUser === "string") {
      const user = req.body.githubUser.trim().replace(/^@/, "");
      if (user && !/^[A-Za-z0-9-]{1,39}$/.test(user)) throw new HttpError(400, "That isn't a valid GitHub username.");
      config.githubUser = user || undefined;
    }
    if (typeof req.body.addRoot === "string" && req.body.addRoot.trim()) {
      const abs = path.resolve(expandHome(req.body.addRoot.trim()));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new HttpError(400, `Folder not found: ${abs}`);
      if (!config.projectsRoots.some((r) => r.toLowerCase() === abs.toLowerCase())) config.projectsRoots.push(abs);
    }
    if (typeof req.body.removeRoot === "string") {
      config.projectsRoots = config.projectsRoots.filter((r) => r !== req.body.removeRoot);
    }
    if (req.body.scanDepth !== undefined) config.scanDepth = clampInt(req.body.scanDepth, 1, 5, config.scanDepth);
    if (typeof req.body.terminal === "string") {
      if (req.body.terminal && !terminalIds().includes(req.body.terminal)) throw new HttpError(400, `Unknown terminal: ${req.body.terminal}.`);
      config.terminal = req.body.terminal || undefined;
    }
    if (typeof req.body.activity === "boolean") config.activity = req.body.activity;
    if (req.body.activityDays !== undefined) config.activityDays = clampInt(req.body.activityDays, 1, 365, config.activityDays ?? 7);
    if (req.body.activityMaxMB !== undefined) config.activityMaxMB = clampInt(req.body.activityMaxMB, 50, 100_000, config.activityMaxMB ?? 500);
    saveConfig(config);
    forgetActivitySettings();
    return config;
  },
};

interface DepsJob {
  running: boolean;
  done: number;
  total: number;
  current: string;
  startedAt?: string;
  finishedAt?: string;
  activeDays?: number;
  reports?: DepsReport[];
  error?: string;
}
let depsJob: DepsJob = { running: false, done: 0, total: 0, current: "" };

export async function handleApi(req: ApiRequest): Promise<unknown> {
  const handler = routes[`${req.method} ${req.path}`];
  if (!handler) throw new HttpError(404, `No such API: ${req.method} ${req.path}`);
  return handler(req);
}

/** The project at `dir`, only if it's one dx found: the page can't point actions at any other folder. */
function knownProject(dir: unknown): Project {
  const wanted = String(dir ?? "").toLowerCase();
  const project = scanProjects(loadConfig()).find((p) => p.dir.toLowerCase() === wanted);
  if (!project) throw new HttpError(404, "That project isn't in your projects folders any more. Refresh the list.");
  return project;
}

function startedBy(raw: unknown): StartedBy {
  return raw === "ai" || raw === "terminal" ? raw : "dashboard";
}

const AI_IDS: AiToolId[] = ["claude-code", "claude-desktop", "cursor", "windsurf", "vscode"];
function aiIds(raw: unknown): AiToolId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map(String).filter((id): id is AiToolId => (AI_IDS as string[]).includes(id));
}

function sourceFrom(raw: unknown): Source {
  const value = String(raw ?? "");
  const [kind, ...rest] = value.split(":");
  const ref = rest.join(":");
  if (kind === "template") {
    const t = listTemplates(loadConfig()).find((x) => x.name === ref);
    if (!t) throw new HttpError(400, `No template called "${ref}".`);
    return { kind: "template", name: t.name, dir: t.dir };
  }
  if (kind === "project") {
    const p = knownProject(ref);
    return { kind: "project", name: p.name, dir: p.dir };
  }
  throw new HttpError(400, "Pick a template or a project to start from.");
}

/** The steps to do one visit again, from the history; only addresses on this computer. */
export function replayOf(dir: string, visit: string): Replay {
  flushActivity();
  // A visit id ends with the time it started, in base 36.
  const started = parseInt(visit.slice(8), 36);
  const since = Number.isFinite(started) && started > 1e12 ? new Date(started - 60_000) : new Date(Date.now() - 7 * 86_400_000);
  const events = readActivity({ dir, since, limit: 5000 }).filter((e) => e.visit === visit);
  const replay = replayFromVisit(events);
  if (!replay) throw new HttpError(404, "That visit isn't in the history any more.");
  if (!isLoopbackUrl(replay.url)) throw new HttpError(400, "Only pages on this computer can be replayed.");
  return replay;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  // A missing query value is null, and Number(null) is 0: that's "not given", not zero.
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function run(command: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => execFile(command, args, { cwd, windowsHide: true }, (err) => resolve(!err)));
}

function shell(command: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: "ignore" });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** Browser steps from a request: plain objects with the known fields only, at most 50. */
function stepsOf(raw: unknown): PageStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return raw.slice(0, 50).map((x) => {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    return {
      goto: str(o.goto),
      click: str(o.click),
      type: str(o.type),
      into: str(o.into),
      press: str(o.press),
      waitFor: str(o.waitFor ?? o.wait_for),
      screenshot: o.screenshot === true,
      timeoutMs: typeof o.timeoutMs === "number" ? Math.min(60_000, Math.max(500, o.timeoutMs)) : undefined,
    };
  });
}
