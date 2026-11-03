import { spawn, type ChildProcess } from "node:child_process";
import { getProjectPort, isPortOpen, killProcess, recordRun, type Project } from "@dx/core";

/**
 * Dev servers started from the dashboard. Each runs as a child of the dashboard's server, its
 * output is kept (the last lines) so the page can show it live, and it can be stopped from the page.
 * They stop when the dashboard stops, like a dev server stops when you close its terminal.
 */
export interface DevLine {
  n: number;
  stream: "out" | "err" | "dx";
  text: string;
}

export interface DevServerInfo {
  project: string;
  dir: string;
  command: string;
  url?: string;
  pid?: number;
  status: "starting" | "ready" | "stopped" | "failed";
  startedAt: string;
  stoppedAt?: string;
  exitCode?: number | null;
  /** Number of the last line, so the page can ask only for what's new. */
  lastLine: number;
}

interface DevServer extends DevServerInfo {
  child?: ChildProcess;
  lines: DevLine[];
  port?: number;
  stopping?: boolean;
}

const MAX_LINES = 2000;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const servers = new Map<string, DevServer>();

export function listDevServers(): DevServerInfo[] {
  return [...servers.values()].map(info).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function devServer(dir: string): DevServerInfo | undefined {
  const s = servers.get(key(dir));
  return s && info(s);
}

export function devLogs(dir: string, after = 0): { lines: DevLine[]; server?: DevServerInfo } {
  const s = servers.get(key(dir));
  if (!s) return { lines: [] };
  return { lines: s.lines.filter((l) => l.n > after), server: info(s) };
}

export function startDevServer(project: Project): DevServerInfo {
  if (!project.devCommand) throw new Error(`${project.name} has no dev command. Add one in .devrc.json: { "dev": "..." }`);
  const existing = servers.get(key(project.dir));
  if (existing && (existing.status === "starting" || existing.status === "ready")) return info(existing);

  const s: DevServer = {
    project: project.name,
    dir: project.dir,
    command: project.devCommand,
    url: project.url,
    port: getProjectPort(project),
    status: "starting",
    startedAt: new Date().toISOString(),
    lastLine: 0,
    lines: [],
  };
  servers.set(key(project.dir), s);
  push(s, "dx", `$ ${project.devCommand}`);

  const child = spawn(project.devCommand, {
    cwd: project.dir,
    shell: true,
    windowsHide: true,
    // Its own process group on macOS/Linux, so Stop can end the whole tree (npm → node → vite).
    detached: process.platform !== "win32",
    env: { ...process.env, FORCE_COLOR: "0", BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  s.child = child;
  s.pid = child.pid;
  child.stdout?.on("data", (d: Buffer) => pushChunk(s, "out", d));
  child.stderr?.on("data", (d: Buffer) => pushChunk(s, "err", d));
  child.once("error", (err) => {
    s.status = "failed";
    push(s, "dx", `Couldn't start: ${err.message}`);
  });
  child.once("exit", (code, signal) => {
    s.exitCode = code;
    s.stoppedAt = new Date().toISOString();
    const ms = Date.parse(s.stoppedAt) - Date.parse(s.startedAt);
    if (s.stopping) {
      s.status = "stopped";
      push(s, "dx", "Stopped.");
      recordRun("go", true, `${s.project} dev stopped from the dashboard`, "web", { project: s.project, ms });
    } else {
      s.status = code === 0 ? "stopped" : "failed";
      push(s, "dx", `Exited with ${code ?? signal}.`);
      recordRun("go", code === 0, `${s.project} dev exited with ${code ?? signal}`, "web", { project: s.project, ms });
    }
    s.child = undefined;
  });
  void (async () => {
    // If something else already holds the usual port, the dev server will pick another one and say so.
    if (s.port !== undefined && (await isPortOpen(s.port))) {
      push(s, "dx", `Port ${s.port} is already in use by another program; waiting for the dev server to say where it runs.`);
      s.port = undefined;
      s.url = undefined;
      return;
    }
    await watchReady(s);
  })();
  return info(s);
}

export async function stopDevServer(dir: string): Promise<DevServerInfo | undefined> {
  const s = servers.get(key(dir));
  if (!s?.child?.pid) return s && info(s);
  s.stopping = true;
  push(s, "dx", "Stopping…");
  if (process.platform === "win32") {
    await killProcess(s.child.pid);
  } else {
    try {
      process.kill(-s.child.pid, "SIGTERM");
    } catch {
      s.child.kill("SIGTERM");
    }
  }
  return info(s);
}

/** Stops every dev server; called when the dashboard shuts down. */
export async function stopAllDevServers(): Promise<void> {
  await Promise.all([...servers.values()].filter((s) => s.child).map((s) => stopDevServer(s.dir)));
}

/** Forgets a stopped server, so its card and output go away. */
export function clearDevServer(dir: string): void {
  const s = servers.get(key(dir));
  if (s && !s.child) servers.delete(key(dir));
}

async function watchReady(s: DevServer): Promise<void> {
  if (s.port === undefined) return;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && s.status === "starting") {
    if (await isPortOpen(s.port)) {
      if (s.status === "starting") {
        s.status = "ready";
        push(s, "dx", `Ready at ${s.url}`);
        recordRun("go", true, `${s.project} started from the dashboard`, "web", { project: s.project });
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
}

const partial = new WeakMap<DevServer, Record<string, string>>();

function pushChunk(s: DevServer, stream: "out" | "err", chunk: Buffer): void {
  const carry = partial.get(s) ?? {};
  const text = (carry[stream] ?? "") + chunk.toString("utf8");
  const parts = text.split(/\r?\n/);
  carry[stream] = parts.pop() ?? "";
  partial.set(s, carry);
  for (const line of parts) push(s, stream, line);
  // The URL the dev server prints wins over the guess: it may have moved to another port.
  if (s.status === "starting") {
    const m = /(https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5}))/.exec(text.replace(ANSI, ""));
    if (m && Number(m[2]) !== s.port) {
      s.url = m[1];
      s.port = Number(m[2]);
      void watchReady(s);
    }
  }
}

function push(s: DevServer, stream: DevLine["stream"], raw: string): void {
  const text = raw.replace(ANSI, "").replace(/\r/g, "");
  s.lastLine++;
  s.lines.push({ n: s.lastLine, stream, text });
  if (s.lines.length > MAX_LINES) s.lines.splice(0, s.lines.length - MAX_LINES);
}

function info(s: DevServer): DevServerInfo {
  const { project, dir, command, url, pid, status, startedAt, stoppedAt, exitCode, lastLine } = s;
  return { project, dir, command, url, pid, status, startedAt, stoppedAt, exitCode, lastLine };
}

function key(dir: string): string {
  return process.platform === "win32" ? dir.toLowerCase() : dir;
}
