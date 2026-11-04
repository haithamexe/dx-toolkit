import { captureVisual, findBrowser, headCommit, isLoopbackUrl, loadConfig, recordRun, VisualError, type Project, type VisualCommit, type VisualViewport } from "@dx/core";
import { devServer, listDevServers, localRoutes } from "./dev.js";

/**
 * Visual diffs from the dashboard: after a commit made on the Git page, when HEAD moves under a
 * dev server dx runs, and on Capture now. Captures run in the background, one at a time per
 * project (a request while one runs makes one more afterwards), and never hold up the commit.
 */

interface Job {
  running?: Promise<void>;
  again?: { reason: string; source: string };
  last?: { at: string; ok: boolean; message: string; commit?: string };
}

const jobs = new Map<string, Job>();
const heads = new Map<string, string>();
const key = (dir: string) => (process.platform === "win32" ? dir.toLowerCase() : dir);

export function visualOn(): boolean {
  try {
    return loadConfig().visualDiff !== false;
  } catch {
    return true;
  }
}

/**
 * The dev server's own address, not dx's door in front of it: a capture shouldn't show up in
 * the activity history as a visit. Undefined when no dev server dx runs is ready for the project.
 */
export function visualTarget(dir: string): string | undefined {
  const info = devServer(dir);
  if (!info || info.status !== "ready" || info.snapshot) return undefined;
  for (const [host, route] of localRoutes()) {
    // name.localhost is the project (or its stack's front end); svc.name.localhost a service.
    if (host.split(".").length === 2 && key(route.dir) === key(dir) && isLoopbackUrl(route.url)) return route.url;
  }
  return info.url && isLoopbackUrl(info.url) ? info.url : undefined;
}

export interface VisualState {
  on: boolean;
  /** A browser was found to take screenshots with. */
  browser: boolean;
  /** The address captures are taken from, when a dev server dx runs is up. */
  target?: string;
  capturing: boolean;
  last?: Job["last"];
}

export function visualState(dir: string): VisualState {
  const job = jobs.get(key(dir));
  return { on: visualOn(), browser: !!findBrowser(), target: visualTarget(dir), capturing: !!job?.running, last: job?.last };
}

/**
 * Starts a capture in the background. Resolves at once with why it didn't start, if it didn't:
 * the setting is off, no dev server dx runs is up, or no browser.
 */
export function requestCapture(project: Pick<Project, "name" | "dir">, reason: string, source = "web", options: { force?: boolean } = {}): { started: boolean; queued?: boolean; reason?: string } {
  if (!options.force && !visualOn()) return { started: false, reason: "Visual diffs are off (visualDiff in the config)." };
  const target = visualTarget(project.dir);
  if (!target) return { started: false, reason: `Start ${project.name}'s dev server from dx first: captures are taken from it.` };
  if (!findBrowser()) return { started: false, reason: "No Chrome, Edge, Chromium or Brave was found to take the screenshots. dx doctor says how to get one." };
  const k = key(project.dir);
  const job = jobs.get(k) ?? {};
  jobs.set(k, job);
  if (job.running) {
    job.again = { reason, source };
    return { started: false, queued: true };
  }
  job.running = run(project, job, reason, source);
  return { started: true };
}

async function run(project: Pick<Project, "name" | "dir">, job: Job, reason: string, source: string): Promise<void> {
  const started = Date.now();
  try {
    const target = visualTarget(project.dir);
    if (!target) throw new VisualError(409, "The dev server stopped before the capture.");
    const viewports: VisualViewport[] = ["desktop"];
    try {
      if (loadConfig().visualMobile === true) viewports.push("mobile");
    } catch {
      // desktop only
    }
    const entry: VisualCommit = await captureVisual({ dir: project.dir, project: project.name, baseUrl: target, reason, viewports });
    const ok = entry.captures.some((c) => !c.error);
    const what = entry.changed === undefined ? "first capture" : entry.changed ? `look changed (${Math.round((entry.ratio ?? 0) * 1000) / 10}%)` : "looks the same";
    job.last = { at: new Date().toISOString(), ok, message: `${entry.commit.slice(0, 7)}: ${what}`, commit: entry.commit };
    heads.set(key(project.dir), entry.commit);
    recordRun("visual", ok, `${project.name}: ${entry.commit.slice(0, 7)} ${ok ? what : "no page could be captured"} (${entry.captures.length} page${entry.captures.length === 1 ? "" : "s"})`, source, { project: project.name, ms: Date.now() - started });
  } catch (err) {
    const message = (err as Error).message.split("\n")[0];
    job.last = { at: new Date().toISOString(), ok: false, message };
    recordRun("visual", false, `${project.name}: ${message}`, source, { project: project.name, ms: Date.now() - started });
  } finally {
    job.running = undefined;
    const again = job.again;
    job.again = undefined;
    if (again) requestCapture(project, again.reason, again.source);
  }
}

/** Waits for a project's capture, if one is running (for tests and the CLI's --capture through the API). */
export async function visualSettled(dir: string): Promise<void> {
  for (;;) {
    const job = jobs.get(key(dir));
    if (!job?.running) return;
    await job.running;
  }
}

/**
 * HEAD as the dashboard last saw it for a project. When it moves (a commit or checkout in a
 * terminal) under a dev server dx runs, the new commit is captured. The first sighting only
 * remembers it.
 */
export function noticeHead(project: Pick<Project, "name" | "dir">, head: string | undefined): void {
  if (!head) return;
  const k = key(project.dir);
  const before = heads.get(k);
  heads.set(k, head);
  if (before && before !== head && visualOn() && visualTarget(project.dir)) requestCapture(project, "head");
}

/** The commit route already captured this HEAD; don't capture it again when status sees it. */
export function sawHead(dir: string, head: string): void {
  heads.set(key(dir), head);
}

let watch: NodeJS.Timeout | undefined;

/** Every 30 s, HEAD of each project whose dev server dx runs (one cheap rev-parse each). */
export function startHeadWatch(everyMs = 30_000): () => void {
  stopHeadWatch();
  watch = setInterval(() => {
    if (!visualOn()) return;
    for (const s of listDevServers()) {
      if (s.status !== "ready" || s.snapshot) continue;
      void headCommit(s.dir).then((head) => noticeHead({ name: s.project, dir: s.dir }, head), () => undefined);
    }
  }, everyMs);
  watch.unref();
  return stopHeadWatch;
}

export function stopHeadWatch(): void {
  if (watch) clearInterval(watch);
  watch = undefined;
}
