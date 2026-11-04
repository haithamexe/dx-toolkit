import {
  createSnapshot,
  listSnapshots,
  recordRun,
  removeSnapshot,
  resolveCommit,
  snapshotId,
  snapshotProject,
  type Project,
  type Snapshot,
} from "@dx/core";
import { clearDevServer, devServer, startDevServer, stopDevServer, type DevServerInfo, type StartedBy } from "./dev.js";

/**
 * Running commits from the dashboard: a snapshot is set up in the background (checkout, then
 * packages linked or installed), then its dev server starts like any other. The page follows
 * along through GET /api/snapshots.
 */

export interface SnapshotJob {
  phase: "creating" | "installing" | "starting" | "failed";
  step: string;
  /** The last lines the install printed. */
  lines: string[];
  /** How many lines it has printed in all, so a follower prints only what's new. */
  count: number;
  error?: string;
  startedAt: string;
}

export interface SnapshotView extends Partial<Snapshot> {
  id: string;
  name: string;
  project: string;
  projectDir: string;
  hash: string;
  short: string;
  subject: string;
  job?: SnapshotJob;
  dev?: DevServerInfo;
}

const jobs = new Map<string, SnapshotJob & { view: SnapshotView }>();

/** Registered snapshots with their dev server, and the ones still being set up; only `projectDir`'s when given. */
export function snapshotViews(projectDir?: string): SnapshotView[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const out = new Map<string, SnapshotView>();
  for (const s of listSnapshots()) {
    const job = jobs.get(s.id);
    out.set(s.id, { ...s, job: job && jobOf(job), dev: devServer(s.dir) });
  }
  for (const [id, job] of jobs) if (!out.has(id)) out.set(id, { ...job.view, job: jobOf(job) });
  return [...out.values()].filter((v) => !projectDir || same(v.projectDir, projectDir));
}

function jobOf(job: SnapshotJob): SnapshotJob {
  return { phase: job.phase, step: job.step, lines: job.lines.slice(-20), count: job.count, error: job.error, startedAt: job.startedAt };
}

/**
 * Runs `project` as it was at `hash`: makes the snapshot when it isn't there yet, then starts its
 * dev server. Answers as soon as the commit is known to exist; the rest goes on in the background.
 */
export async function runSnapshot(project: Project, hash: string, by: StartedBy = "dashboard"): Promise<SnapshotView> {
  const c = await resolveCommit(project.dir, hash);
  const id = snapshotId(project.name, c.hash);
  const busy = jobs.get(id);
  if (busy && busy.phase !== "failed") return { ...busy.view, job: jobOf(busy) };
  const known = listSnapshots().find((s) => s.id === id);
  const running = known && devServer(known.dir);
  if (known && running && (running.status === "starting" || running.status === "ready")) return { ...known, dev: running };

  const view: SnapshotView = { id, name: `${project.name}@${c.short}`, project: project.name, projectDir: project.dir, hash: c.hash, short: c.short, subject: c.subject, at: c.at };
  const job: SnapshotJob & { view: SnapshotView } = { phase: "creating", step: `Checking out ${c.short}`, lines: [], count: 0, startedAt: new Date().toISOString(), view };
  jobs.set(id, job);
  void (async () => {
    try {
      const snap = await createSnapshot(project, c.hash, {
        onStep: (step) => {
          job.step = step;
          if (step.startsWith("Installing")) job.phase = "installing";
        },
        onOutput: (line) => {
          job.lines.push(line.slice(0, 500));
          job.count++;
          if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200);
        },
      });
      if (snap.packages === "failed") throw new Error(`Installing ${snap.name}'s packages failed. ${job.lines.at(-1) ?? ""}`.trim());
      const runAs = snapshotProject(snap);
      if (!runAs) throw new Error(`${snap.name} isn't a project dx can run at that commit.`);
      job.phase = "starting";
      job.step = "Starting the dev server";
      clearDevServer(snap.dir);
      startDevServer(runAs, by, { snapshot: true });
      jobs.delete(id);
      recordRun("snapshot", true, `${snap.name} started (packages ${snap.packages})`, "web", { project: project.name });
    } catch (err) {
      job.phase = "failed";
      job.error = (err as Error).message;
      recordRun("snapshot", false, `${view.name}: ${job.error.split("\n")[0]}`, "web", { project: project.name });
    }
  })();
  return { ...view, job: jobOf(job) };
}

/** Stops a snapshot's dev server, waits for it to exit, and deletes its folder. */
export async function removeSnapshotRun(id: string): Promise<Snapshot> {
  const job = jobs.get(id);
  if (job && job.phase !== "failed") throw Object.assign(new Error("That snapshot is still being set up. Remove it once it's done."), { status: 409 });
  const s = listSnapshots().find((x) => x.id === id);
  if (!s) {
    if (job) {
      jobs.delete(id);
      return job.view as Snapshot;
    }
    throw Object.assign(new Error("That snapshot isn't there any more."), { status: 404 });
  }
  await stopDevServer(s.dir);
  for (let i = 0; i < 50; i++) {
    const d = devServer(s.dir);
    if (!d || (d.status !== "starting" && d.status !== "ready")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Windows keeps a folder busy for a moment after the process holding it ends.
  await new Promise((r) => setTimeout(r, process.platform === "win32" ? 300 : 0));
  clearDevServer(s.dir);
  jobs.delete(id);
  const removed = await removeSnapshot(id);
  recordRun("snapshot", true, `${s.name} removed`, "web", { project: s.project });
  return removed;
}
