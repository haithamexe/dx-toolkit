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
  if (existing) return existing;

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
