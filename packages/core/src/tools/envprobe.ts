import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { checkPage, findBrowser, type PageCheck } from "./browser.js";
import { ErrorTracker } from "./devErrors.js";
import { moveDevPort } from "./devport.js";
import { parseDotenv } from "./envcheck.js";
import type { Project } from "./projects.js";

/**
 * One missing value at a time: which of a project's .env values actually matter. The app is
 * started on a port of its own once as it is, then once per value with only that value blank,
 * and each run is compared with the first: values whose absence crashes the app, values whose
 * absence breaks the page, values nothing notices, and values the code never mentions. The
 * project's own dev server, if it's running, keeps running; nothing is written to .env.
 *
 * Values are blanked (KEY=""), not removed: dotenv, Vite and Next.js keep a variable that's
 * already set, so a blank one is how a value goes missing for the app without touching the file.
 */

export type EnvVerdict = "crashes" | "breaks" | "unnoticed" | "unused" | "skipped";

export interface EnvValueResult {
  key: string;
  verdict: EnvVerdict;
  /** What went wrong without it that didn't with it. */
  problems: string[];
  /** Files that mention it (at most 3), and how many in all. */
  usedIn: string[];
  usedCount: number;
  ms?: number;
}

export interface EnvProbe {
  project: string;
  /** The address part checked on each run. */
  path: string;
  /** How the app did with every value set. */
  baseline: { ok: boolean; problems: string[]; ms: number; how: string };
  values: EnvValueResult[];
  /** When the app couldn't be started on its own as it is, there's nothing to compare with. */
  error?: string;
  ms: number;
  stopped?: boolean;
}

export interface EnvProbeOptions {
  /** The page to check on each run (default "/"). */
  path?: string;
  /** Only these values (default every value in .env, .env.local, .env.development). */
  keys?: string[];
  /** At most this many runs besides the first (default 25). */
  max?: number;
  progress?: (done: number, total: number, key: string) => void;
  signal?: AbortSignal;
  /** How long a run may take to answer (default 60 s). */
  startTimeoutMs?: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".output", ".venv", "venv", "__pycache__", "coverage", ".turbo", ".cache", "target", "vendor"]);
const TEXT = /\.(m?[jt]sx?|cjs|vue|svelte|astro|py|rb|go|php|java|kt|rs|cs|ya?ml|toml|json|sh|prisma|tf|ini|cfg|conf|properties|gradle|sql)$|(^|\/)(Dockerfile|Procfile|Makefile)$/i;

/** The project's own files (git's list when it's a repository), without .env files, at most 5000. */
function sourceFiles(dir: string): string[] {
  const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: dir, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  let files: string[];
  if (git.status === 0 && git.stdout) files = git.stdout.split("\0").filter(Boolean);
  else {
    files = [];
    const walk = (rel: string, depth: number) => {
      if (depth > 8 || files.length > 20_000) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(r, depth + 1);
        } else if (e.isFile()) files.push(r);
      }
    };
    walk("", 0);
  }
  return files.filter((f) => TEXT.test(f) && !/(^|\/)\.env/.test(f) && !f.split("/").some((p) => SKIP_DIRS.has(p))).slice(0, 5000);
}

/** Which files mention each name, as a whole word. */
export function envUsage(dir: string, keys: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>(keys.map((k) => [k, []]));
  if (!keys.length) return out;
  const words = new RegExp(`\\b(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g");
  for (const f of sourceFiles(dir)) {
    let text: string;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (!st.isFile() || st.size > 512 * 1024) continue;
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const seen = new Set(text.match(words) ?? []);
    for (const k of seen) out.get(k)?.push(f);
  }
  return out;
}

/** The names in the project's .env files, in the order they're written. */
export function envNames(dir: string): string[] {
  const names: string[] = [];
  for (const f of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const k of parseDotenv(text).keys()) if (!names.includes(k)) names.push(k);
  }
  return names;
}

/** A free port on this computer, from the system. */
export function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => {
      // Some dev servers listen on ::1 only.
      const six = net.connect({ host: "::1", port });
      six.once("connect", () => {
        six.destroy();
        resolve(true);
      });
      six.once("error", () => resolve(false));
    });
    sock.setTimeout(1000, () => done(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shape = (s: string) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);

interface Run {
  started: boolean;
  problems: string[];
  ms: number;
  how: string;
}

/** Starts the app on its own port with these variables, checks one page, stops it. */
async function runOnce(project: Project, env: Record<string, string>, pagePath: string, timeoutMs: number, signal?: AbortSignal): Promise<Run> {
  const t0 = Date.now();
  const port = await freeLocalPort();
  const moved = moveDevPort(project, port);
  const command = moved?.command ?? project.devCommand!;
  const tracker = new ErrorTracker();
  let n = 0;
  let printed: string | undefined;
  let exited: number | null | undefined;
  const child = spawn(command, {
    cwd: project.dir,
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", BROWSER: "none", ...(moved ? moved.env : { PORT: String(port) }), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const read = (stream: "out" | "err") => (chunk: Buffer) => {
    for (const raw of chunk.toString("utf8").split(/\r?\n/)) {
      // eslint-disable-next-line no-control-regex
      const text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      if (!text.trim()) continue;
      tracker.push({ n: ++n, stream, text });
      const url = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/.exec(text);
      if (url && !printed) printed = url[0];
    }
  };
  child.stdout?.on("data", read("out"));
  child.stderr?.on("data", read("err"));
  const gone = new Promise<void>((resolve) => child.once("exit", (code) => ((exited = code), resolve())));
  child.once("error", () => (exited = -1));
  const stop = async () => {
    if (exited !== undefined) return;
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else process.kill(-child.pid!, "SIGTERM");
    } catch {
      child.kill();
    }
    await Promise.race([gone, sleep(5000)]);
  };
  try {
    let base: string | undefined;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && exited === undefined && !signal?.aborted) {
      if (await portOpen(port)) {
        base = `http://localhost:${port}`;
        break;
      }
      // A server that ignored PORT and says where it listens instead.
      const said = printed ? Number(/:(\d+)$/.exec(printed)?.[1]) : 0;
      if (said && said !== port && (await portOpen(said))) {
        base = printed;
        break;
      }
      await sleep(400);
    }
    const problems: string[] = [];
    if (!base) {
      const errs = tracker.errors({ all: true }).map((e) => e.message);
      problems.push(exited !== undefined ? `the app exited (code ${exited})${errs[0] ? `: ${errs[0]}` : ""}` : `the app didn't answer within ${Math.round(timeoutMs / 1000)} s`);
      return { started: false, problems, ms: Date.now() - t0, how: moved ? `on port ${port}` : `with PORT=${port}` };
    }
    // Let it settle (a first compile), then the page.
    await sleep(1000);
    let check: PageCheck | undefined;
    if (findBrowser()) {
      check = await checkPage({ url: base + pagePath, settleMs: 1500, timeoutMs: 45_000 }).catch(() => undefined);
    }
    if (check) {
      if (check.error) problems.push(check.error);
      if ((check.status ?? 0) >= 500) problems.push(`the page answered ${check.status}`);
      if (check.overlay) problems.push(`error overlay: ${check.overlay.slice(0, 200)}`);
      for (const e of check.exceptions) problems.push(e.text.split("\n")[0]);
      for (const e of check.consoleErrors) problems.push(`console: ${e.text.split("\n")[0]}`);
      for (const r of check.failedRequests) problems.push(`${r.method ?? "GET"} ${new URL(r.url, base).pathname} → ${r.status ?? r.error}`);
    } else {
      const status = await fetch(base + pagePath, { redirect: "manual" }).then((r) => r.status).catch(() => 0);
      if (!status || status >= 500) problems.push(status ? `the page answered ${status}` : "the page didn't answer");
    }
    await sleep(300);
    for (const e of tracker.errors({ all: true })) problems.push(`server: ${e.message}`);
    if (exited !== undefined) problems.push(`the app exited (code ${exited})`);
    return { started: exited === undefined, problems: [...new Set(problems)], ms: Date.now() - t0, how: moved ? `on port ${port}` : `with PORT=${port}` };
  } finally {
    await stop();
  }
}

/** Runs the app once as it is and once per value with that value blank, and says which values matter. */
export async function probeEnv(project: Project, options: EnvProbeOptions = {}): Promise<EnvProbe> {
  const t0 = Date.now();
  const pagePath = options.path && options.path.startsWith("/") && !options.path.startsWith("//") ? options.path : "/";
  const result: EnvProbe = { project: project.name, path: pagePath, baseline: { ok: false, problems: [], ms: 0, how: "" }, values: [], ms: 0 };
  if (!project.devCommand) {
    result.error = `${project.name} has no dev command to start it with.`;
    return result;
  }
  const keys = (options.keys?.length ? options.keys : envNames(project.dir)).filter((k) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(k)).slice(0, 200);
  if (!keys.length) {
    result.error = "There are no values in .env to try without.";
    return result;
  }
  const usage = envUsage(project.dir, keys);
  const used = keys.filter((k) => usage.get(k)!.length);
  const toRun = used.slice(0, options.max ?? 25);
  const total = toRun.length + 1;
  const timeout = options.startTimeoutMs ?? 60_000;

  options.progress?.(0, total, "as it is");
  const base = await runOnce(project, {}, pagePath, timeout, options.signal);
  result.baseline = { ok: base.started, problems: base.problems, ms: base.ms, how: base.how };
  if (!base.started) {
    result.error = `${project.name} didn't start on a port of its own as it is (${base.problems[0] ?? "no answer"}), so there's nothing to compare with.`;
    result.ms = Date.now() - t0;
    return result;
  }
  const known = new Set(base.problems.map(shape));
  for (const [i, key] of toRun.entries()) {
    if (options.signal?.aborted) {
      result.stopped = true;
      break;
    }
    options.progress?.(i + 1, total, key);
    const r = await runOnce(project, { [key]: "" }, pagePath, timeout, options.signal);
    const fresh = r.problems.filter((p) => !known.has(shape(p)));
    const verdict: EnvVerdict = !r.started ? "crashes" : fresh.length ? "breaks" : "unnoticed";
    const files = usage.get(key)!;
    result.values.push({ key, verdict, problems: fresh.slice(0, 8), usedIn: files.slice(0, 3), usedCount: files.length, ms: r.ms });
  }
  for (const key of keys) {
    if (result.values.some((v) => v.key === key)) continue;
    const files = usage.get(key)!;
    result.values.push({ key, verdict: files.length ? "skipped" : "unused", problems: [], usedIn: files.slice(0, 3), usedCount: files.length });
  }
  const order: Record<EnvVerdict, number> = { crashes: 0, breaks: 1, unnoticed: 2, unused: 3, skipped: 4 };
  result.values.sort((a, b) => order[a.verdict] - order[b.verdict]);
  result.ms = Date.now() - t0;
  return result;
}
