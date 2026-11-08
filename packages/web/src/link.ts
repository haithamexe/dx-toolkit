import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dxPath, ensureDxHome } from "@dx/core";

/**
 * How other dx processes (the MCP server, the dx command) find the running dashboard and talk to
 * it, starting it in the background when it isn't running. The dashboard writes its port and
 * token to ~/.dx/dashboard.json, readable by this user only; a web page can't read that file, so
 * the token check still keeps other websites out.
 */
export interface DashboardInfo {
  url: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  /** Started in the background (by an AI tool or `dx ui --background`) rather than by `dx ui`. */
  background: boolean;
  /** The port *.localhost addresses are served on (80 means no port in the address). */
  localDomainsPort?: number;
  httpsPort?: number;
  /** The dx version it runs; missing in dashboards from before 1.7.3. */
  version?: string;
}

/** This dx's version (the web package's, which every release bumps with the others). */
export function dxVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Whether version `a` comes before `b` (x.y.z; a missing one counts as the oldest). */
export function olderVersion(a: string | undefined, b: string): boolean {
  if (!a) return true;
  const n = (v: string) => v.split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

export function dashboardInfoPath(): string {
  return dxPath("dashboard.json");
}

export function writeDashboardInfo(info: DashboardInfo): void {
  ensureDxHome();
  const file = dashboardInfoPath();
  fs.writeFileSync(file, JSON.stringify(info, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows: the file inherits the user profile's permissions, which are already this user only.
  }
}

export function readDashboardInfo(): DashboardInfo | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(dashboardInfoPath(), "utf8")) as DashboardInfo;
    return typeof info.port === "number" && typeof info.token === "string" ? info : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the file, but only if it still describes this process's dashboard. */
export function clearDashboardInfo(pid = process.pid): void {
  const info = readDashboardInfo();
  if (info && info.pid !== pid) return;
  try {
    fs.unlinkSync(dashboardInfoPath());
  } catch {
    // already gone
  }
}

export class DashboardError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the dashboard's API with its token. */
export class DashboardClient {
  /** Set when `ensureDashboard` replaced a dashboard from an older dx: its version, and the dev servers started again. */
  replaced?: { from: string; servers: string[] };
  constructor(public info: DashboardInfo) {}

  get url(): string {
    return this.info.url;
  }

  async call<T = unknown>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 130_000): Promise<T> {
    const res = await fetch(new URL(path, this.info.url), {
      method,
      headers: { "X-DX-Token": this.info.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new DashboardError(res.status, json.error ?? `${res.status} ${res.statusText}`);
    return json as T;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.call<T>("GET", path);
  }

  post<T = unknown>(path: string, body: unknown = {}, timeoutMs?: number): Promise<T> {
    return this.call<T>("POST", path, body, timeoutMs);
  }
}

/** The running dashboard, if there is one and it answers. */
export async function findDashboard(): Promise<DashboardClient | undefined> {
  const info = readDashboardInfo();
  if (!info) return undefined;
  const client = new DashboardClient(info);
  try {
    await client.call("GET", "/api/ping", undefined, 2000);
    return client;
  } catch {
    return undefined;
  }
}

/** The script that runs a dashboard in the background. */
export function backgroundScript(): string {
  return fileURLToPath(new URL("./background.js", import.meta.url));
}

/**
 * The running dashboard, started in the background first if needed. Several callers at once
 * (two AI sessions, say) start only one: the first takes a lock file, the others wait for it.
 */
export async function ensureDashboard(timeoutMs = 20_000): Promise<DashboardClient> {
  const existing = await findDashboard();
  if (existing && !outdated(existing)) return existing;
  // A background dashboard left from an older dx (after an update) is replaced by this version's,
  // and the dev servers it ran are started again on the new one. Never a newer one (an AI tool's
  // MCP server can still be the old dx), nor one running in someone's terminal.
  const carried = existing ? await stopOutdated(existing) : undefined;
  const client = await startOrWait(timeoutMs);
  if (carried) {
    const servers: string[] = [];
    for (const s of carried.servers) {
      try {
        await client.post("/api/dev/start", { dir: s.dir, ...(s.startedBy === "ai" ? { by: "ai" } : {}) });
        servers.push(s.project);
      } catch {
        // a project that's gone, or won't start: it shows on the page as usual
      }
    }
    client.replaced = { from: carried.from, servers };
  }
  return client;
}

function outdated(client: DashboardClient): boolean {
  return client.info.background && olderVersion(client.info.version, dxVersion());
}

/** Stops an outdated dashboard, remembering the dev servers it ran (one entry per project). */
async function stopOutdated(client: DashboardClient): Promise<{ from: string; servers: { dir: string; project: string; startedBy?: string }[] }> {
  let list: { dir: string; project: string; status: string; startedBy?: string }[] = [];
  try {
    list = await client.get("/api/dev");
  } catch {
    // it answers ping but not this: nothing to carry over
  }
  const servers = new Map<string, { dir: string; project: string; startedBy?: string }>();
  for (const s of list) if (s.status === "starting" || s.status === "ready") servers.set(s.dir.toLowerCase(), { dir: s.dir, project: s.project, startedBy: s.startedBy });
  try {
    await client.post("/api/shutdown");
  } catch {
    // already going
  }
  for (let i = 0; i < 40 && (await findDashboard())?.info.pid === client.info.pid; i++) await new Promise((r) => setTimeout(r, 250));
  return { from: client.info.version ?? "an older dx", servers: [...servers.values()] };
}

async function startOrWait(timeoutMs: number): Promise<DashboardClient> {
  const running = await findDashboard();
  if (running && !outdated(running)) return running;

  ensureDxHome();
  const lock = dxPath("dashboard.lock");
  let haveLock = false;
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
    haveLock = true;
  } catch {
    // Someone else is starting it; a lock older than the timeout is left over from a crash.
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > timeoutMs) {
        fs.writeFileSync(lock, String(process.pid));
        haveLock = true;
      }
    } catch {
      // gone already
    }
  }
  try {
    if (haveLock) {
      const child = spawn(process.execPath, [backgroundScript()], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      child.unref();
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const client = await findDashboard();
      if (client) return client;
    }
    throw new Error("The dx dashboard didn't start. Run `dx ui` in a terminal to see why.");
  } finally {
    if (haveLock) {
      try {
        fs.unlinkSync(lock);
      } catch {
        // fine
      }
    }
  }
}
