import { detectStack, queryLogState, queryReport, readActivity, type Problem, type ServiceRole, type Stack } from "@dx/core";
import { knownProject, type ApiRequest } from "./api.js";
import { devProblem, devServer, type DevServerInfo } from "./dev.js";

/**
 * A project's stack as a map (`GET /api/graph?dir=`): its services as nodes, what each one is
 * doing now, and who calls whom. The shape is read from the stack dx found (core/stacks.ts: a
 * service's `dependsOn`, else its role: front ends call back ends, back ends call data), the state
 * from the dev servers dx runs, and the traffic from the activity history: how many requests each
 * service answered per minute over the last five minutes. dx never makes a call to learn any of it.
 */

export interface GraphNode {
  id: string;
  name: string;
  role: ServiceRole;
  kind: "process" | "docker";
  /** The column it sits in: 0 front ends, 1 back ends and the rest, 2 data. */
  tier: number;
  status: "stopped" | "starting" | "ready" | "failed";
  port?: number;
  url?: string;
  recorded?: boolean;
  errorCount: number;
  /** While it starts: what it is doing. */
  step?: string;
  /** When it failed: why, and the ways out. */
  problem?: Problem;
  /** Requests it answered per minute over the last five (those dx sees: through its own addresses). */
  perMinute: number;
  command: string;
  /** A database whose queries dx logs (Queries per request): how many since, and the slowest statement shape. */
  queries?: { count: number; slowest?: { shape: string; ms: number; count: number } };
}

export interface GraphEdge {
  from: string;
  to: string;
  /** What the callee answered per minute: the traffic on this line. */
  perMinute: number;
  /** Whether the line was declared (the service says what it needs) or inferred from the roles. */
  declared: boolean;
}

export interface Graph {
  project: string;
  dir: string;
  /** False for a project that runs as one app. */
  stack: boolean;
  /** The stack runs through one command, so its services restart together. */
  runner?: boolean;
  source?: Stack["source"];
  status?: DevServerInfo["status"];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Counts for the header: "5 services · 3 running behind dx · 2 in Docker". */
  totals: { services: number; running: number; docker: number; failing: number };
}

const TIER: Record<ServiceRole, number> = { frontend: 0, backend: 1, other: 1, data: 2 };
const WINDOW_MIN = 5;

const portOf = (url: string | undefined): number | undefined => {
  try {
    const p = url ? Number(new URL(url).port) : 0;
    return p > 0 ? p : undefined;
  } catch {
    return undefined;
  }
};

/** A back end that takes work from a queue or a clock, which nothing in front calls. */
const WORKER = /worker|queue|job|cron|consumer|scheduler|runner/i;

/**
 * Who calls whom. When the stack's dependencies were written by a person or an agent (`explicit`:
 * .devrc.json), those are the lines. Otherwise they are inferred from the roles and drawn dashed:
 * front ends call back ends (not workers), back ends reach the data. A dependency dx worked out
 * itself is a start-up order, not a call, so it isn't drawn as one.
 */
export function graphEdges(services: { name: string; role: ServiceRole; dependsOn: string[] }[], perMinute: (name: string) => number, explicit = false): GraphEdge[] {
  const names = new Set(services.map((s) => s.name));
  const edges: GraphEdge[] = [];
  if (explicit && services.some((s) => s.dependsOn.some((d) => names.has(d)))) {
    for (const s of services) for (const d of s.dependsOn) if (names.has(d) && d !== s.name) edges.push({ from: s.name, to: d, perMinute: perMinute(d), declared: true });
    return edges;
  }
  const of = (role: ServiceRole) => services.filter((s) => s.role === role);
  const backs = of("backend");
  const served = backs.filter((b) => !WORKER.test(b.name));
  const data = of("data");
  for (const f of of("frontend")) for (const b of served.length ? served : data) edges.push({ from: f.name, to: b.name, perMinute: perMinute(b.name), declared: false });
  for (const b of backs) for (const d of data) edges.push({ from: b.name, to: d.name, perMinute: perMinute(d.name), declared: false });
  return edges;
}

/** What a logged database has seen, kept for a few seconds: reading its log asks Docker, and the map is read often. */
const queryCache = new Map<string, { at: number; value: GraphNode["queries"] | null }>();

async function queriesOf(project: { name: string; dir: string }): Promise<{ service: string; queries: NonNullable<GraphNode["queries"]> } | undefined> {
  const state = queryLogState(project.dir);
  if (!state?.service) return undefined;
  const hit = queryCache.get(project.dir.toLowerCase());
  if (hit && Date.now() - hit.at < 15_000) return hit.value ? { service: state.service, queries: hit.value } : undefined;
  try {
    const r = await queryReport(project, [], {});
    const top = [...r.top].sort((a, b) => b.ms - a.ms)[0];
    const value = { count: r.queries, slowest: top ? { shape: top.shape.slice(0, 160), ms: Math.round(top.ms), count: top.count } : undefined };
    queryCache.set(project.dir.toLowerCase(), { at: Date.now(), value });
    return { service: state.service, queries: value };
  } catch {
    queryCache.set(project.dir.toLowerCase(), { at: Date.now(), value: null });
    return undefined;
  }
}

export async function buildGraph(project: { name: string; dir: string }): Promise<Graph> {
  const stack = detectStack(project as never);
  if (!stack || stack.services.length < 2) return { project: project.name, dir: project.dir, stack: false, nodes: [], edges: [], totals: { services: 0, running: 0, docker: 0, failing: 0 } };
  const run = devServer(project.dir);
  const live = new Map((run?.services ?? []).map((s) => [s.service ?? "", s]));
  const since = new Date(Date.now() - WINDOW_MIN * 60_000);
  const answered = new Map<string, number>();
  for (const e of readActivity({ dir: project.dir, since, limit: 5000 })) if (e.type === "request" && e.service) answered.set(e.service, (answered.get(e.service) ?? 0) + 1);
  const perMinute = (name: string) => Math.round(((answered.get(name) ?? 0) / WINDOW_MIN) * 10) / 10;
  const logged = await queriesOf(project);
  const failed = [...live.values()].some((s) => s.status === "failed");
  const why = failed ? await devProblem(project.dir).catch(() => undefined) : undefined;
  const nodes: GraphNode[] = stack.services.map((svc) => {
    const info = live.get(svc.name);
    return {
      id: svc.name,
      name: svc.name,
      role: svc.role,
      kind: svc.kind,
      tier: TIER[svc.role],
      status: info?.status ?? "stopped",
      port: svc.hostPort ?? portOf(info?.url) ?? portOf(svc.url),
      url: info?.url,
      recorded: info?.recorded,
      errorCount: info?.errorCount ?? 0,
      step: info?.step,
      problem: info?.status === "failed" ? (info.problem ?? why) : undefined,
      perMinute: perMinute(svc.name),
      command: svc.command,
      ...(logged && logged.service === svc.name ? { queries: logged.queries } : {}),
    };
  });
  return {
    project: project.name,
    dir: project.dir,
    stack: true,
    ...(stack.runner ? { runner: true } : {}),
    source: stack.source,
    status: run?.status,
    nodes,
    edges: graphEdges(stack.services, perMinute, stack.source === "devrc"),
    totals: {
      services: nodes.length,
      running: nodes.filter((n) => n.status === "ready" || n.status === "starting").length,
      docker: nodes.filter((n) => n.kind === "docker").length,
      failing: nodes.filter((n) => n.status === "failed" || n.errorCount > 0).length,
    },
  };
}

export const graphRoutes: Record<string, (req: ApiRequest) => unknown> = {
  "GET /api/graph": (req) => buildGraph(knownProject(req.query.get("dir"))),
};
