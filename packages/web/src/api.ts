import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  addJournalEntry,
  auditDependencies,
  buildSummary,
  commandExists,
  copyProject,
  deleteCleanup,
  expandHome,
  findCleanup,
  formatSummary,
  isValidProjectName,
  killPort,
  listListeningPorts,
  listTemplates,
  loadConfig,
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
  type DepsReport,
  type Project,
  type Source,
} from "@dx/core";
import { clearDevServer, devLogs, listDevServers, startDevServer, stopDevServer } from "./dev.js";

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
  // ------------------------------------------------------------ projects
  "GET /api/projects": () => {
    const running = new Map(listDevServers().map((d) => [d.dir.toLowerCase(), d]));
    return scanProjects(loadConfig()).map((p) => ({
      name: p.name,
      dir: p.dir,
      kind: p.kind,
      packageManager: p.packageManager,
      devCommand: p.devCommand,
      url: p.url,
      hasGit: p.hasGit,
      lastActive: p.lastActive,
      dev: running.get(p.dir.toLowerCase()),
    }));
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
      await openTerminal(project.dir, command, project.name);
      recordRun("go", true, project.name, "web", { project: project.name });
      return { message: `Started ${project.devCommand} in a new terminal window` };
    }
    throw new HttpError(400, `Unknown action: ${action}`);
  },

  // ------------------------------------------------------------ dev servers
  "GET /api/dev": () => listDevServers(),
  "POST /api/dev/start": (req) => startDevServer(knownProject(req.body.dir)),
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
    saveConfig(config);
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

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
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
