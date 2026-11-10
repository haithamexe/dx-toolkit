import { trimJobs } from "./jobs.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { gitRun, loadConfig, recordRun, scanProjects, type Project } from "@dx/core";
import { HttpError, type ApiRequest } from "./api.js";
import { dxVersion, readDashboardInfo } from "./link.js";
import { requestShutdown } from "./shutdown.js";

/**
 * Developing dx itself through an AI tool (`dev.*` actions): where dx's own source is among the
 * projects dx knows, building and testing it with fixed commands, restarting the dashboard onto the
 * new build, and reading, listing and writing files inside that repository only. Nothing takes a
 * folder or a command from the request: the repository is found here (a project whose package.json
 * is dx-toolkit's), the commands are `npm run build` and `npm test`, and a file is a path inside
 * it that isn't git's, node_modules, a build, or an .env file.
 */

const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".css", ".html", ".svg", ".txt", ".yml", ".yaml", ".sh", ".ps1"]);
const FILE_MAX = 1024 * 1024;
// A write comes in a request (at most 1 MB, escaped as JSON), so a file is written up to half of that.
const WRITE_MAX = 512 * 1024;
const FORBIDDEN = /^(\.git|node_modules|dist|release|\.env.*)$/i;
// Windows also answers to 8.3 short names (ENV~1.YML for .env.yml, GIT~1 for .git), which a name check can't see, so a part with ~digit is refused, and so is a colon (streams).
const SHORT_OR_STREAM = /~\d|:/;
const JOB_MAX_MS = 15 * 60_000;

/** dx's own repository: the project whose root package.json is dx-toolkit's, with the packages folder. */
export function dxSource(): Project | undefined {
  return scanProjects(loadConfig()).find((p) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(p.dir, "package.json"), "utf8")) as { name?: string };
      return pkg.name === "dx-toolkit" && fs.existsSync(path.join(p.dir, "packages", "core"));
    } catch {
      return false;
    }
  });
}

function source(): Project {
  const p = dxSource();
  if (!p) throw new HttpError(404, "dx's own source isn't one of your projects. Clone dx's repository into a projects folder (dx clone <its address>), then try again.");
  return p;
}

/** A path inside dx's repository for reading or writing, or an error saying why not. */
export function sourceFile(root: string, raw: unknown, _write: boolean): string {
  if (typeof raw !== "string" || !raw || raw.length > 300 || raw.includes("\0")) throw new HttpError(400, "A file is a path inside dx's repository.");
  const rel = raw.replace(/\\/g, "/");
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new HttpError(400, "A file is a path inside dx's repository, not an absolute one.");
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length || parts.some((s) => s === ".." || s === ".")) throw new HttpError(400, "No .. or . in a path.");
  if (parts.some((s) => SHORT_OR_STREAM.test(s))) throw new HttpError(400, "No ~1-style short names or colons in a path.");
  const bad = parts.find((s) => FORBIDDEN.test(s));
  if (bad) throw new HttpError(403, `${bad} isn't something dx's dev tools touch (git's folder, packages, builds and .env files).`);
  const ext = path.extname(parts[parts.length - 1]).toLowerCase();
  if (!TEXT_EXT.has(ext) && !(parts.length === 1 && /^[A-Z]+(\.md)?$/.test(parts[0]))) throw new HttpError(400, `Text files only (${[...TEXT_EXT].join(" ")}).`);
  const full = path.resolve(root, ...parts);
  const base = path.resolve(root);
  if (!full.startsWith(base + path.sep)) throw new HttpError(400, "A file is a path inside dx's repository.");
  // Links are never followed, in the file or in the folders above it.
  let cur = base;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(cur);
    } catch {
      break;
    }
    if (st.isSymbolicLink()) throw new HttpError(403, `${part} is a link: dx's dev tools don't follow links.`);
  }
  return full;
}

interface Job {
  id: string;
  task: "build" | "test";
  command: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  endedAt?: string;
  code?: number | null;
  output: string[];
  stop?: () => void;
}

const jobs = new Map<string, Job>();
const COMMANDS = { build: "npm run build", test: "npm test" } as const;

function startJob(task: "build" | "test", dir: string): Job {
  const running = [...jobs.values()].find((j) => j.status === "running");
  if (running) throw new HttpError(409, `${running.task} is already running (job ${running.id}). Wait for it, or read it with dev.job.`);
  const job: Job = { id: randomBytes(6).toString("hex"), task, command: COMMANDS[task], status: "running", startedAt: new Date().toISOString(), output: [] };
  jobs.set(job.id, job);
  trimJobs(jobs, 10, (j) => j.status !== "running");
  const push = (chunk: Buffer) => {
    for (const l of chunk.toString("utf8").split(/\r?\n/)) if (l) job.output.push(l.slice(0, 400));
    if (job.output.length > 600) job.output.splice(0, job.output.length - 600);
  };
  // A fixed command, run through a shell as every npm command here is on Windows.
  const child = spawn(job.command, { cwd: dir, shell: true, windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, FORCE_COLOR: "0", CI: "1" } });
  job.stop = () => killTree(child.pid);
  // A hung build or test ends here, so the next one can run.
  const timer = setTimeout(() => {
    job.output.push(`Stopped after ${JOB_MAX_MS / 60_000} minutes.`);
    job.status = "failed";
    job.stop?.();
  }, JOB_MAX_MS);
  timer.unref?.();
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.once("error", (err) => {
    job.status = "failed";
    job.output.push(`Couldn't start: ${err.message}`);
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    job.code = code;
    job.endedAt = new Date().toISOString();
    if (job.status === "running") job.status = code === 0 ? "passed" : "failed";
    recordRun("dev", job.status === "passed", `dx ${task} ${job.status} in ${Math.round((Date.parse(job.endedAt) - Date.parse(job.startedAt)) / 1000)} s`, "web");
  });
  return job;
}

/** The process and what it started: taskkill /T on Windows, the process group elsewhere. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
    else process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
}

/** Stops a build or test in progress (the dashboard is going away: nothing should rewrite dist under the next one). */
export function stopDevJobs(): void {
  for (const j of jobs.values()) if (j.status === "running") j.stop?.();
}

const view = (j: Job, tail = 80) => ({ id: j.id, task: j.task, command: j.command, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, code: j.code, output: j.output.slice(-tail) });

export const devToolsRoutes: Record<string, (req: ApiRequest) => unknown> = {
  // Where dx's source is, what's running, and whether the build on disk is newer than the running dashboard.
  "GET /api/dev-tools": async () => {
    const p = dxSource();
    const info = readDashboardInfo();
    const out: Record<string, unknown> = { version: dxVersion(), dashboard: info ? { pid: info.pid, startedAt: info.startedAt, version: info.version } : null, repository: null };
    if (!p) return { ...out, hint: "dx's own source isn't one of your projects: clone its repository into a projects folder to develop dx here." };
    const status = await gitRun(p.dir, ["status", "--porcelain=v1", "--branch"], { literal: false });
    const lines = status.code === 0 ? status.stdout.split(/\r?\n/).filter(Boolean) : [];
    let built: string | undefined;
    try {
      built = fs.statSync(path.join(p.dir, "packages", "web", "dist", "server.js")).mtime.toISOString();
    } catch {
      // not built yet
    }
    return { ...out, repository: { name: p.name, dir: p.dir, branch: lines[0]?.replace(/^## /, "").split("...")[0], changedFiles: Math.max(0, lines.length - 1), builtAt: built }, newerBuildThanDashboard: !!(built && info && Date.parse(built) > Date.parse(info.startedAt)), job: [...jobs.values()].slice(-1).map((j) => view(j, 5))[0] ?? null };
  },
  // `npm run build` or `npm test` in the repository, as a job to read with GET /api/dev-tools/job.
  "POST /api/dev-tools/run": (req) => {
    const task = req.body.task;
    if (task !== "build" && task !== "test") throw new HttpError(400, "A task is build or test.");
    const job = startJob(task, source().dir);
    recordRun("dev", true, `dx ${task} started`, "web");
    return view(job, 0);
  },
  "GET /api/dev-tools/job": (req) => {
    const job = jobs.get(req.query.get("id") ?? "");
    if (!job) throw new HttpError(404, "No such job (they're forgotten when the dashboard restarts).");
    const tail = Number(req.query.get("tail"));
    return view(job, Number.isInteger(tail) && tail > 0 ? Math.min(600, tail) : 80);
  },
  // Stops this dashboard, and the dev servers it runs, so the next call starts it from the current build.
  "POST /api/dev-tools/restart": () => {
    recordRun("dev", true, "dashboard restarting for a new build", "web");
    requestShutdown();
    return { ok: true, restarting: true, note: "The dashboard and the dev servers it runs stop now; the next dx call from an AI tool or dx ui starts it again from the current build." };
  },
  // The repository's files by name, or the lines that mention some words.
  "GET /api/dev-tools/files": async (req) => {
    const p = source();
    const search = (req.query.get("search") ?? "").trim().slice(0, 100);
    const inText = (req.query.get("text") ?? "").trim().slice(0, 100);
    if (inText) {
      const r = await gitRun(p.dir, ["grep", "-n", "-F", "-I", "--max-count=3", "-e", inText, "--", "packages", "docs", "README.md", "CLAUDE.md"], { literal: false });
      return { text: inText, matches: r.stdout.split(/\r?\n/).filter(Boolean).slice(0, 120).map((l) => l.slice(0, 300)) };
    }
    const r = await gitRun(p.dir, ["ls-files", "--cached", "--others", "--exclude-standard"], { literal: false });
    const files = r.stdout.split(/\r?\n/).filter((f) => f && !f.split("/").some((s) => FORBIDDEN.test(s)) && (!search || f.toLowerCase().includes(search.toLowerCase())));
    return { search, total: files.length, files: files.slice(0, 300) };
  },
  "GET /api/dev-tools/file": (req) => {
    const p = source();
    const full = sourceFile(p.dir, req.query.get("file"), false);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      throw new HttpError(404, "That file isn't there.");
    }
    if (!st.isFile()) throw new HttpError(400, "That isn't a file.");
    if (st.size > FILE_MAX) throw new HttpError(413, "A file over 1 MB isn't read here.");
    const all = fs.readFileSync(full, "utf8").split(/\r?\n/);
    const from = Math.max(1, Number(req.query.get("from")) || 1);
    const count = Math.min(2000, Math.max(1, Number(req.query.get("lines")) || 400));
    return { file: path.relative(p.dir, full).replace(/\\/g, "/"), lines: all.length, from, to: Math.min(all.length, from + count - 1), text: all.slice(from - 1, from - 1 + count).join("\n") };
  },
  // Writes a whole file (created, or replaced); the old text goes to the run log's note only as its size.
  "POST /api/dev-tools/file": (req) => {
    const p = source();
    const full = sourceFile(p.dir, req.body.file, true);
    if (typeof req.body.content !== "string") throw new HttpError(400, "content is the whole text of the file.");
    if (Buffer.byteLength(req.body.content) > WRITE_MAX) throw new HttpError(413, "A file over 512 KB isn't written here.");
    const existed = fs.existsSync(full);
    if (existed && !fs.statSync(full).isFile()) throw new HttpError(400, "That isn't a file.");
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, req.body.content);
    fs.renameSync(tmp, full);
    const rel = path.relative(p.dir, full).replace(/\\/g, "/");
    recordRun("dev", true, `${existed ? "changed" : "created"} ${rel} (${Buffer.byteLength(req.body.content)} bytes)`, "web");
    return { file: rel, created: !existed, bytes: Buffer.byteLength(req.body.content), next: "Build with dev.build and test with dev.test; the changes show in git.status." };
  },
};
