import { parseArgs } from "node:util";
import { findProjects, loadConfig, openUrl, readProject, recordRun, scanProjects, type Project } from "@dx/core";
import { ensureDashboard, findDashboard, type DashboardClient } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, info, ok, UsageError, warn } from "../ui.js";

/**
 * Stacks run in the dashboard, so they keep going when the terminal closes (dx up), or follow in
 * this terminal and stop with Ctrl+C (dx go).
 */
interface DevInfo {
  project: string;
  dir: string;
  status: string;
  url?: string;
  localUrl?: string;
  command: string;
  service?: string;
  role?: string;
  errorCount: number;
  lastLine: number;
  services?: DevInfo[];
  note?: string;
}

function resolve(query: string | undefined): Project {
  if (!query || query === ".") {
    const here = readProject(process.cwd());
    if (here) return here;
    if (!query) throw new UsageError("Which project? Give its name, or run this inside its folder.");
    throw new UsageError(`${process.cwd()} doesn't look like a project.`);
  }
  const { match, candidates } = findProjects(query, scanProjects(loadConfig()));
  const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (project) return project;
  throw new UsageError(candidates.length ? `Several projects match "${query}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}` : `No project matches "${query}".`);
}

const STATUS: Record<string, (s: string) => string> = { ready: c.green, starting: c.yellow, failed: c.red, stopped: c.dim };

/** Prints a stack's services with their addresses. */
export function printServices(server: DevInfo): void {
  const list = server.services ?? [server];
  const width = Math.max(...list.map((s) => (s.service ?? s.project).length));
  for (const s of list) {
    const name = (s.service ?? s.project).padEnd(width);
    const where = s.localUrl ?? s.url;
    const errors = s.errorCount ? c.red(` ${s.errorCount} error(s)`) : "";
    console.log(`  ${c.bold(name)}  ${(STATUS[s.status] ?? String)(s.status.padEnd(8))} ${where ? c.cyan(where) : c.dim(s.command)}${errors}`);
  }
  if (server.note) warn(server.note);
}

/** Starts a project (its stack, or its dev command) in the dashboard and waits until it's up. */
export async function startInDashboard(project: Project, by: "terminal" | "ai" = "terminal"): Promise<{ client: DashboardClient; server: DevInfo }> {
  const client = await ensureDashboard();
  await client.post("/api/dev/start", { dir: project.dir, by });
  const r = await client.post<{ server: DevInfo; timedOut: boolean }>("/api/dev/wait", { dir: project.dir, until: "ready", after: 0, timeoutMs: 120_000 }, 130_000);
  return { client, server: r.server };
}

/** Follows the output in this terminal until Ctrl+C, which stops it. */
export async function follow(client: DashboardClient, project: Project, openWhenReady: boolean): Promise<number> {
  let after = 0;
  let opened = !openWhenReady;
  const colors = [c.cyan, c.magenta, c.yellow, c.green, c.blue];
  const serviceColor = new Map<string, (s: string) => string>();
  const tint = (svc: string) => {
    if (!serviceColor.has(svc)) serviceColor.set(svc, colors[serviceColor.size % colors.length]);
    return serviceColor.get(svc)!;
  };
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };
  process.on("SIGINT", onInterrupt);
  try {
    for (;;) {
      const r = await client.get<{ lines: { n: number; stream: string; text: string; service?: string }[]; server?: DevInfo }>(
        `/api/dev/logs?dir=${encodeURIComponent(project.dir)}&after=${after}`,
      );
      for (const l of r.lines) {
        const prefix = l.service ? tint(l.service)(`${l.service} │ `) : "";
        console.log(prefix + (l.stream === "err" ? c.red(l.text) : l.stream === "dx" ? c.dim(l.text) : l.text));
        after = l.n;
      }
      const server = r.server;
      if (!opened && server?.status === "ready" && (server.localUrl ?? server.url)) {
        opened = true;
        const url = server.localUrl ?? server.url!;
        try {
          await openUrl(url);
          ok(`Ready, opened ${c.cyan(url)}`);
        } catch {
          ok(`Ready at ${c.cyan(url)}`);
        }
      }
      if (interrupted) {
        info("Stopping…");
        await client.post("/api/dev/stop", { dir: project.dir });
        recordRun("go", true, `${project.name} stopped with Ctrl+C`, "cli", { project: project.name });
        return 0;
      }
      if (!server || server.status === "stopped") return 0;
      // A stack keeps going when one service fails; a single dev server is done.
      if (server.status === "failed" && !server.services) return 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

export const upCommand: Command = {
  name: "up",
  summary: "Start a project's whole stack in the background (front end, API, databases…)",
  usage: [
    "dx up                  the project in this folder",
    "dx up shop             a project by name",
    "dx up shop --open      and open it in the browser",
    "",
    "Services start in order: databases, then back ends, then front ends. They run in the dx dashboard,",
    "so they keep running after this terminal closes. dx down stops them; dx logs shop -f follows them.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { open: { type: "boolean" } } });
    const project = resolve(positionals[0]);
    info(`Starting ${c.bold(project.name)}…`);
    const { server } = await startInDashboard(project);
    printServices(server);
    const url = server.localUrl ?? server.url;
    if (server.status === "ready") ok(`${project.name} is up${url ? ` at ${c.cyan(url)}` : ""}`);
    else warn(`${project.name} is ${server.status}. dx logs ${project.name} shows why.`);
    if (values.open && url) await openUrl(url).catch(() => undefined);
    recordRun("up", server.status === "ready", project.name, "cli", { project: project.name });
    return server.status === "failed" ? 1 : 0;
  },
};

export const downCommand: Command = {
  name: "down",
  summary: "Stop a project's stack or dev server running in the dashboard",
  usage: ["dx down               the project in this folder", "dx down shop          a project by name"].join("\n"),
  async run(argv) {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true });
    const project = resolve(positionals[0]);
    const client = await findDashboard();
    const server = client && (await client.post<DevInfo | null>("/api/dev/stop", { dir: project.dir }));
    if (!server) {
      info(`${project.name} isn't running in the dashboard.`);
      return;
    }
    ok(`Stopped ${project.name}`);
    recordRun("down", true, project.name, "cli", { project: project.name });
  },
};
