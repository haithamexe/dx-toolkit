import { spawn, type ChildProcess } from "node:child_process";
import {
  detectStack,
  ErrorTracker,
  getProjectPort,
  hasWork,
  planPrepare,
  runPrepare,
  type PrepareStep,
  isPortOpen,
  killProcess,
  loadConfig,
  mainService,
  moveDevPort,
  recordRun,
  rememberSession,
  serviceName,
  splitRunnerLine,
  startOrder,
  type DevError,
  type Project,
  type Stack,
  type StackService,
} from "@dx/core";
import { activitySettings, recordActivity } from "./activity.js";
import { freePort, openFrontDoor, type FrontDoor } from "./frontdoor.js";

/**
 * Dev servers run by the dashboard. A project runs as one process, or, when it has a stack, as
 * several services started in order (databases, then back ends, then front ends). Output is kept
 * (the last lines) so the page and AI agents can read it, errors are picked out of it, and
 * everything stops when the dashboard stops, like a dev server stops when you close its terminal.
 */
export interface DevLine {
  /** Numbered across every server, so lines from a stack's services merge in order. */
  n: number;
  stream: "out" | "err" | "dx";
  text: string;
  /** The stack service the line came from. */
  service?: string;
}

export type StartedBy = "dashboard" | "ai" | "terminal";
export type DevStatus = "starting" | "ready" | "stopped" | "failed";

export interface DevServerInfo {
  project: string;
  dir: string;
  command: string;
  url?: string;
  /** Its address through dx's local domains, e.g. http://shop.localhost. */
  localUrl?: string;
  pid?: number;
  status: DevStatus;
  /** Who started it: the dashboard's Run button, an AI agent through MCP, or the terminal. */
  startedBy: StartedBy;
  /** Errors in its output that haven't been resolved by a clean rebuild. */
  errorCount: number;
  startedAt: string;
  stoppedAt?: string;
  exitCode?: number | null;
  /** Number of the last line, so the page can ask only for what's new. */
  lastLine: number;
  /** For a stack's service: its name and role. */
  service?: string;
  role?: string;
  /** For a stack: its services, how it was found, and anything worth knowing (a service that wasn't started). */
  services?: DevServerInfo[];
  stackSource?: string;
  note?: string;
  /** dx answers at `url` itself, so a visit there is in the activity history too. */
  recorded?: boolean;
  /** The project as it was at a commit, run from ~/.dx/snapshots. */
  snapshot?: boolean;
  /** Getting it ready before it starts: packages, .env, Docker, migrations… with each step's state. */
  prepare?: PrepareView[];
}

export interface PrepareView {
  id: string;
  title: string;
  why: string;
  status: PrepareStep["status"];
  fix?: string;
  /** After a failure: the output line that says what went wrong. */
  output?: string;
  blocking: boolean;
}

const prepareView = (steps: PrepareStep[] | undefined): PrepareView[] | undefined =>
  steps?.length ? steps.map(({ id, title, why, status, fix, output, blocking }) => ({ id, title, why, status, fix, output, blocking })) : undefined;

interface Proc {
  key: string;
  project: string;
  dir: string;
  command: string;
  url?: string;
  port?: number;
  status: DevStatus;
  startedBy: StartedBy;
  startedAt: string;
  stoppedAt?: string;
  exitCode?: number | null;
  pid?: number;
  lastLine: number;
  child?: ChildProcess;
  lines: DevLine[];
  stopping?: boolean;
  /** Errors per service ("" for the process itself). */
  trackers: Map<string, ErrorTracker>;
  flushTimer?: NodeJS.Timeout;
  lastOutputAt: number;
  service?: string;
  role?: string;
  /** The stack this process belongs to. */
  stackKey?: string;
  /** A runner (turbo, concurrently…) whose output names the service on each line. */
  split?: StackService[];
  /** URLs the runner's services printed. */
  subUrls: Map<string, string>;
  /** docker compose up -d: done when it exits, ready when the published port opens. */
  docker?: { compose: string; hostPort?: number };
  /** dx at the server's usual address (`port`), passing to where the server runs (`hidden`). */
  front?: { door: FrontDoor; port: number; hidden: number };
  snapshot?: boolean;
  portHint?: number;
  prepare?: PrepareStep[];
}

/** Whether apps dx starts are recorded at localhost:<port> too (needs the activity history on). */
function localhostRecording(): boolean {
  if (!activitySettings().on) return false;
  try {
    return loadConfig().localhostRecording !== false;
  } catch {
    return true;
  }
}

interface StackRun {
  key: string;
  dir: string;
  name: string;
  stack: Stack;
  startedBy: StartedBy;
  phase: "starting" | "running" | "stopping" | "stopped";
  startedAt: string;
  stoppedAt?: string;
  note?: string;
  prepare?: PrepareStep[];
  /** Its preparation failed, so nothing was started. */
  failed?: boolean;
}

const MAX_LINES = 2000;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const URL_IN_TEXT = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5}))/;
const procs = new Map<string, Proc>();
const stacks = new Map<string, StackRun>();
let lineCounter = 0;
let localPort: number | undefined;

// ------------------------------------------------------------ local domains

/** Tells the dev servers the local domains proxy's port, or undefined when it isn't running. */
export function setLocalDomainsPort(port: number | undefined, httpsPort?: number): void {
  localPort = port;
  localHttpsPort = port === undefined ? undefined : httpsPort;
}

let localHttpsPort: number | undefined;

/** https://shop.localhost when local HTTPS is on, else http://shop.localhost. */
function localUrlOf(host: string): string | undefined {
  if (localHttpsPort !== undefined) return `https://${host}${localHttpsPort === 443 ? "" : `:${localHttpsPort}`}`;
  if (localPort === undefined) return undefined;
  return `http://${host}${localPort === 80 ? "" : `:${localPort}`}`;
}

export interface LocalRoute {
  url: string;
  dir: string;
  project: string;
  service?: string;
  /** Where the visit came from, for the history: "phone" when it came through Open on my phone. */
  env?: string;
}

/** Every *.localhost name dx serves, and the address it points at. */
export function localRoutes(): Map<string, LocalRoute> {
  const routes = new Map<string, LocalRoute>();
  for (const p of procs.values()) {
    if (p.stackKey || !p.child || !p.url) continue;
    routes.set(`${serviceName(p.project)}.localhost`, { url: p.url, dir: p.dir, project: p.project });
  }
  for (const run of stacks.values()) {
    if (run.phase === "stopped") continue;
    const base = serviceName(run.name);
    const main = mainService(run.stack)?.name;
    for (const svc of serviceInfos(run)) {
      if (!svc.url || svc.status === "stopped" || svc.status === "failed") continue;
      routes.set(`${svc.service}.${base}.localhost`, { url: svc.url, dir: run.dir, project: run.name, service: svc.service });
      if (svc.service === main) routes.set(`${base}.localhost`, { url: svc.url, dir: run.dir, project: run.name, service: svc.service });
    }
  }
  return routes;
}

// ------------------------------------------------------------ reading

export function listDevServers(): DevServerInfo[] {
  const singles = [...procs.values()].filter((p) => !p.stackKey).map(info);
  const stackInfos = [...stacks.values()].map(stackInfo);
  return [...singles, ...stackInfos].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function devServer(dir: string): DevServerInfo | undefined {
  const run = stacks.get(key(dir));
  if (run) return stackInfo(run);
  const p = procs.get(key(dir));
  return p && info(p);
}

/** The process (or stack service) listening on a port, for matching a request to its server. */
export function serverForPort(port: number): { dir: string; service?: string; project: string } | undefined {
  for (const p of procs.values()) {
    if (!p.child && !p.docker) continue;
    const urls = p.split ? [...p.subUrls.entries()] : p.url ? [[p.service ?? "", p.url] as [string, string]] : [];
    if (p.front) urls.push([p.service ?? "", `http://localhost:${p.front.port}`]);
    for (const [service, url] of urls) {
      if (portOf(url) !== port) continue;
      const run = p.stackKey ? stacks.get(p.stackKey) : undefined;
      return { dir: run?.dir ?? p.dir, service: service || undefined, project: run?.name ?? p.project };
    }
  }
  return undefined;
}

export function devLogs(dir: string, after = 0, service?: string): { lines: DevLine[]; server?: DevServerInfo } {
  const list = procsFor(dir);
  if (!list.length) return { lines: [] };
  const lines = list
    .flatMap((p) => p.lines.filter((l) => l.n > after && (!service || (l.service ?? p.service) === service)).map((l) => (p.service && !l.service ? { ...l, service: p.service } : l)))
    .sort((a, b) => a.n - b.n);
  return { lines, server: devServer(dir) };
}

/** Errors found in one server's output (a stack's services included), or in every server's when `dir` is empty. */
export function devErrors(dir?: string, options: { all?: boolean; after?: number; service?: string } = {}): { project: string; dir: string; errors: DevError[] }[] {
  const tops = dir ? [devServer(dir)].filter((x): x is DevServerInfo => !!x) : listDevServers();
  return tops.map((top) => ({
    project: top.project,
    dir: top.dir,
    errors: errorsOf(procsFor(top.dir), options),
  }));
}

function errorsOf(list: Proc[], options: { all?: boolean; after?: number; service?: string }): DevError[] {
  const out: DevError[] = [];
  for (const p of list) {
    for (const [svc, tracker] of p.trackers) {
      tracker.flush();
      const service = svc || p.service;
      if (options.service && service !== options.service) continue;
      for (const e of tracker.errors(options)) out.push(service ? { ...e, service } : e);
    }
  }
  return out.sort((a, b) => b.lastLine - a.lastLine);
}

// ------------------------------------------------------------ starting

/**
 * Starts a project: its stack when it has one, else its dev command. A snapshot (the project as
 * it was at a commit, under ~/.dx/snapshots) runs on a port of its own, next to the project's
 * usual dev server, and isn't remembered as where you left off.
 */
export function startDevServer(project: Project, startedBy: StartedBy = "dashboard", options: { snapshot?: boolean } = {}): DevServerInfo {
  const stack = detectStack(project);
  // Where you left off: what ran, on which branch (dx resume, resume_project).
  if (!options.snapshot) rememberSession(project.dir, project.name, { ran: stack ? stack.services.map((s) => s.name) : ["dev"] });
  if (stack) return startStack(project, stack, startedBy);
  if (!project.devCommand) throw new Error(`${project.name} has no dev command. Add one in .devrc.json: { "dev": "..." }`);
  const existing = procs.get(key(project.dir));
  if (existing && (existing.status === "starting" || existing.status === "ready")) return info(existing);
  const spec: Spec = {
    key: key(project.dir),
    project: project.name,
    dir: project.dir,
    command: project.devCommand,
    url: project.url,
    port: getProjectPort(project),
    startedBy,
  };
  // Getting it ready first (packages, .env, migrations…), in its own log; a snapshot prepares itself.
  const steps = options.snapshot ? [] : safePlan(project, {});
  if (!hasWork(steps, "before")) {
    const p = launchProject(project, spec, options);
    if (steps.length) p.prepare = steps;
    return info(p);
  }
  const p = newProc(spec);
  p.prepare = steps;
  void (async () => {
    const r = await runPrepare(steps, project.dir, "before", { log: (line) => push(p, "dx", line) });
    if (p.stopping) {
      p.status = "stopped";
      p.stoppedAt = new Date().toISOString();
      return;
    }
    if (!r.ok) {
      p.status = "failed";
      p.stoppedAt = new Date().toISOString();
      push(p, "dx", `${project.name} didn't start: ${r.failed!.title} failed (${r.failed!.why}).${r.failed!.fix ? ` ${r.failed!.fix}.` : ""}`);
      recordRun("go", false, `${project.name}: ${r.failed!.title} failed`, "web", { project: project.name });
      return;
    }
    launchProject(project, spec, options, p);
  })();
  return info(p);
}

/** The steps, or none when finding them failed (a broken file): starting matters more. */
function safePlan(project: Project, options: Parameters<typeof planPrepare>[1]): PrepareStep[] {
  try {
    return planPrepare(project, options);
  } catch {
    return [];
  }
}

function launchProject(project: Project, spec: Spec, options: { snapshot?: boolean }, existing?: Proc): Proc {
  if (options.snapshot) return startOnOwnPort(project, { ...spec, url: undefined, port: undefined, snapshot: true }, existing);
  // Recorded at localhost:<port> too, when its tool can be moved to another port.
  const usual = spec.port;
  if (usual && localhostRecording() && moveDevPort(project, 1)) return startBehindDoor(project, spec, usual, existing);
  if (existing) {
    launch(existing, spec);
    return existing;
  }
  return spawnProc(spec);
}

function startStack(project: Project, stack: Stack, startedBy: StartedBy): DevServerInfo {
  const k = key(project.dir);
  const existing = stacks.get(k);
  if (existing && (existing.phase === "starting" || existing.phase === "running")) return stackInfo(existing);
  for (const p of [...procs.values()]) if (p.stackKey === k && !p.child) procs.delete(p.key);
  const run: StackRun = { key: k, dir: project.dir, name: project.name, stack, startedBy, phase: "starting", startedAt: new Date().toISOString() };
  stacks.set(k, run);
  void runStack(run).catch((err: Error) => {
    run.note = `Couldn't start the stack: ${err.message}`;
    run.phase = "running";
  });
  return stackInfo(run);
}

async function runStack(run: StackRun): Promise<void> {
  const { stack } = run;
  const crashed = new Set<string>();
  const skipped: string[] = [];
  const docker = stack.services.filter((s) => s.kind === "docker");
  const waves: (StackService[] | "runner")[] = stack.runner ? [...(docker.length ? [docker] : []), "runner"] : startOrder(stack);
  const unavailable = (d: string) => crashed.has(d) || skipped.some((s) => s.startsWith(`${d} `));

  // Getting it ready: packages (the root's and each service folder's), .env, Docker, builds; then,
  // once its databases are up, migrations. Logged as the stack's own "prepare" output.
  const steps = safePlan({ dir: run.dir, name: run.name } as Project, {
    docker: docker.length > 0,
    extraDirs: [...new Set(stack.services.filter((s) => s.kind === "process").map((s) => s.dir))],
  });
  run.prepare = steps;
  let prep: Proc | undefined;
  const log = (line: string) => {
    prep ??= newProc({ key: `${run.key}#prepare`, project: run.name, dir: run.dir, command: "prepare", startedBy: run.startedBy, stackKey: run.key, service: "prepare" });
    push(prep, "dx", line);
  };
  const failed = (step: PrepareStep) => {
    run.failed = true;
    run.phase = "stopped";
    run.stoppedAt = new Date().toISOString();
    run.note = `Didn't start: ${step.title} failed (${step.why}).${step.fix ? ` ${step.fix}.` : ""}`;
    if (prep) prep.status = "failed";
    recordRun("go", false, `${run.name}: ${step.title} failed`, "web", { project: run.name });
  };
  if (hasWork(steps, "before")) {
    const r = await runPrepare(steps, run.dir, "before", { log });
    if (run.phase !== "starting") return;
    if (!r.ok) return failed(r.failed!);
  }
  let dbReady = !hasWork(steps, "db");

  for (const wave of waves) {
    if (run.phase !== "starting") return;
    // Migrations after the databases, before anything that uses them.
    if (!dbReady && (wave === "runner" || !wave.some((s) => s.kind === "docker"))) {
      dbReady = true;
      const r = await runPrepare(steps, run.dir, "db", { log });
      if (run.phase !== "starting") return;
      if (!r.ok) return failed(r.failed!);
    }
    const started: Proc[] = [];
    for (const svc of wave === "runner" ? [] : wave) {
      const blockedBy = svc.dependsOn.filter(unavailable);
      if (blockedBy.length) {
        skipped.push(`${svc.name} (needs ${blockedBy.join(", ")})`);
        continue;
      }
      started.push(startService(run, svc));
    }
    if (wave === "runner" && stack.runner) {
      // Every app service through the project's own runner, after the databases.
      started.push(
        spawnProc({
          key: `${run.key}#*`,
          project: run.name,
          dir: stack.dir,
          command: stack.runner.command,
          startedBy: run.startedBy,
          stackKey: run.key,
          split: stack.services.filter((s) => s.kind === "process"),
          env: urlEnv(run),
        }),
      );
    }
    await Promise.all(started.map((p) => waitSettled(p, 120_000)));
    for (const p of started) if (p.status === "failed" && p.service) crashed.add(p.service);
  }
  if (run.phase !== "starting") return;
  run.phase = "running";
  const notes: string[] = [];
  if (crashed.size) notes.push(`Failed to start: ${[...crashed].join(", ")}.`);
  if (skipped.length) notes.push(`Not started: ${skipped.join("; ")}.`);
  run.note = notes.length ? notes.join(" ") : undefined;
  recordRun("go", crashed.size === 0, `${run.name} stack started (${stack.services.length} services)`, "web", { project: run.name });
}

function startService(run: StackRun, svc: StackService): Proc {
  const env = { ...(svc.env ?? {}), ...urlEnv(run) };
  delete env.DX_LABEL;
  return spawnProc({
    key: `${run.key}#${svc.name}`,
    project: run.name,
    dir: svc.dir,
    command: svc.command,
    url: svc.kind === "docker" ? undefined : svc.url,
    port: svc.kind === "docker" ? undefined : portOf(svc.url),
    startedBy: run.startedBy,
    stackKey: run.key,
    service: svc.name,
    role: svc.role,
    env,
    docker: svc.kind === "docker" ? { compose: svc.composeService ?? svc.name, hostPort: svc.hostPort } : undefined,
  });
}

/**
 * Where the stack's other services are: DX_API_URL is the direct address (for server code, since
 * not every system resolves *.localhost), DX_API_PUBLIC_URL the local domain (for the browser).
 */
function urlEnv(run: StackRun): Record<string, string> {
  const env: Record<string, string> = {};
  const base = serviceName(run.name);
  for (const svc of serviceInfos(run)) {
    if (!svc.url || svc.status !== "ready" || !svc.service) continue;
    const name = svc.service.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    env[`DX_${name}_URL`] = svc.url;
    const local = svc.kind === "process" ? localUrlOf(`${svc.service}.${base}.localhost`) : undefined;
    if (local) env[`DX_${name}_PUBLIC_URL`] = local;
  }
  return env;
}

interface Spec {
  key: string;
  project: string;
  dir: string;
  command: string;
  url?: string;
  port?: number;
  startedBy: StartedBy;
  stackKey?: string;
  service?: string;
  role?: string;
  env?: Record<string, string>;
  split?: StackService[];
  docker?: Proc["docker"];
  /** A snapshot: on a port of its own. */
  snapshot?: boolean;
  /** The PORT it was given, when its tool can't be told by flag: ready once that port opens. */
  portHint?: number;
}

function spawnProc(spec: Spec): Proc {
  const p = newProc(spec);
  launch(p, spec);
  return p;
}

/** A process that's starting, before its command runs. */
function newProc(spec: Spec): Proc {
  const p: Proc = {
    ...spec,
    status: "starting",
    startedAt: new Date().toISOString(),
    lastLine: 0,
    lines: [],
    trackers: new Map(),
    lastOutputAt: Date.now(),
    subUrls: new Map(),
  };
  p.trackers.set("", trackerFor(p));
  procs.set(spec.key, p);
  return p;
}

/**
 * A project's dev server behind dx at its usual address (localhost:5173): dx takes that port,
 * moves the server to a free one, and passes everything through, so your own browser's visit
 * is recorded. When the port is taken or the tool can't be moved, it starts as it always did.
 */
function startBehindDoor(project: Project, spec: Spec, usual: number, existing?: Proc): Proc {
  const p = existing ?? newProc({ ...spec, url: undefined, port: undefined });
  if (existing) Object.assign(existing, { url: undefined, port: undefined });
  void (async () => {
    let run = spec;
    try {
      if (!(await isPortOpen(usual))) {
        const hidden = await freePort();
        const moved = moveDevPort(project, hidden);
        const door = moved
          ? await openFrontDoor(usual, () =>
              p.child && p.front ? { port: p.front.hidden, route: { url: `http://localhost:${p.front.hidden}`, dir: p.dir, project: p.project } } : undefined,
            )
          : undefined;
        if (moved && door) {
          p.front = { door, port: usual, hidden };
          run = { ...spec, command: moved.command, env: { ...spec.env, ...moved.env }, url: `http://localhost:${hidden}`, port: hidden };
          push(p, "dx", `Recording at http://localhost:${usual}: dx answers there and runs the dev server on port ${hidden}.`);
        }
      }
    } catch {
      // started as it always was
    }
    if (p.stopping) {
      await closeDoor(p);
      p.status = "stopped";
      return;
    }
    launch(p, run);
  })();
  return p;
}

/**
 * A snapshot's dev server, on a free port so it doesn't fight the project's own for its usual
 * one: told by flag when dx knows its tool (moveDevPort), else given PORT, which most servers
 * read, and the address it prints wins as always. No localhost door: its usual port belongs to
 * the project.
 */
function startOnOwnPort(project: Project, spec: Spec, existing?: Proc): Proc {
  const p = existing ?? newProc(spec);
  void (async () => {
    let run = spec;
    try {
      const port = await freePort();
      const moved = moveDevPort(project, port);
      run = moved
        ? { ...spec, command: moved.command, env: { ...spec.env, ...moved.env }, url: `http://localhost:${port}`, port }
        : { ...spec, env: { ...spec.env, PORT: String(port) }, portHint: port };
      push(p, "dx", moved ? `Snapshot: runs on port ${port}, so the project's own dev server keeps its port.` : `Snapshot: given PORT=${port}; if it listens somewhere else, the address it prints is used.`);
    } catch {
      // started with its own settings; the address it prints is used
    }
    if (p.stopping) {
      p.status = "stopped";
      return;
    }
    launch(p, run);
  })();
  return p;
}

async function closeDoor(p: Proc): Promise<void> {
  const door = p.front?.door;
  p.front = undefined;
  await door?.close();
}

function launch(p: Proc, spec: Spec): void {
  Object.assign(p, { command: spec.command, url: spec.url, port: spec.port, portHint: spec.portHint });
  push(p, "dx", `$ ${spec.command}`);

  const child = spawn(spec.command, {
    cwd: spec.dir,
    shell: true,
    windowsHide: true,
    // Its own process group on macOS/Linux, so Stop can end the whole tree (npm → node → vite).
    detached: process.platform !== "win32",
    env: { ...process.env, FORCE_COLOR: "0", BROWSER: "none", ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.child = child;
  p.pid = child.pid;
  child.stdout?.on("data", (d: Buffer) => pushChunk(p, "out", d));
  child.stderr?.on("data", (d: Buffer) => pushChunk(p, "err", d));
  child.once("error", (err) => {
    p.status = "failed";
    push(p, "dx", `Couldn't start: ${err.message}`);
  });
  child.once("exit", (code, signal) => {
    p.exitCode = code;
    p.child = undefined;
    void closeDoor(p);
    const ms = Date.now() - Date.parse(p.startedAt);
    if (p.docker && !p.stopping) {
      // `docker compose up -d` finishes once the container runs; the service is ready when its port opens.
      if (code !== 0) {
        p.status = "failed";
        push(p, "dx", `docker compose exited with ${code ?? signal}. Is Docker running?`);
        return;
      }
      void (async () => {
        if (p.docker?.hostPort) {
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline && !(await isPortOpen(p.docker.hostPort))) await new Promise((r) => setTimeout(r, 500));
        }
        if (p.status === "starting") {
          p.status = "ready";
          p.url = p.docker?.hostPort ? `http://localhost:${p.docker.hostPort}` : undefined;
          push(p, "dx", p.docker?.hostPort ? `Container ready on port ${p.docker.hostPort}.` : "Container started.");
        }
      })();
      return;
    }
    p.stoppedAt = new Date().toISOString();
    const label = p.service ? `${p.project}/${p.service}` : p.project;
    if (p.stopping) {
      p.status = "stopped";
      push(p, "dx", "Stopped.");
      if (!p.stackKey) recordRun("go", true, `${label} dev stopped from the dashboard`, "web", { project: p.project, ms });
    } else {
      p.status = code === 0 ? "stopped" : "failed";
      push(p, "dx", `Exited with ${code ?? signal}.`);
      recordRun("go", code === 0, `${label} dev exited with ${code ?? signal}`, "web", { project: p.project, ms });
    }
  });
  if (!p.docker) {
    void (async () => {
      // If something else already holds the usual port, the dev server will pick another one and say so.
      if (p.port !== undefined && (await isPortOpen(p.port))) {
        push(p, "dx", `Port ${p.port} is already in use by another program; waiting for the dev server to say where it runs.`);
        p.port = undefined;
        p.url = undefined;
      }
      await watchReady(p);
    })();
  }
}

/**
 * Marks a process ready once its port opens. One that never says where it listens (a worker, a
 * watcher) counts as ready when it's still running and its output has gone quiet.
 */
async function watchReady(p: Proc): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && p.status === "starting" && p.child) {
    if (p.port !== undefined && (await isPortOpen(p.port))) {
      if (p.status === "starting") {
        p.status = "ready";
        push(p, "dx", `Ready at ${p.front ? `http://localhost:${p.front.port}` : p.url}`);
        if (!p.stackKey) recordRun("go", true, `${p.project} started from the dashboard`, "web", { project: p.project });
      }
      return;
    }
    // Given PORT and said nothing about where it listens: that port opening is its address.
    if (p.port === undefined && p.portHint !== undefined && (await isPortOpen(p.portHint)) && p.status === "starting" && p.port === undefined) {
      p.url = `http://localhost:${p.portHint}`;
      p.port = p.portHint;
      continue;
    }
    const age = Date.now() - Date.parse(p.startedAt);
    const quiet = Date.now() - p.lastOutputAt;
    if (p.port === undefined && age > 5000 && quiet > 2500) {
      p.status = "ready";
      push(p, "dx", p.split ? "Running." : "Running (it didn't say where it listens).");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Waits until a process is ready, failed or gone. */
async function waitSettled(p: Proc, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (p.status === "starting" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
}

// ------------------------------------------------------------ stopping

export async function stopDevServer(dir: string): Promise<DevServerInfo | undefined> {
  const name = stacks.get(key(dir))?.name ?? procs.get(key(dir))?.project;
  if (name && !procs.get(key(dir))?.snapshot) {
    const open = devErrors(dir)[0]?.errors.filter((e) => !e.resolved).map((e) => `${e.message}${e.file ? ` (${e.file}${e.line ? `:${e.line}` : ""})` : ""}`) ?? [];
    rememberSession(dir, name, { openErrors: open.slice(0, 5) });
  }
  const run = stacks.get(key(dir));
  if (run) {
    await stopStack(run);
    return stackInfo(run);
  }
  const p = procs.get(key(dir));
  if (p) await stopProc(p);
  return p && info(p);
}

async function stopProc(p: Proc): Promise<void> {
  // Still getting its port ready: it won't start.
  if (!p.child && p.status === "starting" && !p.docker) {
    p.stopping = true;
    return;
  }
  if (!p.child?.pid) return;
  p.stopping = true;
  push(p, "dx", "Stopping…");
  if (process.platform === "win32") {
    await killProcess(p.child.pid);
  } else {
    try {
      process.kill(-p.child.pid, "SIGTERM");
    } catch {
      p.child.kill("SIGTERM");
    }
  }
}

async function stopStack(run: StackRun): Promise<void> {
  if (run.phase === "stopped") return;
  run.phase = "stopping";
  const list = procsFor(run.dir);
  await Promise.all(list.filter((p) => !p.docker).map(stopProc));
  // Containers keep running until asked: stop the ones this stack started.
  const docker = list.filter((p) => p.docker && p.status !== "failed");
  if (docker.length) {
    for (const p of docker) push(p, "dx", "Stopping the container…");
    const code = await new Promise<number>((resolve) => {
      const child = spawn(`docker compose stop ${docker.map((p) => p.docker!.compose).join(" ")}`, { cwd: run.stack.composeFile ? dirOf(run.stack.composeFile) : run.dir, shell: true, windowsHide: true, stdio: "ignore" });
      child.once("error", () => resolve(1));
      child.once("exit", (c) => resolve(c ?? 1));
    });
    for (const p of docker) {
      p.status = "stopped";
      p.stoppedAt = new Date().toISOString();
      push(p, "dx", code === 0 ? "Container stopped." : "docker compose stop failed; the container may still be running.");
    }
  }
  const exited = list.filter((p) => p.child).map((p) => new Promise<void>((resolve) => p.child?.once("exit", () => resolve())));
  await Promise.race([Promise.all(exited), new Promise((r) => setTimeout(r, 10_000))]);
  run.phase = "stopped";
  run.stoppedAt = new Date().toISOString();
  recordRun("go", true, `${run.name} stack stopped`, "web", { project: run.name, ms: Date.now() - Date.parse(run.startedAt) });
}

/** Stops every dev server; called when the dashboard shuts down. */
export async function stopAllDevServers(): Promise<void> {
  await Promise.all([...stacks.values()].map(stopStack));
  await Promise.all([...procs.values()].filter((p) => p.child && !p.stackKey).map(stopProc));
}

/** Stops the server (or stack), waits for it to exit, and starts it again. */
export async function restartDevServer(project: Project, startedBy: StartedBy = "dashboard"): Promise<DevServerInfo> {
  const k = key(project.dir);
  const run = stacks.get(k);
  const by = run?.startedBy ?? procs.get(k)?.startedBy ?? startedBy;
  const snapshot = procs.get(k)?.snapshot;
  if (run) {
    await stopStack(run);
    clearDevServer(project.dir);
  } else {
    const p = procs.get(k);
    if (p?.child) {
      const exited = new Promise<void>((resolve) => p.child?.once("exit", () => resolve()));
      await stopProc(p);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    }
    procs.delete(k);
  }
  return startDevServer(project, by, { snapshot });
}

/** Forgets a stopped server or stack, so its card and output go away. */
export function clearDevServer(dir: string): void {
  const k = key(dir);
  const run = stacks.get(k);
  if (run) {
    if (run.phase !== "stopped") return;
    for (const p of [...procs.values()]) if (p.stackKey === k) procs.delete(p.key);
    stacks.delete(k);
    return;
  }
  const p = procs.get(k);
  if (p && !p.child) procs.delete(k);
}

/**
 * "Take over": a server an AI agent started becomes yours, labelled as started from the dashboard.
 * Only the label changes; the process keeps running as it was. Undefined when the server isn't
 * running or wasn't the agent's.
 */
export function takeOverDevServer(dir: string): DevServerInfo | undefined {
  const k = key(dir);
  const run = stacks.get(k);
  if (run) {
    if (run.startedBy !== "ai" || run.phase === "stopped" || run.phase === "stopping") return undefined;
    run.startedBy = "dashboard";
    for (const p of procs.values()) if (p.stackKey === k) p.startedBy = "dashboard";
    return stackInfo(run);
  }
  const p = procs.get(k);
  if (!p || p.stackKey || p.startedBy !== "ai" || !(p.child || p.status === "starting")) return undefined;
  p.startedBy = "dashboard";
  return info(p);
}

/** True while any dev server or stack is running. */
export function anyDevServerRunning(): boolean {
  return [...procs.values()].some((p) => p.child) || [...stacks.values()].some((r) => r.phase !== "stopped");
}

// ------------------------------------------------------------ waiting

export interface WaitResult {
  server?: DevServerInfo;
  /** Output printed since `after` (the newest 200 lines at most). */
  lines: DevLine[];
  /** Current errors that appeared, or came back, since `after`. */
  newErrors: DevError[];
  /** Every current error. */
  errors: DevError[];
  /** False when the server printed nothing at all while waiting. */
  sawOutput: boolean;
  timedOut: boolean;
}

/**
 * Waits for a dev server (or a stack's services) to settle, then says what they printed.
 * `until: "ready"` waits for starting to finish; `until: "quiet"` waits for output to begin (a
 * rebuild after a file change), then for it to stop for `quietMs`.
 */
export async function waitForDevServer(
  dir: string,
  options: { after?: number; until?: "ready" | "quiet"; quietMs?: number; settleMs?: number; timeoutMs?: number } = {},
): Promise<WaitResult> {
  const quietMs = options.quietMs ?? 1000;
  const settleMs = options.settleMs ?? 4000;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const sleep = () => new Promise((r) => setTimeout(r, 100));
  const last = () => Math.max(0, ...procsFor(dir).map((p) => p.lastLine));
  const after = options.after ?? last();
  const lastOutput = () => Math.max(0, ...procsFor(dir).map((p) => p.lastOutputAt));
  const alive = () => procsFor(dir).some((p) => p.child);
  const run = stacks.get(key(dir));
  let timedOut = false;
  if (procsFor(dir).length || run) {
    const begun = Date.now();
    if (options.until === "ready") {
      while ((run?.phase === "starting" || procsFor(dir).some((p) => p.status === "starting")) && Date.now() < deadline) await sleep();
    } else {
      while (last() <= after && alive() && Date.now() - begun < settleMs && Date.now() < deadline) await sleep();
    }
    while (alive() && last() > after && Date.now() - lastOutput() < quietMs && Date.now() < deadline) await sleep();
    timedOut = Date.now() >= deadline;
  }
  const list = procsFor(dir);
  for (const p of list) clearTimeout(p.flushTimer);
  const lines = devLogs(dir, after).lines.slice(-200);
  return {
    server: devServer(dir),
    lines,
    newErrors: errorsOf(list, { after }),
    errors: errorsOf(list, {}),
    sawOutput: lines.length > 0,
    timedOut,
  };
}

// ------------------------------------------------------------ output

const partial = new WeakMap<Proc, Record<string, string>>();

function pushChunk(p: Proc, stream: "out" | "err", chunk: Buffer): void {
  const carry = partial.get(p) ?? {};
  const text = (carry[stream] ?? "") + chunk.toString("utf8");
  const parts = text.split(/\r?\n/);
  carry[stream] = parts.pop() ?? "";
  partial.set(p, carry);
  for (const line of parts) push(p, stream, line);
}

/** Picks errors out of one process's (or one service's) output, and adds each to the activity history. */
function trackerFor(p: Proc, service?: string): ErrorTracker {
  return new ErrorTracker((e: DevError) =>
    recordActivity({
      dir: p.dir,
      project: p.project,
      service: service ?? p.service,
      type: "server-error",
      text: e.message,
      level: "error",
      source: e.file ? `${e.file}${e.line ? `:${e.line}${e.column ? `:${e.column}` : ""}` : ""}` : undefined,
      stack: e.lines.join("\n"),
      from: "server",
    }),
  );
}

function push(p: Proc, stream: DevLine["stream"], raw: string): void {
  let text = raw.replace(ANSI, "").replace(/\r/g, "");
  let service: string | undefined;
  if (p.split && stream !== "dx") {
    const split = splitRunnerLine(text, p.split);
    service = split.service;
    text = split.text;
  }
  p.lastLine = ++lineCounter;
  const line: DevLine = service ? { n: p.lastLine, stream, text, service } : { n: p.lastLine, stream, text };
  p.lines.push(line);
  if (p.lines.length > MAX_LINES) p.lines.splice(0, p.lines.length - MAX_LINES);
  p.lastOutputAt = Date.now();

  let tracker = p.trackers.get(service ?? "");
  if (!tracker) p.trackers.set(service ?? "", (tracker = trackerFor(p, service)));
  tracker.push(line);
  // dx's own lines (started, ready, stopped, exited) are the server's part of the activity history.
  if (stream === "dx") {
    recordActivity({
      dir: p.dir,
      project: p.project,
      service: p.service,
      type: "server",
      text,
      level: /^Exited with (?!0\.)|^Couldn't|failed|exited with/i.test(text) ? "error" : undefined,
      from: "server",
    });
  }
  // An error's last line is only known once the output pauses.
  clearTimeout(p.flushTimer);
  p.flushTimer = setTimeout(() => {
    for (const t of p.trackers.values()) t.flush();
  }, 300);
  p.flushTimer.unref?.();

  // The URL a dev server prints wins over the guess: it may have moved to another port.
  if (stream === "dx") return;
  const m = URL_IN_TEXT.exec(text);
  if (!m) return;
  // "Connecting to the API at http://localhost:4000" names another server, not this one's address.
  if (portInUseByOther(p, Number(m[2]))) return;
  const url = m[1].replace("[::1]", "localhost").replace("127.0.0.1", "localhost");
  // A server that didn't take the port dx gave it: dx steps aside rather than answer for nothing.
  if (p.front && p.status === "starting" && Number(m[2]) !== p.front.hidden && Number(m[2]) !== p.front.port) {
    const usual = p.front.port;
    void closeDoor(p);
    push(p, "dx", `The dev server didn't take the port dx gave it, so localhost:${usual} isn't recorded this time.`);
  }
  if (p.split) {
    if (service && !p.subUrls.has(service)) p.subUrls.set(service, url);
    return;
  }
  if ((p.status === "starting" && Number(m[2]) !== p.port) || (!p.url && p.child)) {
    p.url = url;
    p.port = Number(m[2]);
    void watchReady(p);
  }
}

// ------------------------------------------------------------ info

function info(p: Proc): DevServerInfo {
  const { project, dir, command, url, pid, status, startedBy, startedAt, stoppedAt, exitCode, lastLine, service, role } = p;
  const errorCount = errorsOf([p], {}).length;
  // Behind dx at its usual address, that's the one to open; the moved one is internal.
  const shown = p.front ? `http://localhost:${p.front.port}` : url;
  const out: DevServerInfo = { project, dir, command, url: shown, pid, status, startedBy, errorCount, startedAt, stoppedAt, exitCode, lastLine, service, role };
  if (p.front) out.recorded = true;
  if (p.snapshot) out.snapshot = true;
  if (!p.stackKey && url && p.child) out.localUrl = localUrlOf(`${serviceName(project)}.localhost`);
  if (p.prepare && !p.stackKey) out.prepare = prepareView(p.prepare);
  return out;
}

interface ServiceInfo extends DevServerInfo {
  kind: "process" | "docker";
}

/** A stack's services as the page and agents see them, runner services included. */
function serviceInfos(run: StackRun): ServiceInfo[] {
  const base = serviceName(run.name);
  const list = procsFor(run.dir);
  const runner = list.find((p) => p.split);
  return run.stack.services.map((svc) => {
    const p = list.find((x) => x.service === svc.name);
    let i: DevServerInfo;
    if (p) {
      i = info(p);
    } else if (runner && svc.kind === "process") {
      const r = info(runner);
      i = { ...r, command: svc.command, url: runner.subUrls.get(svc.name), errorCount: errorsOf([runner], { service: svc.name }).length, lastLine: r.lastLine };
    } else {
      i = { project: run.name, dir: svc.dir, command: svc.command, status: run.phase === "starting" ? "starting" : "stopped", startedBy: run.startedBy, errorCount: 0, startedAt: run.startedAt, lastLine: 0 };
    }
    const alive = i.status === "starting" || i.status === "ready";
    return {
      ...i,
      project: run.name,
      service: svc.name,
      role: svc.role,
      kind: svc.kind,
      localUrl: svc.kind === "process" && i.url && alive ? localUrlOf(`${svc.name}.${base}.localhost`) : undefined,
    };
  });
}

function stackInfo(run: StackRun): DevServerInfo {
  const services = serviceInfos(run);
  const main = mainService(run.stack);
  const mainInfo = services.find((s) => s.service === main?.name);
  let status: DevStatus;
  if (run.failed) status = "failed";
  else if (run.phase === "starting") status = "starting";
  else if (run.phase === "stopped" || run.phase === "stopping") status = "stopped";
  else if (services.some((s) => s.status === "failed")) status = "failed";
  else if (services.some((s) => s.status === "starting")) status = "starting";
  // A watcher that finished (exit 0) doesn't make the stack stopped while the others run.
  else status = services.some((s) => s.status === "ready") ? "ready" : "stopped";
  const base = serviceName(run.name);
  return {
    project: run.name,
    dir: run.dir,
    command: run.stack.runner?.command ?? `${services.length} services`,
    url: mainInfo?.url,
    localUrl: mainInfo?.url && status !== "stopped" ? localUrlOf(`${base}.localhost`) : undefined,
    status,
    startedBy: run.startedBy,
    errorCount: services.reduce((n, s) => n + s.errorCount, 0),
    startedAt: run.startedAt,
    stoppedAt: run.stoppedAt,
    lastLine: Math.max(0, ...procsFor(run.dir).map((p) => p.lastLine)),
    services: services.map(({ kind: _kind, ...s }) => s),
    stackSource: run.stack.source,
    note: run.note,
    prepare: prepareView(run.prepare),
  };
}

function portInUseByOther(p: Proc, port: number): boolean {
  for (const other of procs.values()) {
    if (other === p || (!other.child && !other.docker)) continue;
    if (other.port === port || portOf(other.url) === port || [...other.subUrls.values()].some((u) => portOf(u) === port)) return true;
  }
  return false;
}

function procsFor(dir: string): Proc[] {
  const k = key(dir);
  return [...procs.values()].filter((p) => p.key === k || p.stackKey === k);
}

function portOf(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    return undefined;
  }
}

function dirOf(file: string): string {
  return file.replace(/[\\/][^\\/]+$/, "");
}

function key(dir: string): string {
  return process.platform === "win32" ? dir.toLowerCase() : dir;
}
