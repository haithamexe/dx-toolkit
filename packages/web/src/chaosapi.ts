import { execFile } from "node:child_process";
import crypto from "node:crypto";
import {
  CHAOS_FAULTS,
  CHAOS_LEVELS,
  ChaosError,
  chaosReport,
  checkPage,
  compareBehaviour,
  findGraveyard,
  isLoopbackUrl,
  loadChaos,
  PHONE,
  probeEnv,
  readActivity,
  recordRun,
  resolveCommit,
  runGremlins,
  setChaos,
  topVisitedPaths,
  type BehaviourDiff,
  type EnvProbe,
  type GremlinRun,
  type PageStep,
  type Project,
} from "@dx/core";
import { flushActivity } from "./activity.js";
import { HttpError, knownProject, replayOf, type ApiRequest } from "./api.js";
import { readyUrl, waitFor } from "./bugreplay.js";
import { restartChaosCount } from "./chaos.js";
import { devServer, startDevServer, stopDevServer } from "./dev.js";
import { dxBrowserStatus, setDxBrowserPhone } from "./dxbrowser.js";
import { runSnapshot, snapshotViews } from "./snapshots.js";

/**
 * The Chaos page: Chaos mode's settings and report, Gremlins, the fake clock, the weak phone,
 * one missing .env value at a time, behaviour diffs between commits and the endpoint graveyard.
 * Every route takes a known project's dir. Pages are only ever loaded from the project's own dev
 * server on this computer; commands are the project's own dev command; a commit must resolve in
 * the project's repository.
 */

export type JobKind = "gremlins" | "env" | "behaviour";

export interface ChaosJob {
  id: string;
  kind: JobKind;
  dir: string;
  project: string;
  phase: "starting" | "setting-up" | "waiting" | "running" | "done" | "failed" | "stopped";
  step: string;
  done: number;
  total: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result?: GremlinRun | EnvProbe | { against: string; diffs: BehaviourDiff[] };
}

const jobs = new Map<string, ChaosJob & { abort: AbortController }>();

function view(j: ChaosJob & { abort?: AbortController }): ChaosJob {
  const { abort: _abort, ...rest } = j;
  return rest;
}

function newJob(kind: JobKind, project: Project, step: string): ChaosJob & { abort: AbortController } {
  const running = [...jobs.values()].find((j) => j.kind === kind && j.dir === project.dir && !j.finishedAt);
  if (running) throw new HttpError(409, `One is already running for ${project.name}. Stop it first, or wait for it.`);
  const job = { id: crypto.randomBytes(8).toString("hex"), kind, dir: project.dir, project: project.name, phase: "starting" as const, step, done: 0, total: 0, startedAt: new Date().toISOString(), abort: new AbortController() };
  jobs.set(job.id, job);
  for (const [id, j] of jobs) if (jobs.size > 30 && j.finishedAt) jobs.delete(id);
  return job;
}

function finish(job: ChaosJob & { abort: AbortController }, err?: Error): void {
  if (err) {
    job.phase = "failed";
    job.error = err.message.split("\n")[0];
  } else job.phase = job.abort.signal.aborted ? "stopped" : "done";
  job.finishedAt = new Date().toISOString();
}

/** The project's dev server address on this computer (its .localhost one, so what happens is recorded), started when it isn't running. */
async function serverUrl(project: Project, job: ChaosJob): Promise<string> {
  const running = devServer(project.dir);
  if (!running || (running.status !== "starting" && running.status !== "ready")) startDevServer(project, "dashboard");
  job.phase = "waiting";
  job.step = "Waiting for the dev server";
  return waitFor(3 * 60_000, () => readyUrl(devServer(project.dir), job));
}

/** A path on the project's own server: one leading slash, never another host. */
function onServer(base: string, raw: unknown): string {
  const p = typeof raw === "string" && raw.trim() ? raw.trim() : "/";
  if (!p.startsWith("/") || p.startsWith("//") || /[\r\n]/.test(p)) throw new HttpError(400, "The page is a path on the project's own server, like /checkout.");
  const url = new URL(p, base);
  if (url.origin !== new URL(base).origin || !isLoopbackUrl(url.href)) throw new HttpError(400, "Only pages on the project's own server.");
  return url.href;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? dflt : Math.min(max, Math.max(min, Math.round(n)));
}

function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("git", args, { cwd: dir, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (err, out) => (err ? reject(err) : resolve(String(out).trim()))),
  );
}

export const chaosRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/chaos": (req) => {
    const project = knownProject(req.query.get("dir"));
    const config = loadChaos(project.dir, project.name);
    const mine = [...jobs.values()].filter((j) => j.dir === project.dir).map(view);
    const latest = (kind: JobKind) => mine.filter((j) => j.kind === kind).at(-1);
    return {
      config,
      levels: Object.entries(CHAOS_LEVELS).map(([id, l]) => ({ id, name: l.name, about: l.about, faults: Object.keys(l.odds) })),
      faults: CHAOS_FAULTS,
      phone: { ...PHONE, browser: dxBrowserStatus() },
      jobs: { gremlins: latest("gremlins"), env: latest("env"), behaviour: latest("behaviour") },
    };
  },

  "POST /api/chaos": async (req) => {
    const project = knownProject(req.body.dir);
    const patch: Record<string, unknown> = {};
    for (const k of ["on", "level", "faults", "seed", "paths", "clock", "phone", "restart"]) if (req.body[k] !== undefined) patch[k] = req.body[k];
    let config;
    try {
      config = setChaos(project.dir, project.name, patch);
    } catch (err) {
      if (err instanceof ChaosError) throw new HttpError(400, err.message);
      throw err;
    }
    if (patch.restart || patch.seed !== undefined || patch.on === true) restartChaosCount(project.dir);
    if (patch.phone !== undefined) await setDxBrowserPhone(config.phone === true);
    const said: string[] = [];
    if (patch.on !== undefined) said.push(config.on ? `chaos on (${CHAOS_LEVELS[config.level].name}, #${config.seed})` : "chaos off");
    if (patch.clock !== undefined) said.push(config.clock ? `clock ${config.clock.at ?? "now"}${config.clock.timeZone ? ` in ${config.clock.timeZone}` : ""}` : "real clock");
    if (patch.phone !== undefined) said.push(config.phone ? "weak phone on" : "weak phone off");
    recordRun("chaos", true, `${project.name}: ${said.join(", ") || "settings changed"}`, "web", { project: project.name });
    return config;
  },

  "GET /api/chaos/report": (req) => {
    const project = knownProject(req.query.get("dir"));
    const config = loadChaos(project.dir, project.name);
    flushActivity();
    const since = config.startedAt ? new Date(config.startedAt) : new Date(Date.now() - 3_600_000);
    return chaosReport(readActivity({ dir: project.dir, since, limit: 20_000 }), since.toISOString());
  },

  // ------------------------------------------------------------ jobs
  "GET /api/chaos/job": (req) => {
    const job = jobs.get(String(req.query.get("id") ?? ""));
    if (!job) throw new HttpError(404, "That run isn't here any more (runs are kept until the dashboard restarts).");
    knownProject(job.dir);
    return view(job);
  },
  "POST /api/chaos/job/stop": (req) => {
    const job = jobs.get(String(req.body.id ?? ""));
    if (!job) throw new HttpError(404, "That run isn't here any more.");
    knownProject(job.dir);
    job.abort.abort();
    job.step = "Stopping after this step";
    return view(job);
  },

  "POST /api/chaos/gremlins": (req) => {
    const project = knownProject(req.body.dir);
    const config = loadChaos(project.dir, project.name);
    const actions = clampInt(req.body.actions, 5, 300, 40);
    const seed = clampInt(req.body.seed, 1, 2 ** 31, 1000 + crypto.randomInt(9000));
    const bold = req.body.bold === true;
    const phone = req.body.phone === undefined ? config.phone === true : req.body.phone === true;
    const job = newJob("gremlins", project, "Starting");
    job.total = actions;
    void (async () => {
      const url = onServer(await serverUrl(project, job), req.body.path);
      job.phase = "running";
      job.step = `Gremlins #${seed} loose on ${new URL(url).pathname}`;
      const run = await runGremlins({ url, actions, seed, bold, emulate: phone ? { phone: true, timeZone: config.clock?.timeZone } : config.clock?.timeZone ? { timeZone: config.clock.timeZone } : undefined, signal: job.abort.signal, progress: (done, total, step) => ((job.done = done), (job.total = total), (job.step = stepText(step))) });
      job.result = run;
      job.step = run.findings.length ? `${run.findings.length} problem${run.findings.length === 1 ? "" : "s"} in ${run.actions} actions` : `No problems in ${run.actions} actions`;
      finish(job);
      recordRun("gremlins", run.findings.length === 0, `${project.name}: ${job.step} (#${seed})`, "web", { project: project.name });
    })().catch((err: Error) => {
      finish(job, err);
      recordRun("gremlins", false, `${project.name}: ${job.error}`, "web", { project: project.name });
    });
    return view(job);
  },

  "POST /api/chaos/env": (req) => {
    const project = knownProject(req.body.dir);
    const pagePath = typeof req.body.path === "string" && req.body.path.startsWith("/") && !req.body.path.startsWith("//") ? req.body.path.slice(0, 300) : "/";
    const job = newJob("env", project, "Starting the app as it is");
    void (async () => {
      job.phase = "running";
      const r = await probeEnv(project, { path: pagePath, signal: job.abort.signal, progress: (done, total, key) => ((job.done = done), (job.total = total), (job.step = done === 0 ? "Starting the app with every value" : `Without ${key}`)) });
      job.result = r;
      if (r.error) throw new Error(r.error);
      const bad = r.values.filter((v) => v.verdict === "crashes" || v.verdict === "breaks").length;
      job.step = `${bad} of ${r.values.length} value${r.values.length === 1 ? "" : "s"} matter${bad === 1 ? "s" : ""} when missing`;
      finish(job);
      recordRun("env-probe", true, `${project.name}: ${job.step}`, "web", { project: project.name });
    })().catch((err: Error) => {
      finish(job, err);
      recordRun("env-probe", false, `${project.name}: ${job.error}`, "web", { project: project.name });
    });
    return view(job);
  },

  "POST /api/chaos/behaviour": async (req) => {
    const project = knownProject(req.body.dir);
    // The commit to compare with: given, else HEAD when there are changes, else the one before it.
    let wanted = typeof req.body.commit === "string" ? req.body.commit.trim() : "";
    if (wanted && !/^[0-9a-f]{4,40}$/i.test(wanted)) throw new HttpError(400, "A commit is 4 to 40 hex characters.");
    if (!wanted) {
      const dirty = await git(project.dir, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "");
      wanted = await git(project.dir, ["rev-parse", dirty ? "HEAD" : "HEAD^"]).catch(() => "");
      if (!wanted) throw new HttpError(400, "There's no earlier commit to compare with.");
    }
    const commit = await resolveCommit(project.dir, wanted).catch(() => {
      throw new HttpError(400, "That commit isn't in this project's repository.");
    });
    let steps: PageStep[] | undefined;
    let start: string | undefined;
    if (typeof req.body.visit === "string" && req.body.visit) {
      const replay = replayOf(project.dir, req.body.visit);
      steps = replay.steps;
      start = new URL(replay.url).pathname + new URL(replay.url).search;
    }
    const paths = start ? [start] : Array.isArray(req.body.paths) && req.body.paths.length ? req.body.paths.slice(0, 3).map(String) : topVisitedPaths(project.dir, { limit: 3 });
    const job = newJob("behaviour", project, `Checking out ${commit.short}`);
    job.total = paths.length * 2;
    void (async () => {
      job.phase = "setting-up";
      const snap = await runSnapshot(project, commit.hash, "dashboard");
      const before = await waitFor(10 * 60_000, () => {
        const v = snapshotViews(project.dir).find((s) => s.id === snap.id);
        if (v?.job?.phase === "failed") throw new Error(v.job.error ?? "Setting up the snapshot failed.");
        if (v?.job) {
          job.step = v.job.step;
          return undefined;
        }
        return readyUrl(v?.dev ?? (v?.dir ? devServer(v.dir) : undefined), job);
      });
      const after = await serverUrl(project, job);
      job.phase = "running";
      const diffs: BehaviourDiff[] = [];
      try {
        for (const p of paths) {
          if (job.abort.signal.aborted) break;
          job.step = `${commit.short}: ${p}`;
          const a = await checkPage({ url: onServer(before, p), steps, requests: true, settleMs: 2000, timeoutMs: 60_000 });
          job.done++;
          job.step = `Your working copy: ${p}`;
          const b = await checkPage({ url: onServer(after, p), steps, requests: true, settleMs: 2000, timeoutMs: 60_000 });
          job.done++;
          diffs.push(compareBehaviour(a, b, p));
        }
      } finally {
        // The snapshot stays (Run any commit lists it); its server doesn't need to keep running.
        const v = snapshotViews(project.dir).find((s) => s.id === snap.id);
        if (v?.dir) await stopDevServer(v.dir).catch(() => undefined);
      }
      job.result = { against: `${commit.short} ${commit.subject ?? ""}`.trim(), diffs };
      const worse = diffs.reduce((n, d) => n + d.changes.filter((c) => c.tone === "worse").length, 0);
      const all = diffs.reduce((n, d) => n + d.changes.length, 0);
      job.step = all ? `${all} change${all === 1 ? "" : "s"} since ${commit.short}${worse ? `, ${worse} for the worse` : ""}` : `Behaves the same as ${commit.short}`;
      finish(job);
      recordRun("behaviour", worse === 0, `${project.name}: ${job.step}`, "web", { project: project.name });
    })().catch((err: Error) => {
      finish(job, err);
      recordRun("behaviour", false, `${project.name}: ${job.error}`, "web", { project: project.name });
    });
    return view(job);
  },

  "GET /api/chaos/graveyard": (req) => {
    const project = knownProject(req.query.get("dir"));
    flushActivity();
    return findGraveyard(project.dir, project.name, { days: clampInt(req.query.get("days"), 1, 90, 30) });
  },
};

function stepText(s: PageStep): string {
  if (s.click) return `${s.double ? "Double-clicked" : "Clicked"} ${s.click}`;
  if (s.type !== undefined) return `Typed ${JSON.stringify(s.type.length > 24 ? `${s.type.slice(0, 24)}…` : s.type)}${s.into ? ` into ${s.into}` : ""}`;
  if (s.press) return `Pressed ${s.press}`;
  if (s.back) return "Went back";
  if (s.goto) return `Went to ${s.goto}`;
  return "…";
}
