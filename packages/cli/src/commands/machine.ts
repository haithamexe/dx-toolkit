import { parseArgs } from "node:util";
import {
  checkProjectNeeds,
  checkTools,
  dockerInfo,
  formatBytes,
  installedTools,
  latestVersions,
  listDevProcesses,
  loadConfig,
  recordRun,
  scanProjects,
  stopDevProcess,
  supportedNodeLines,
  type DevProcess,
  type ProjectNeeds,
  type ToolInfo,
} from "@dx/core";
import { findDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, confirm, ok, relativeTime, table, UsageError } from "../ui.js";

const SECTIONS = ["tools", "projects", "processes", "docker"] as const;
type Section = (typeof SECTIONS)[number];

export const machineCommand: Command = {
  name: "machine",
  aliases: ["mc"],
  summary: "Outdated tools, projects that don't match this computer, and what's running in the background",
  usage: [
    "dx machine                 tools to update, projects that don't match, processes left behind",
    "dx machine tools           every tool: version, newest, support, and the update command",
    "dx machine projects        what each project needs (.nvmrc, engines, lock files…) next to what's installed",
    "dx machine processes       dev servers, watchers and tools running, with memory and CPU",
    "dx machine docker          containers and the space Docker can free",
    "dx machine --stop <pid>    stop a process from the list (asks first)",
    "  --all       list everything, not only what needs attention",
    "  --offline   don't look up the newest versions",
    "  --json      machine-readable output",
    "",
    "The dashboard's Machine page shows the same, with buttons that open the fixes in a terminal.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        all: { type: "boolean", short: "a" },
        offline: { type: "boolean" },
        json: { type: "boolean" },
        stop: { type: "string" },
      },
    });
    const owners = await dxPids();

    if (values.stop !== undefined) {
      const pid = Number(values.stop);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new UsageError("--stop takes a PID from dx machine processes.");
      const projects = scanProjects(loadConfig());
      const p = (await listDevProcesses({ projects, ownerPids: owners })).find((x) => x.pid === pid);
      if (!p) throw new UsageError(`PID ${pid} isn't in the list. dx machine processes shows what can be stopped.`);
      if (!(await confirm(`Stop ${p.label}${p.project ? ` in ${p.project}` : ""} (PID ${pid}${p.children.length ? ` and ${p.children.length} child process(es)` : ""})?`))) return;
      const r = await stopDevProcess(pid, { projects, ownerPids: owners });
      recordRun("machine", r.ok, `stop ${r.label ?? "process"} (PID ${pid}): ${r.message}`, "cli");
      if (!r.ok) throw new UsageError(r.message);
      ok(r.message);
      return;
    }

    const wanted = positionals[0] as Section | undefined;
    if (wanted && !SECTIONS.includes(wanted)) throw new UsageError(`Unknown part "${wanted}". Use ${SECTIONS.join(", ")}.`);
    const show = (s: Section) => !wanted || wanted === s;
    const all = values.all || Boolean(wanted);
    const projects = scanProjects(loadConfig());

    const [tools, needs, processes, docker] = await Promise.all([
      show("tools") ? checkTools({ offline: values.offline }) : undefined,
      show("projects") ? projectNeeds(projects, values.offline) : undefined,
      show("processes") ? listDevProcesses({ projects, ownerPids: owners }) : undefined,
      wanted === "docker" ? dockerInfo() : undefined,
    ]);

    if (values.json) {
      console.log(JSON.stringify({ tools, projects: needs, processes, docker }, null, 2));
      return;
    }
    if (tools) printTools(tools, all);
    if (needs) printNeeds(needs, all);
    if (processes) printProcesses(processes, all);
    if (docker) {
      if (!docker.installed) console.log(c.dim("Docker isn't installed."));
      else if (!docker.running) console.log(c.yellow("Docker isn't running."));
      else {
        console.log(c.bold("Containers"));
        console.log(table(["NAME", "STATE", "MEMORY", "IMAGE"], docker.containers.map((x) => [x.name, x.state === "running" ? c.green("running") : c.dim(x.state), x.memory ?? "", x.image])));
        console.log(`\n${c.bold("On disk")}`);
        console.log(table(["KIND", "SIZE", "CAN FREE"], docker.disk.map((d) => [d.type, d.size, d.reclaimable])));
        console.log(c.dim("\nFree space from the dashboard's Machine page, or with docker system prune."));
      }
    }
  },
};

async function projectNeeds(projects: ReturnType<typeof scanProjects>, offline?: boolean): Promise<ProjectNeeds[]> {
  const [installed, latest] = await Promise.all([installedTools(), offline ? undefined : latestVersions().catch(() => undefined)]);
  return checkProjectNeeds(projects, installed, { nodeLines: supportedNodeLines(latest) });
}

/** The running dashboard and the dev servers it runs: those are dx's, not left behind. */
async function dxPids(): Promise<number[]> {
  const pids = [process.pid];
  try {
    const client = await findDashboard();
    if (!client) return pids;
    pids.push(client.info.pid);
    const servers = (await client.get("/api/dev")) as Array<{ pid?: number; services?: Array<{ pid?: number }> }>;
    for (const s of servers) for (const x of [s, ...(s.services ?? [])]) if (x.pid) pids.push(x.pid);
  } catch {
    // no dashboard: nothing of dx's is running
  }
  return pids;
}

function printTools(tools: ToolInfo[], all: boolean) {
  const shown = tools.filter((t) => t.installed && (all || !["ok", "unknown"].includes(t.status)));
  console.log(c.bold("Tools"));
  if (!shown.length) {
    console.log(c.green(`  ✓ ${tools.filter((t) => t.installed).length} tools, all up to date.`) + c.dim(all ? "" : "  dx machine tools lists them."));
  } else {
    const mark = (t: ToolInfo) => (t.status === "unsupported" ? c.red("✗") : t.status === "ok" ? c.green("✓") : t.status === "unknown" ? c.dim("·") : c.yellow("!"));
    console.log(
      table(
        ["", "TOOL", "VERSION", "NEWEST", "STATUS"],
        shown.map((t) => [mark(t), t.name, t.version ?? "", t.latest ?? "", t.detail]),
      ),
    );
    for (const t of shown.filter((x) => x.fix && x.status !== "ok")) console.log(`  ${c.dim(`${t.name}:`)} ${t.runnable ? c.cyan(t.fix!) : t.fix}`);
  }
  console.log("");
}

function printNeeds(needs: ProjectNeeds[], all: boolean) {
  const shown = needs.filter((p) => all || p.problems > 0);
  console.log(c.bold("Your projects"));
  if (!shown.length) console.log(c.green(`  ✓ All ${needs.length} projects find the tools and versions they ask for.`));
  for (const p of shown) {
    console.log(`  ${c.bold(p.project)}  ${p.needs.map((n) => (n.ok ? c.dim(n.label) : n.problem === "missing" ? c.red(n.label) : c.yellow(n.label))).join(c.dim(", ")) || c.dim("nothing it names")}`);
    for (const n of p.needs.filter((x) => !x.ok)) {
      console.log(`    ${n.problem === "missing" ? c.red("✗") : c.yellow("!")} ${n.problem === "missing" ? `${n.label} isn't installed` : `${n.label}, you have ${n.installed}`} ${c.dim(`(${n.source})`)}`);
      if (n.fix) console.log(`      ${n.runnable ? `${c.dim("in its folder:")} ${c.cyan(n.fix)}` : c.dim(n.fix)}`);
    }
  }
  console.log("");
}

function printProcesses(list: DevProcess[], all: boolean) {
  const shown = list.filter((p) => all || p.leftBehind || p.kind === "server" || p.kind === "watcher");
  const memory = list.filter((p) => p.kind !== "dx").reduce((n, p) => n + p.memory, 0);
  console.log(c.bold("Running in the background") + c.dim(`  ${formatBytes(memory)} in ${list.filter((p) => p.kind !== "dx").length} processes`));
  if (!shown.length) console.log(c.dim("  No dev servers or watchers running."));
  else
    console.log(
      table(
        ["PID", "WHAT", "PROJECT", "STARTED", "MEMORY", "CPU", "NOTE"],
        shown.map((p) => [
          String(p.pid),
          p.label,
          p.project ?? "",
          relativeTime(p.startedAt ?? 0),
          formatBytes(p.memory),
          p.cpu === undefined ? "" : `${p.cpu}%`,
          [
            p.leftBehind ? c.yellow("left behind") : "",
            p.runByDx ? c.cyan("run by dx") : "",
            p.ports.some((x) => x.network) ? c.yellow(`:${p.ports.filter((x) => x.network).map((x) => x.port).join(",")} open to your network`) : p.ports.length ? c.dim(`:${p.ports.map((x) => x.port).join(",")}`) : "",
          ]
            .filter(Boolean)
            .join(" "),
        ]),
      ),
    );
  if (!all && shown.length < list.length) console.log(c.dim(`  ${list.length - shown.length} more (AI tools, editor helpers, dx): dx machine processes`));
  if (list.some((p) => p.leftBehind)) console.log(c.dim("  Stop one with dx machine --stop <pid> (it and its child processes)."));
  console.log("");
}
