import {
  attentionItems,
  auditEnvAsync,
  findUnsavedWork,
  gitStatus,
  listAiTools,
  loadMocks,
  listProposals,
  loadConfig,
  mapLimit,
  nextSteps,
  readActivity,
  readChanges,
  readRuns,
  scanProjectsCached,
  startedSteps,
  type AttentionItem,
  type NextStep,
  type Problem,
  type Project,
  type ProjectFacts,
  type RunRecord,
  type StartedStep,
  type UnsavedWork,
} from "@dx/core";
import { knownProject, type ApiRequest } from "./api.js";
import { agentsWaiting } from "./agentwatch.js";
import { changeView, type ChangeView } from "./changesapi.js";
import { devProblem, listDevServers } from "./dev.js";

/**
 * Home and a project's summary (`GET /api/home`, `/api/project/summary`, `/api/next`): the facts
 * about every project gathered once, kept for a few seconds, and turned into one attention model
 * by core/attention.ts. The page polls these; the caches keep a poll cheap (git for 22 projects
 * is read at most every 15 s, the .env look for each project every minute).
 */

interface Kept<T> {
  at: number;
  value: T;
}
/** The first line of a message: what went wrong, without the output after it. */
const firstLine = (text: string): string => text.split(/\r?\n/)[0].trim();
const fresh = <T>(k: Kept<T> | undefined, ms: number): k is Kept<T> => !!k && Date.now() - k.at < ms;

let unsavedKept: Kept<Map<string, UnsavedWork>> | undefined;
const forgetKept = () => {
  unsavedKept = undefined;
  envKept.clear();
};
async function unsavedByDir(projects: Project[]): Promise<Map<string, UnsavedWork>> {
  if (fresh(unsavedKept, 15_000)) return unsavedKept.value;
  const list = await findUnsavedWork({ projects: projects.filter((p) => p.hasGit) }).catch(() => []);
  unsavedKept = { at: Date.now(), value: new Map(list.map((w) => [w.dir.toLowerCase(), w])) };
  return unsavedKept.value;
}

const envKept = new Map<string, Kept<ProjectFacts["env"]>>();
async function envFacts(p: Project): Promise<ProjectFacts["env"]> {
  const kept = envKept.get(p.dir.toLowerCase());
  if (fresh(kept, 60_000)) return kept.value;
  let value: ProjectFacts["env"];
  try {
    const audit = await auditEnvAsync(p.dir, { secrets: false });
    const exposed = audit.files.filter((f) => !f.example && (f.tracked || f.notIgnored)).map((f) => ({ name: f.name, tracked: f.tracked }));
    value = exposed.length ? { exposed, missingRules: audit.rules.filter((r) => !r.covered).map((r) => r.pattern) } : undefined;
  } catch {
    value = undefined;
  }
  envKept.set(p.dir.toLowerCase(), { at: Date.now(), value });
  return value;
}

/** The newest `test` run of each project, from the run log: "<project>: 47 passed, 1 failed". */
function testsByProject(runs: RunRecord[]): Map<string, NonNullable<ProjectFacts["tests"]>> {
  const out = new Map<string, NonNullable<ProjectFacts["tests"]>>();
  for (const r of runs) {
    if (r.tool !== "test" || !r.project) continue;
    const m = /(\d+) passed, (\d+) failed/.exec(r.detail ?? "");
    if (!m) continue;
    out.set(r.project, { ok: r.ok, passed: Number(m[1]), failed: Number(m[2]), at: r.at });
  }
  return out;
}

export async function factsFor(projects: Project[], runs: RunRecord[]): Promise<ProjectFacts[]> {
  const servers = listDevServers();
  const unsaved = await unsavedByDir(projects);
  const tests = testsByProject(runs);
  const waiting = agentsWaiting();
  return mapLimit(
    projects,
    4,
    async (p): Promise<ProjectFacts> => {
      const server = servers.find((s) => s.dir.toLowerCase() === p.dir.toLowerCase() && s.status !== "stopped");
      const w = unsaved.get(p.dir.toLowerCase());
      return {
        name: p.name,
        dir: p.dir,
        server: server ? { status: server.status, errorCount: server.errorCount, url: server.url, recorded: server.recorded, notRecorded: server.notRecorded } : undefined,
        unsaved: w ? { unpushed: w.unpushed, changed: w.changed, untracked: w.untracked, noRemote: w.noRemote, branch: w.branch } : undefined,
        env: p.hasGit ? await envFacts(p) : undefined,
        tests: tests.get(p.name),
        waiting: waiting.filter((x) => x.project === p.name).map((x) => ({ label: x.label, minutes: x.minutes })),
      };
    },
    (p) => ({ name: p.name, dir: p.dir }),
  );
}

let claudeKept: Kept<boolean> | undefined;
/** Whether any AI tool has dx connected. Asked rarely (it may start `claude`), never under a test's DX_HOME. */
async function claudeConnected(): Promise<boolean> {
  if (process.env.DX_HOME) return false;
  if (fresh(claudeKept, 5 * 60_000)) return claudeKept.value;
  const value = await listAiTools()
    .then((tools) => tools.some((t) => t.connected))
    .catch(() => false);
  claudeKept = { at: Date.now(), value };
  return value;
}

/** What dx itself did in the last day, from the changes list, with a way back where there is one. */
function didByDx(): ChangeView[] {
  const since = Date.now() - 24 * 3_600_000;
  return readChanges(50)
    .filter((c) => c.by === "dx" && !c.undone && Date.parse(c.at) > since)
    .slice(0, 5)
    .map(changeView);
}

export interface HomeView {
  at: string;
  projects: number;
  items: AttentionItem[];
  /** Projects with nothing that needs you. */
  quiet: number;
  running: { project: string; dir: string; url?: string; status: string; recorded?: boolean; notRecorded?: string }[];
  started: { steps: StartedStep[]; done: boolean };
  did: ReturnType<typeof didByDx>;
  /** What dx would do on its own but was told to ask about (or only suggest): waiting for you. */
  proposals: { id: string; capability: string; level: "ask" | "suggest"; project?: string; what: string; why?: string; at: string }[];
}

export async function homeView(): Promise<HomeView> {
  const projects = scanProjectsCached(loadConfig());
  const runs = readRuns(2000);
  const facts = await factsFor(projects, runs);
  const items = attentionItems(facts);
  const servers = listDevServers().filter((s) => s.status !== "stopped" && !s.snapshot && !s.service);
  const steps = startedSteps({
    projects: projects.length,
    claudeConnected: await claudeConnected(),
    ranAnApp: servers.length > 0 || runs.some((r) => r.tool === "go"),
    ranTests: runs.some((r) => r.tool === "test"),
  });
  const withItems = new Set(items.map((i) => i.dir.toLowerCase()));
  return {
    at: new Date().toISOString(),
    projects: projects.length,
    items,
    quiet: projects.filter((p) => !withItems.has(p.dir.toLowerCase())).length,
    running: servers.map((s) => ({ project: s.project, dir: s.dir, url: s.url, status: s.status, recorded: s.recorded, notRecorded: s.notRecorded })),
    started: { steps, done: steps.every((s) => s.done) },
    did: didByDx(),
    proposals: listProposals().map(({ id, capability, level, project, what, why, at }) => ({ id, capability, level, project, what, why, at })),
  };
}

export interface ProjectSummary {
  project: string;
  dir: string;
  server?: { status: string; url?: string; recorded?: boolean; notRecorded?: string; errorCount: number; startedAt: string; startedBy: string; step?: string; problem?: Problem; localUrl?: string };
  /** Mock mode for the project: whether dx answers its API calls, and how many endpoints it has. */
  mocks: { on: boolean; strict: boolean; endpoints: number };
  code?: { branch?: string; changed: number; ahead: number; behind: number; hasRemote: boolean };
  health: { tests?: NonNullable<ProjectFacts["tests"]>; secrets: "ok" | "exposed" | "committed" };
  activity: { requests: number; errors: number; lastPage?: string; lastAt?: string };
  next: NextStep[];
  /** Parts that couldn't be read, each in the one shape: the rest of the summary is still true. */
  problems: Problem[];
}

export async function projectSummary(project: Project): Promise<ProjectSummary> {
  const runs = readRuns(2000);
  const [facts] = await factsFor([project], runs);
  const server = listDevServers().find((s) => s.dir.toLowerCase() === project.dir.toLowerCase() && s.status !== "stopped");
  let code: ProjectSummary["code"];
  const problems: Problem[] = [];
  if (project.hasGit) {
    const status = await gitStatus(project.dir).catch((err: Error) => {
      problems.push({ code: "git-unreadable", message: `Git couldn't be read here, so Code is left out: ${firstLine(err.message)}` });
      return undefined;
    });
    if (status) code = { branch: status.branch, changed: status.files.length, ahead: status.ahead, behind: status.behind, hasRemote: !facts.unsaved?.noRemote };
  }
  const events = readActivity({ dir: project.dir, since: new Date(Date.now() - 3_600_000), limit: 1000 });
  const pages = events.filter((e) => e.type === "page" || e.type === "route");
  const last = pages[pages.length - 1];
  return {
    project: project.name,
    dir: project.dir,
    server: server ? { status: server.status, url: server.url, recorded: server.recorded, notRecorded: server.notRecorded, errorCount: server.errorCount, startedAt: server.startedAt, startedBy: server.startedBy, localUrl: server.localUrl, step: server.step, problem: server.status === "failed" ? ((await devProblem(server.dir).catch(() => undefined)) ?? server.problem) : undefined } : undefined,
    code,
    health: {
      tests: facts.tests,
      secrets: facts.env?.exposed.some((e) => e.tracked) ? "committed" : facts.env ? "exposed" : "ok",
    },
    activity: {
      requests: events.filter((e) => e.type === "request").length,
      errors: events.filter((e) => e.level === "error" || (e.status !== undefined && e.status >= 500)).length,
      lastPage: last?.page ?? last?.text,
      lastAt: last?.at,
    },
    problems,
    mocks: (() => {
      const m = loadMocks(project.dir, project.name);
      return { on: m.on, strict: !!m.strict, endpoints: m.endpoints.length };
    })(),
    next: nextSteps({ ...facts, unsaved: facts.unsaved ?? (code ? { unpushed: code.ahead, changed: code.changed, untracked: 0, noRemote: !code.hasRemote, branch: code.branch } : undefined) }),
  };
}

export const homeRoutes: Record<string, (req: ApiRequest) => unknown> = {
  // fresh=1 (after the page changed something) drops what was kept, so the answer is how things are now.
  "GET /api/home": (req) => {
    if (req.query.get("fresh") === "1") forgetKept();
    return homeView();
  },
  "GET /api/project/summary": async (req) => projectSummary(knownProject(req.query.get("dir"))),
  "GET /api/next": async (req) => ({ steps: (await projectSummary(knownProject(req.query.get("dir")))).next }),
};

