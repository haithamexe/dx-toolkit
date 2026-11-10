import { gitRun, loadConfig, recordRun, scanProjectsCached, type GitRunOptions, type GitResult } from "@dx/core";
import { listDevServers } from "./dev.js";

/**
 * Keeps "3 behind" true without anyone pressing Fetch: every few minutes, for the projects you're
 * working in (a dev server dx runs, or a Code page looked at in the last half hour), dx runs
 * `git fetch --prune --no-tags`. It only updates the remote-tracking branches: never a merge, a
 * pull or a push, never a prompt (GIT_TERMINAL_PROMPT=0 in the runner), one project at a time.
 * Quiet under a test's or a demo's DX_HOME.
 */
const EVERY_MS = 5 * 60_000;
const VIEWED_MS = 30 * 60_000;
const viewed = new Map<string, number>();
const fetchedAt = new Map<string, number>();

type Run = (cwd: string, args: string[], options?: GitRunOptions) => Promise<GitResult>;

/** The Code page asked about this project: it's worth keeping fresh for a while. */
export function noteGitViewed(dir: string): void {
  viewed.set(dir.toLowerCase(), Date.now());
}

const refs = async (run: Run, dir: string) => (await run(dir, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes"])).stdout;

/** One fetch of one project; says whether the remote's branches moved. A project without a remote is skipped. */
export async function fetchProject(dir: string, name: string, run: Run = gitRun): Promise<"moved" | "same" | "skipped" | "failed"> {
  const remotes = await run(dir, ["remote"]);
  if (remotes.code !== 0 || !remotes.stdout.trim()) return "skipped";
  const before = await refs(run, dir);
  const r = await run(dir, ["fetch", "--prune", "--no-tags", "--no-recurse-submodules", "--quiet"], { timeoutMs: 60_000 });
  if (r.code !== 0) return "failed";
  const moved = (await refs(run, dir)) !== before;
  if (moved) recordRun("git-fetch", true, `${name}: new commits or branches on the remote`, "web", { project: name });
  return moved ? "moved" : "same";
}

/** Fetches what's due, one project at a time. `now` and `run` are for tests. */
export async function fetchDue(targets: { dir: string; name: string }[], now = Date.now(), run: Run = gitRun): Promise<string[]> {
  const done: string[] = [];
  for (const t of targets) {
    const key = t.dir.toLowerCase();
    if (now - (fetchedAt.get(key) ?? 0) < EVERY_MS) continue;
    fetchedAt.set(key, now);
    if ((await fetchProject(t.dir, t.name, run).catch(() => "failed")) !== "skipped") done.push(t.name);
  }
  return done;
}

export function startGitFetch(): () => void {
  if (process.env.DX_HOME) return () => undefined;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const open = new Set(listDevServers().map((s) => s.dir.toLowerCase()));
      for (const [dir, at] of viewed) if (now - at > VIEWED_MS) viewed.delete(dir);
      const targets = scanProjectsCached(loadConfig()).filter((p) => p.hasGit && (open.has(p.dir.toLowerCase()) || viewed.has(p.dir.toLowerCase())));
      await fetchDue(targets, now);
    } catch {
      // the next look tries again
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), 20_000);
  const timer = setInterval(() => void tick(), 60_000);
  first.unref();
  timer.unref();
  return () => (clearTimeout(first), clearInterval(timer));
}
