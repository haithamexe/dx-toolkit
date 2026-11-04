import crypto from "node:crypto";
import { bundleUrl, compareReplay, recordRun, resolveCommit, type BugBundle, type Project, type ReplayVerdict } from "@dx/core";
import { checkUrl, type CheckResult } from "./check.js";
import { devServer, startDevServer } from "./dev.js";
import { runSnapshot, snapshotViews } from "./snapshots.js";

/**
 * Replaying a bug bundle someone sent: the commit it was recorded at runs as a snapshot (or your
 * working copy, when you choose), and once its dev server is ready the bundle's steps run in a
 * headless browser against that server's own address. The bundle's host is never used: only its
 * paths, on this project's server. It runs in the background; the page follows the job.
 */

export interface BugReplayJob {
  id: string;
  phase: "starting" | "setting-up" | "waiting" | "replaying" | "done" | "failed";
  step: string;
  project: string;
  /** "abc1234 (a snapshot)" or "your working copy". */
  target: string;
  url?: string;
  error?: string;
  verdict?: ReplayVerdict;
  result?: CheckResult;
  startedAt: string;
  finishedAt?: string;
}

const jobs = new Map<string, BugReplayJob>();
const SETUP_MS = 10 * 60_000;
const READY_MS = 3 * 60_000;

export function bugReplayJob(id: string): BugReplayJob | undefined {
  return jobs.get(id);
}

/** Starts the replay and answers at once with the job; `use` is "commit" (the bundle's, as a snapshot) or "working" (the project as it is). */
export async function startBugReplay(project: Project, bundle: BugBundle, use: "commit" | "working"): Promise<BugReplayJob> {
  // A commit is checked before anything starts: hex, and in this repository.
  const commit = use === "commit" ? await resolveCommit(project.dir, bundle.git?.commit ?? "") : undefined;
  const job: BugReplayJob = {
    id: crypto.randomBytes(8).toString("hex"),
    phase: "starting",
    step: commit ? `Checking out ${commit.short}` : "Starting the dev server",
    project: project.name,
    target: commit ? `${commit.short} (a snapshot)` : "your working copy",
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  for (const [id, j] of jobs) if (jobs.size > 20 && j.finishedAt) jobs.delete(id);
  void run(job, project, bundle, commit?.hash).catch((err: Error) => {
    job.phase = "failed";
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    recordRun("bug-replay", false, `${project.name}: ${err.message.split("\n")[0]}`, "web", { project: project.name });
  });
  return job;
}

async function run(job: BugReplayJob, project: Project, bundle: BugBundle, hash?: string): Promise<void> {
  let base: string;
  if (hash) {
    job.phase = "setting-up";
    const view = await runSnapshot(project, hash, "dashboard");
    base = await waitFor(SETUP_MS, () => {
      const v = snapshotViews(project.dir).find((s) => s.id === view.id);
      if (v?.job?.phase === "failed") throw new Error(v.job.error ?? "Setting up the snapshot failed.");
      if (v?.job) {
        // Still checking out or installing: an old run's server in that folder doesn't count yet.
        job.step = v.job.step;
        return undefined;
      }
      return readyUrl(v?.dev ?? (v?.dir ? devServer(v.dir) : undefined), job);
    });
  } else {
    const running = devServer(project.dir);
    if (!running || (running.status !== "starting" && running.status !== "ready")) startDevServer(project, "dashboard");
    job.phase = "waiting";
    job.step = "Waiting for the dev server";
    base = await waitFor(READY_MS, () => readyUrl(devServer(project.dir), job));
  }
  // The bundle's start path on this server, and nowhere else.
  const url = bundleUrl(base, bundle);
  job.url = url;
  job.phase = "replaying";
  job.step = bundle.steps.length ? `Replaying ${bundle.steps.length} step${bundle.steps.length === 1 ? "" : "s"}` : "Loading the page";
  const result = await checkUrl({ url, browser: true, steps: bundle.steps, timeoutMs: 60_000 });
  job.result = result;
  job.verdict = compareReplay(bundle.error, result.page, result.serverErrors);
  job.phase = "done";
  job.step = job.verdict.summary;
  job.finishedAt = new Date().toISOString();
  recordRun("bug-replay", true, `${project.name} at ${job.target}: ${job.verdict.summary}`, "web", { project: project.name });
}

function readyUrl(d: ReturnType<typeof devServer>, job: BugReplayJob): string | undefined {
  if (!d) return undefined;
  if (d.status === "failed" || d.status === "stopped") throw new Error(`The dev server ${d.status === "failed" ? "failed to start" : "stopped"}${d.exitCode !== undefined && d.exitCode !== null ? ` (exit code ${d.exitCode})` : ""}. The Projects page shows its output.`);
  if (d.status !== "ready") {
    job.phase = job.phase === "setting-up" ? "setting-up" : "waiting";
    job.step = "Waiting for the dev server";
    return undefined;
  }
  // Through its .localhost address when it has one, so the replay's requests are recorded too.
  return d.localUrl ?? d.url;
}

async function waitFor<T>(ms: number, check: () => T | undefined): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("The dev server didn't get ready in time. The Projects page shows its output.");
    await new Promise((r) => setTimeout(r, 300));
  }
}
