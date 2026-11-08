#!/usr/bin/env node
// MCP server: lets Claude (Desktop, Code) and Raycast AI call your dx tools.
// It talks over stdin/stdout, so nothing here may print to stdout except the protocol.

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addJournalEntry,
  auditDependencies,
  buildSummary,
  commandExists,
  describeVulnerabilities,
  findCleanup,
  formatBytes,
  formatSummary,
  findProjects,
  killPort,
  listListeningPorts,
  loadConfig,
  openInEditor,
  openTerminal,
  listAiTools,
  readJournal,
  recordRun,
  runDoctor,
  readProject,
  saveStackSpec,
  scanProjects,
  startOrder,
  detectStack,
  checkEnv,
  cloneProject,
  fixDependencies,
  checkProjectNeeds,
  mapApi,
  projectSpec,
  readSpec,
  checkTools,
  dockerInfo,
  installedTools,
  latestVersions,
  listDevProcesses,
  supportedNodeLines,
  type DepsReport,
  findUnsavedWork,
  leaveNote,
  resumeInfo,
  runTests,
  queryDatabase,
  buildYearStory,
  formatYearReview,
  formatActivity,
  auditEnv,
  isProblem,
  parseSince,
  readActivity,
  describeCapture,
  describeVisualCommit,
  listVisual,
  visualImageFile,
  type ActivityEvent,
  type Replay,
  type DevError,
  type PageCheck,
  type Project,
} from "@dx/core";
import { dataTarget, listScenes, loadData, loadScene, makeScene, readDataSchema, saveScene, sceneSlug, type AttackReport, describeHealth, CHAOS_LEVELS, chaosReport, findGraveyard, loadChaos, probeEnv, setChaos, type BehaviourDiff, type GremlinRun } from "@dx/core";
import { describeLocaleProblem, prProof, projectTour, queryLogState, queryReport, readActivity as readActivityLog, setQueryLog, tourMarkdown, type LocaleReport, type UpgradeReport } from "@dx/core";
import { ensureDashboard, findDashboard, type DashboardClient } from "@dx/web/link";
import { ACTION_GROUPS, DX_ACTIONS, actionRequest, dxAction } from "@dx/web/actions";
import { callRecord, recordCall, type CallResult } from "./calls.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const server = new McpServer({ name: "dx", version });

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const failure = (message: string) => ({ ...text(message), isError: true });

// Every call is recorded (calls.ts says what's kept and what never is), so the user can watch
// what their agent does in the dashboard's AI lane and in `dx runs`.
let scanned: { at: number; projects: Project[] } | undefined;
function projectNameOf(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    if (!scanned || Date.now() - scanned.at > 30_000) scanned = { at: Date.now(), projects: scanProjects(loadConfig()) };
    const { match, candidates } = findProjects(raw, scanned.projects);
    return (match ?? (candidates.length === 1 ? candidates[0] : undefined))?.name;
  } catch {
    return undefined;
  }
}
{
  type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallResult> | CallResult;
  const register = server.registerTool.bind(server) as unknown as (name: string, config: unknown, handler: Handler) => unknown;
  (server as unknown as { registerTool: (name: string, config: unknown, handler: Handler) => unknown }).registerTool = (name, config, handler) =>
    register(name, config, async (args, extra) => {
      const started = Date.now();
      const input = args && typeof args === "object" ? args : {};
      const record = (result: CallResult | undefined) => {
        const project = projectNameOf(input.project ?? (name === "open_project" ? input.name : undefined));
        recordCall(callRecord(name, input, result, Date.now() - started, project));
      };
      try {
        const result = await handler(args, extra);
        record(result);
        return result;
      } catch (err) {
        record({ isError: true, content: [{ type: "text", text: (err as Error).message }] });
        throw err;
      }
    });
}

server.registerTool(
  "list_projects",
  {
    title: "List projects",
    description:
      "List the user's local code projects, most recently active first. Optionally fuzzy-search by name. " +
      "Each project has its folder, kind (node, go, …), package manager, dev command and local URL.",
    inputSchema: {
      query: z.string().optional().describe("Part of a project name, e.g. 'todo-app'"),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum number of projects (default 25)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, limit }) => {
    const all = scanProjects(loadConfig());
    const list = query ? findProjects(query, all).candidates : all;
    return text(
      list.slice(0, limit ?? 25).map((p) => ({
        name: p.name,
        dir: p.dir,
        kind: p.kind,
        packageManager: p.packageManager,
        devCommand: p.devCommand,
        url: p.url,
        lastActive: p.lastActive ? new Date(p.lastActive).toISOString() : undefined,
      })),
    );
  },
);

server.registerTool(
  "open_project",
  {
    title: "Open project",
    description:
      "Open one of the user's projects in their editor, and optionally start its dev server in a new terminal window. " +
      "To run the app yourself and see its output and errors, use start_dev_server instead.",
    inputSchema: {
      name: z.string().describe("Project name, or part of it"),
      start_dev_server: z.boolean().optional().describe("Also start the dev server (default false)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ name, start_dev_server }) => {
    const config = loadConfig();
    const { match, candidates } = findProjects(name, scanProjects(config));
    const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!project) {
      return candidates.length
        ? failure(`Several projects match "${name}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}. Which one?`)
        : failure(`No project matches "${name}".`);
    }
    try {
      await openInEditor(project.dir, project.editor ?? config.editor);
      let started = "";
      if (start_dev_server) {
        if (!project.devCommand) {
          started = " It has no dev command (add one in .devrc.json).";
        } else {
          const command = (await commandExists("dx")) ? "dx go . --no-editor" : project.devCommand;
          await openTerminal(project.dir, command, project.name);
          started = ` Started \`${project.devCommand}\` in a new terminal window${project.url ? `; it will be at ${project.url}` : ""}.`;
        }
      }
      recordRun("go", true, project.name, "mcp", { project: project.name });
      return text(`Opened ${project.name} (${project.dir}) in ${project.editor ?? config.editor}.${started}`);
    } catch (err) {
      recordRun("go", false, `${project.name}: ${(err as Error).message}`, "mcp", { project: project.name });
      return failure(`Couldn't open ${project.name}: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "list_ports",
  {
    title: "List listening ports",
    description:
      "List TCP ports that are listening on this computer, with the process name, PID and command line. " +
      "By default only ports 1024 and up that don't belong to the operating system.",
    inputSchema: {
      port: z.number().int().min(1).max(65535).optional().describe("Only this port"),
      include_system: z.boolean().optional().describe("Include ports below 1024 and system processes"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ port, include_system }) => {
    try {
      let entries = await listListeningPorts(port);
      if (port === undefined && !include_system) entries = entries.filter((e) => e.port >= 1024 && !e.system);
      return text(entries.length ? entries : port ? `Nothing is listening on port ${port}.` : "No listening ports.");
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "machine_info",
  {
    title: "This computer's developer tools",
    description:
      "What's installed on this computer and what runs in the background, so commands you suggest fit it. " +
      "tools: Node, npm, pnpm, yarn, bun, deno, git, gh, docker, python, go, java, rust with their versions, the newest version, whether that version still gets security fixes, and the update command. " +
      "projects: what each project asks for (.nvmrc, engines, packageManager, lock files, go.mod) next to what's installed, with the fix. " +
      "processes: dev servers, watchers and tools running, with memory, CPU, ports, and which were left behind by a closed terminal. " +
      "Read-only. Suggest updates and stops to the user; the dashboard's Machine page runs them.",
    inputSchema: {
      part: z.enum(["all", "tools", "projects", "processes", "docker"]).optional().describe("Which part (default: all but docker)"),
      project: z.string().optional().describe("Only this project's needs, by name"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ part = "all", project }) => {
    try {
      const want = (p: string) => part === p || (part === "all" && p !== "docker");
      let projects = scanProjects(loadConfig());
      if (project) {
        const found = findProjects(project, projects);
        const match = found.match ?? (found.candidates.length === 1 ? found.candidates[0] : undefined);
        if (!match) return failure(found.candidates.length ? `Several projects match "${project}": ${found.candidates.map((p) => p.name).join(", ")}` : `No project matches "${project}".`);
        projects = [match];
      }
      const [tools, latest] = await Promise.all([want("tools") ? checkTools() : undefined, want("projects") ? latestVersions().catch(() => undefined) : undefined]);
      const out: Record<string, unknown> = {};
      if (tools) out.tools = tools.filter((t) => t.installed).map(({ path: _path, ...t }) => t);
      if (tools) out.notInstalled = tools.filter((t) => !t.installed).map((t) => t.id);
      if (want("projects")) {
        const needs = checkProjectNeeds(projects, await installedTools(), { nodeLines: supportedNodeLines(latest) });
        out.projects = project ? needs : needs.filter((p) => p.problems > 0);
        if (!project) out.projectsChecked = needs.length;
      }
      if (want("processes")) {
        const dashboard = await findDashboard();
        const servers = dashboard ? ((await dashboard.get("/api/dev").catch(() => [])) as Array<{ pid?: number; services?: Array<{ pid?: number }> }>) : [];
        const owners = [process.pid, ...(dashboard ? [dashboard.info.pid] : []), ...servers.flatMap((s) => [s, ...(s.services ?? [])]).flatMap((x) => (x.pid ? [x.pid] : []))];
        out.processes = (await listDevProcesses({ projects: scanProjects(loadConfig()), ownerPids: owners })).map(({ command: _c, ...p }) => ({ ...p, memory: formatBytes(p.memory) }));
      }
      if (want("docker")) out.docker = await dockerInfo();
      return text(out);
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "api_map",
  {
    title: "A project's API, from its OpenAPI spec",
    description:
      "The project's API spec (OpenAPI or Swagger, the one dx keeps for it, else a spec file found in the project) next to what the app really called in the last 7 days: " +
      "each endpoint with its calls and statuses, answers that don't fit the spec (wrong types, missing fields, undeclared statuses), and calls the spec doesn't have. " +
      "Use it to see an API's shape before writing code against it, or to check a backend change against the spec.",
    inputSchema: { project: z.string().describe("Project name") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project }) => {
    try {
      const found = findProjects(project, scanProjects(loadConfig()));
      const p = found.match ?? (found.candidates.length === 1 ? found.candidates[0] : undefined);
      if (!p) return failure(found.candidates.length ? `Several projects match "${project}": ${found.candidates.map((x) => x.name).join(", ")}` : `No project matches "${project}".`);
      // The project's spec: the one it was given, else a spec file in it, found by itself.
      const stored = projectSpec(p.dir);
      if (!stored) return text(`${p.name} has no API spec dx knows of: no openapi or swagger file in it, and none was given. The user can add one on dx's API page (from a file, the running app, or pasted).`);
      const { doc, source } = stored;
      const spec = readSpec(doc);
      const map = mapApi(spec, readActivity({ dir: p.dir, since: new Date(Date.now() - 7 * 86_400_000), limit: 5000 }));
      return text({ title: spec.title, version: spec.version, kind: spec.kind, source, basePath: spec.basePath, endpoints: map.endpoints, undocumented: map.undocumented });
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "mock_server",
  {
    title: "Start or stop a project's mock server",
    description:
      "A project's mock server answers its API from dx's mocks (made from its OpenAPI spec, cached real answers, or recordings) at an address of its own, from the first call and without its back end running, like a Postman mock server. " +
      "Use it when front-end work shouldn't wait for the back end. Pick an answer per request with the header x-mock-response-code: 404. Make mocks first on the API page or with dx mock spec.",
    inputSchema: { project: z.string().describe("Project name"), on: z.boolean().optional().describe("false stops it (default: start)") },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ project, on = true }) => {
    try {
      const found = findProjects(project, scanProjects(loadConfig()));
      const p = found.match ?? (found.candidates.length === 1 ? found.candidates[0] : undefined);
      if (!p) return failure(`No project matches "${project}".`);
      const dash = await ensureDashboard();
      const r = (await dash.post("/api/mocks/server", { dir: p.dir, on })) as { url?: string; host?: string };
      return text(on ? `${p.name}'s mock server: ${r.url} (or http://${r.host}). It answers from the mocks with or without the dev server.` : `${p.name}'s mock server stopped.`);
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "kill_port",
  {
    title: "Kill process on port",
    description:
      "Stop whatever process is listening on a TCP port (and its child processes). Never touches operating-system processes. " +
      "Use list_ports first and tell the user what will be stopped.",
    inputSchema: { port: z.number().int().min(1).max(65535).describe("The port to free, e.g. 3000") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ port }) => {
    try {
      const { entries, results } = await killPort(port);
      if (entries.length === 0) return text(`Nothing was listening on port ${port}.`);
      const ok = results.every((r) => r.ok);
      recordRun("port.kill", ok, `port ${port}: ${results.map((r) => r.message).join("; ")}`, "mcp");
      const summary = results.map((r) => r.message).join("\n");
      return ok ? text(summary) : failure(summary);
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "add_log_entry",
  {
    title: "Add work journal entry",
    description: "Add one line to the user's work journal (what they did, shipped or decided). Only when the user asks.",
    inputSchema: { text: z.string().min(1).describe("The entry, one line") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ text: entryText }) => {
    try {
      const entry = addJournalEntry(entryText);
      recordRun("log", true, undefined, "mcp");
      return text(`Logged under ${entry.date} at ${entry.time}: ${entry.text}`);
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "read_log",
  {
    title: "Read work journal",
    description: "Read the user's work journal entries for recent days, e.g. to write a weekly summary or standup.",
    inputSchema: { days: z.number().int().min(1).max(366).optional().describe("How many days back (default 7)") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ days }) => {
    const entries = readJournal({ sinceDays: days ?? 7 });
    return text(entries.length ? entries : `Nothing logged in the last ${days ?? 7} day(s).`);
  },
);

server.registerTool(
  "work_summary",
  {
    title: "Work summary",
    description:
      "Summarize what the user did over the last few days: their git commits across all their local projects plus " +
      "their work journal, as markdown. Use it to write a standup, weekly update or status report. With year, a whole year in review " +
      "instead (month by month, projects, busiest day, longest run, pull requests merged, journal): for a performance review or a CV.",
    inputSchema: {
      days: z.number().int().min(1).max(366).optional().describe("How many days back, today included (default 7)"),
      year: z.number().int().min(1990).max(2100).optional().describe("A whole year in review instead, e.g. 2026"),
      all_authors: z.boolean().optional().describe("Count everyone's commits, not only the user's (default false)"),
      github: z.boolean().optional().describe("Include merged and reviewed GitHub pull requests (default true)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ days, year, all_authors, github }) => {
    try {
      if (year !== undefined) {
        const { review, story } = await buildYearStory(year, { allAuthors: all_authors, github: github ?? true });
        return text(formatYearReview(review, story));
      }
      const summary = await buildSummary({ days: days ?? 7, allAuthors: all_authors, github: github ?? true });
      const skipped = summary.skipped.map((s) => `- ${s.project}: ${s.reason}`).join("\n");
      return text(formatSummary(summary) + (skipped ? `\nRepos that couldn't be read:\n${skipped}\n` : ""));
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "find_cleanup",
  {
    title: "Find disk space to free",
    description:
      "List node_modules and build folders in projects the user hasn't touched for a while, with their sizes. " +
      "Read-only: to delete them, tell the user to run `dx clean` in a terminal, which asks before deleting.",
    inputSchema: { days: z.number().int().min(0).max(3650).optional().describe("Projects idle for at least this many days (default 30)") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ days }) => {
    const scan = await findCleanup({ days: days ?? 30 });
    if (!scan.items.length) return text(`Nothing to clean in projects idle for ${scan.olderThanDays}+ days.`);
    return text({
      total: formatBytes(scan.totalBytes),
      olderThanDays: scan.olderThanDays,
      folders: scan.items.map((i) => ({ project: i.project, folder: i.relative, size: formatBytes(i.bytes), path: i.dir })),
      howToDelete: "dx clean",
    });
  },
);

server.registerTool(
  "audit_dependencies",
  {
    title: "Audit dependencies",
    description:
      "Check the user's Node projects for outdated packages (npm outdated) and known vulnerabilities (npm audit). " +
      "Read-only; takes a few seconds per project because it asks the npm registry.",
    inputSchema: {
      query: z.string().optional().describe("Only projects matching this name"),
      active_days: z.number().int().min(1).max(3650).optional().describe("Only projects active in the last N days"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ query, active_days }) => {
    try {
      const reports = await auditDependencies({ query, activeDays: active_days });
      if (!reports.length) return text(query ? `No Node project matches "${query}".` : "No Node projects found.");
      return text(
        reports.map((r) =>
          r.skipped
            ? { project: r.project, skipped: r.skipped }
            : {
                project: r.project,
                vulnerabilities: describeVulnerabilities(r.vulnerabilities),
                outdated: r.outdated.map((p) => `${p.name} ${p.current ?? p.wanted ?? "?"} → ${p.latest}${p.major ? " (major)" : ""}`),
                notes: r.notes.length ? r.notes : undefined,
              },
        ),
      );
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

// ------------------------------------------------------------ running apps
// The dev servers live in the dx dashboard, which keeps running after this session ends and shows
// the user what's running. These tools start it in the background when needed.

/** The last output line the agent has seen, per project folder, so later calls show only what's new. */
const seen = new Map<string, number>();

interface DevInfo {
  project: string;
  dir: string;
  command: string;
  url?: string;
  localUrl?: string;
  status: string;
  startedBy: string;
  errorCount: number;
  lastLine: number;
  service?: string;
  role?: string;
  services?: DevInfo[];
  stackSource?: string;
  note?: string;
}
interface Line {
  n: number;
  stream: string;
  text: string;
  service?: string;
}
interface WaitResult {
  server?: DevInfo;
  lines: Line[];
  newErrors: DevError[];
  errors: DevError[];
  sawOutput: boolean;
  timedOut: boolean;
}

function pickProject(name: string): Project | string {
  const { match, candidates } = findProjects(name, scanProjects(loadConfig()));
  const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (project) return project;
  return candidates.length
    ? `Several projects match "${name}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}. Which one?`
    : `No project matches "${name}". list_projects shows them all.`;
}

function formatLines(lines: Line[], max = 80): string {
  const shown = lines.slice(-max);
  const cut = lines.length > shown.length ? `(${lines.length - shown.length} earlier lines left out)\n` : "";
  const label = (l: Line) => `${l.service ? `[${l.service}] ` : ""}${l.stream === "dx" ? "[dx] " : l.stream === "err" ? "[stderr] " : ""}`;
  return cut + shown.map((l) => `${label(l)}${l.text}`).join("\n");
}

function formatError(e: DevError, detail = 8): string {
  const where = e.file ? ` at ${e.file}${e.line ? `:${e.line}${e.column ? `:${e.column}` : ""}` : ""}` : "";
  const times = e.count > 1 ? ` (×${e.count})` : "";
  const body = e.lines
    .slice(1, detail)
    .map((l) => `    ${l}`)
    .join("\n");
  const service = e.service ? `${e.service}: ` : "";
  return `- [${e.kind}] ${service}${e.message}${where}${times}${e.resolved ? " (resolved)" : ""}${body ? `\n${body}` : ""}`;
}

function formatErrors(errors: DevError[], none = "No errors."): string {
  return errors.length ? errors.map((e) => formatError(e)).join("\n") : none;
}

function describe(server: DevInfo | undefined): string {
  if (!server) return "Not running.";
  const by = server.startedBy === "ai" ? "started by an AI agent" : `started from the ${server.startedBy}`;
  const at = (s: DevInfo) => (s.url ? ` at ${s.url}${s.localUrl ? ` (also ${s.localUrl})` : ""}` : "");
  const head = `${server.project}: ${server.status}${at(server)} (${server.services ? `a stack of ${server.services.length} services, found from ${stackFrom(server.stackSource)}` : server.command}, ${by})`;
  if (!server.services) return head;
  const rows = server.services.map(
    (s) => `  - ${s.service}${s.role ? ` (${s.role})` : ""}: ${s.status}${at(s)}${s.errorCount ? `, ${s.errorCount} error(s)` : ""} — ${s.command}`,
  );
  return [head, ...rows, ...(server.note ? [`  ${server.note}`] : [])].join("\n");
}

function stackFrom(source: string | undefined): string {
  const names: Record<string, string> = {
    devrc: ".devrc.json",
    procfile: "its Procfile",
    runner: "its monorepo dev script",
    scripts: "its dev:* scripts",
    workspaces: "its workspaces",
    compose: "docker-compose",
  };
  return names[source ?? ""] ?? "the project";
}

async function waitAndReport(client: DashboardClient, project: Project, until: "ready" | "quiet", after: number, timeoutMs: number): Promise<string> {
  const r = await client.post<WaitResult>("/api/dev/wait", { dir: project.dir, after, until, timeoutMs }, timeoutMs + 10_000);
  if (r.server) seen.set(project.dir, r.server.lastLine);
  const parts = [describe(r.server)];
  if (r.timedOut) parts.push(until === "ready" ? `Still starting after ${Math.round(timeoutMs / 1000)}s.` : "The output didn't settle before the time ran out.");
  if (until === "quiet" && !r.sawOutput) {
    parts.push("The dev server printed nothing new: no rebuild was noticed (it may not watch this file, or it rebuilt silently).");
  }
  parts.push(
    r.newErrors.length
      ? `New errors:\n${formatErrors(r.newErrors)}`
      : r.errors.length
        ? `No new errors. Still current:\n${formatErrors(r.errors)}`
        : "No errors.",
  );
  if (r.lines.length) parts.push(`Output:\n${formatLines(r.lines, 60)}`);
  parts.push(`The user can watch it in the dx dashboard: ${client.url}`);
  return parts.join("\n\n");
}

const notRunning = (name: string) => `${name} isn't running in dx. start_dev_server starts it.`;

server.registerTool(
  "start_dev_server",
  {
    title: "Start a project's dev server",
    description:
      "Start one of the user's projects' dev server (npm run dev and the like) inside the dx dashboard, wait until it's " +
      "ready or has failed, and return its URL, any errors and its output. If it's already running, report on it. " +
      "When the project is a stack (front end, API, worker, databases in docker-compose…) every service starts, in order, " +
      "and each is reported. Apps are also served at name.localhost. " +
      "Use this to run the app you are working on; after editing files use wait_for_rebuild, and check_url to try pages.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      timeout_seconds: z.number().int().min(5).max(300).optional().describe("How long to wait for it to be ready (default 90)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ project: name, timeout_seconds }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    try {
      const client = await ensureDashboard();
      const started = await client.post<DevInfo>("/api/dev/start", { dir: project.dir, by: "ai" });
      recordRun("go", true, `${project.name} started by an AI agent`, "mcp", { project: project.name });
      const after = started.status === "starting" ? 0 : (seen.get(project.dir) ?? 0);
      const report = await waitAndReport(client, project, "ready", after, (timeout_seconds ?? 90) * 1000);
      const note = resumeInfo(project).session?.note;
      return text(note ? `${report}\n\nNote left last time on this project: ${note}` : report);
    } catch (err) {
      return failure(`Couldn't start ${project.name}: ${(err as Error).message}`);
    }
  },
);

server.registerTool(
  "stop_dev_server",
  {
    title: "Stop a project's dev server",
    description: "Stop a dev server running in the dx dashboard, with its child processes.",
    inputSchema: { project: z.string().describe("Project name, or part of it") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ project: name }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    const client = await findDashboard();
    if (!client) return text(`${project.name} isn't running in dx.`);
    try {
      const r = await client.post<DevInfo | null>("/api/dev/stop", { dir: project.dir });
      return text(r ? `Stopping ${project.name}.` : `${project.name} isn't running in dx.`);
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "restart_dev_server",
  {
    title: "Restart a project's dev server",
    description: "Stop a project's dev server and start it again, e.g. after changing its config or installing packages. Waits until it's ready.",
    inputSchema: { project: z.string().describe("Project name, or part of it") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ project: name }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    try {
      const client = await ensureDashboard();
      await client.post("/api/dev/restart", { dir: project.dir, by: "ai" }, 30_000);
      return text(await waitAndReport(client, project, "ready", 0, 90_000));
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "dev_servers",
  {
    title: "List running dev servers",
    description: "List the dev servers dx is running, with their status, URL, who started them and how many errors they currently show.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const client = await findDashboard();
    const list = client ? await client.get<DevInfo[]>("/api/dev") : [];
    if (!list.length) return text("No dev servers are running in dx.");
    return text(list.map((s) => `${describe(s)}${s.errorCount ? ` — ${s.errorCount} error(s)` : ""}`).join("\n"));
  },
);

server.registerTool(
  "dev_logs",
  {
    title: "Read a dev server's output",
    description:
      "Read what a project's dev server printed. By default only what's new since you last looked; since_line: 0 gives everything kept (the last 2000 lines).",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      since_line: z.number().int().min(0).optional().describe("Only lines after this number"),
      max_lines: z.number().int().min(1).max(500).optional().describe("At most this many of the newest lines (default 120)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name, since_line, max_lines }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    const client = await findDashboard();
    if (!client) return text(notRunning(project.name));
    const after = since_line ?? seen.get(project.dir) ?? 0;
    const r = await client.get<{ lines: Line[]; server?: DevInfo }>(`/api/dev/logs?dir=${encodeURIComponent(project.dir)}&after=${after}`);
    if (!r.server) return text(notRunning(project.name));
    seen.set(project.dir, r.server.lastLine);
    return text(`${describe(r.server)}\n\n${r.lines.length ? formatLines(r.lines, max_lines ?? 120) : "No new output."}`);
  },
);

server.registerTool(
  "dev_errors",
  {
    title: "Errors in running apps",
    description:
      "Errors dx found in dev server output: compile errors, stack traces, crashes. Each has its file:line when the output names one " +
      "and how often it happened; an error is dropped once the server rebuilds cleanly. Without a project, covers every running server.",
    inputSchema: {
      project: z.string().optional().describe("Project name, or part of it; every running server when left out"),
      include_resolved: z.boolean().optional().describe("Also list errors a later clean rebuild resolved"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name, include_resolved }) => {
    let dir = "";
    if (name) {
      const project = pickProject(name);
      if (typeof project === "string") return failure(project);
      dir = project.dir;
    }
    const client = await findDashboard();
    const r = client
      ? await client.get<{ project: string; errors: DevError[] }[]>(`/api/dev/errors?dir=${encodeURIComponent(dir)}${include_resolved ? "&all=1" : ""}`)
      : [];
    if (!r.length) return text(name ? notRunning(name) : "No dev servers are running in dx.");
    return text(r.map((s) => `${s.project}:\n${formatErrors(s.errors, "  No errors.")}`).join("\n\n"));
  },
);

server.registerTool(
  "wait_for_rebuild",
  {
    title: "Wait for the app to rebuild",
    description:
      "Call after editing a project's files while its dev server runs: waits for the server to notice the change and finish " +
      "rebuilding, then returns what it printed and whether the change introduced or fixed errors.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      timeout_seconds: z.number().int().min(2).max(120).optional().describe("Longest wait (default 60)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name, timeout_seconds }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    const client = await findDashboard();
    if (!client) return text(notRunning(project.name));
    try {
      return text(await waitAndReport(client, project, "quiet", seen.get(project.dir) ?? 0, (timeout_seconds ?? 60) * 1000));
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

interface CheckResult {
  url: string;
  status?: number;
  statusText?: string;
  ok: boolean;
  ms: number;
  contentType?: string;
  bytes?: number;
  location?: string;
  title?: string;
  snippet?: string;
  error?: string;
  project?: string;
  serverOutput: Line[];
  serverErrors: DevError[];
  page?: PageCheck;
}

server.registerTool(
  "check_url",
  {
    title: "Request a page or API route",
    description:
      "Request a URL on a locally running app (localhost only) and report the status, timing, page title and the start of the body, " +
      "plus what the dev server printed and any errors it logged while answering. Use it to confirm a change works. " +
      "With browser: true the page is loaded in a headless Chrome/Edge instead, and you also get what went wrong in the browser: " +
      "uncaught exceptions, console errors and warnings, failed requests (4xx/5xx, refused) and a Vite/Next.js error overlay; " +
      "use it for front-end pages, since a page can answer 200 and still crash in the browser. screenshot: true adds a picture of the page. " +
      "steps clicks through a flow after the page loads (fill a form, sign in, add to cart), reporting each step and the errors it caused: " +
      'e.g. [{"type":"me@example.com","into":"#email"},{"click":"text=Sign in"},{"waitFor":"url=/dashboard"}]. ' +
      "Give either a full URL, or a project and a path.",
    inputSchema: {
      url: z.string().optional().describe("e.g. http://localhost:5173/checkout, or a stack service's local domain: http://api.shop.localhost/health"),
      project: z.string().optional().describe("Project name; its dev server's address is used"),
      path: z.string().optional().describe("Path on the project's server, e.g. /api/cart (default /)"),
      method: z.string().optional().describe("GET (default), POST, PUT, DELETE…"),
      body: z.string().optional().describe("Request body, e.g. JSON text"),
      headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
      browser: z.boolean().optional().describe("Load the page in a headless browser and report console errors, exceptions and failed requests"),
      screenshot: z.boolean().optional().describe("With browser: also return a screenshot of the page"),
      steps: z
        .array(
          z.object({
            goto: z.string().optional().describe("Go to a path, e.g. /cart"),
            click: z.string().optional().describe('Click: a CSS selector, or text=Sign in'),
            type: z.string().optional().describe("Type this text…"),
            into: z.string().optional().describe("…into this field: a CSS selector or text=Email"),
            press: z.string().optional().describe("Press Enter, Tab, Escape, Backspace, ArrowDown or ArrowUp"),
            wait_for: z.string().optional().describe('Wait for a selector, text=Order placed, or url=/dashboard'),
            screenshot: z.boolean().optional().describe("Screenshot after this step"),
          }),
        )
        .max(50)
        .optional()
        .describe("Things to do after the page loads, in order; implies browser. A failed step stops the rest."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ url, project: name, path, method, body, headers, browser, screenshot, steps }) => {
    let dir: string | undefined;
    if (!url) {
      if (!name) return failure("Give a url, or a project and a path.");
      const project = pickProject(name);
      if (typeof project === "string") return failure(project);
      dir = project.dir;
    }
    try {
      const client = await ensureDashboard();
      const useBrowser = browser === true || screenshot === true || !!steps?.length;
      const r = await client.post<CheckResult>("/api/check", { url, dir, path, method, body, headers, browser: useBrowser, screenshot, steps, timeoutMs: steps?.length ? 120_000 : undefined }, useBrowser ? 150_000 : 30_000);
      if (r.page) return pageReport(r);
      const verb = (method ?? "GET").toUpperCase();
      const head = r.error
        ? `${verb} ${r.url} failed after ${r.ms} ms: ${r.error}`
        : `${verb} ${r.url} → ${r.status} ${r.statusText ?? ""} in ${r.ms} ms${r.contentType ? ` (${r.contentType}, ${r.bytes} bytes)` : ""}`;
      const parts = [head];
      if (r.location) parts.push(`Redirects to ${r.location} (not followed).`);
      if (r.title) parts.push(`Title: ${r.title}`);
      if (r.snippet) parts.push(`Body starts:\n${r.snippet}`);
      if (r.project) {
        parts.push(r.serverErrors.length ? `Errors ${r.project} logged meanwhile:\n${formatErrors(r.serverErrors)}` : `${r.project} logged no errors meanwhile.`);
        if (r.serverOutput.length) parts.push(`Its output meanwhile:\n${formatLines(r.serverOutput, 40)}`);
      }
      const result = text(parts.join("\n\n"));
      return r.error || (r.status ?? 0) >= 500 ? { ...result, isError: true } : result;
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

/** check_url with browser: what the page showed, what broke in the browser, and what the server logged meanwhile. */
function pageReport(r: CheckResult) {
  const p = r.page!;
  const parts: string[] = [];
  parts.push(
    p.error
      ? `${r.url} couldn't be loaded in ${p.browser} (${p.ms} ms): ${p.error}`
      : `${r.url} loaded in headless ${p.browser} in ${p.ms} ms${p.status ? ` (HTTP ${p.status})` : ""}: ${p.ok ? "no browser errors." : "problems below."}`,
  );
  if (p.steps?.length) {
    const rows = p.steps.map(
      (s) =>
        `${s.ok ? "ok  " : "FAIL"}  ${s.index}. ${s.action} (${s.ms} ms)${s.error ? `: ${s.error}` : ""}${s.problems ? `, ${s.problems} problem(s), marked [step ${s.index}] below` : ""}${s.screenshot ? `, screenshot ${s.screenshot}` : ""}`,
    );
    const stopped = !p.steps[p.steps.length - 1].ok;
    parts.push(`Steps:\n${rows.join("\n")}${p.finalUrl ? `\nEnded on ${p.finalUrl}` : ""}${stopped ? "\nSteps after a failed one aren't run." : ""}`);
  }
  if (p.title) parts.push(`Title: ${p.title}`);
  if (p.overlay) parts.push(`The dev server's error overlay is showing:\n${p.overlay}`);
  const tag = (step?: number) => (step ? `[step ${step}] ` : "");
  const list = (title: string, items: { text: string; source?: string; step?: number }[]) => {
    if (items.length) parts.push(`${title}:\n${items.map((m) => `- ${tag(m.step)}${m.text}${m.source ? `\n    at ${m.source}` : ""}`).join("\n")}`);
  };
  list("Uncaught exceptions", p.exceptions);
  list("Console errors", p.consoleErrors);
  if (p.failedRequests.length) {
    parts.push(`Failed requests:\n${p.failedRequests.map((f) => `- ${tag(f.step)}${f.method ?? "GET"} ${f.url} → ${f.status ?? f.error}${f.type ? ` (${f.type})` : ""}`).join("\n")}`);
  }
  list("Console warnings", p.consoleWarnings.slice(0, 10));
  if (p.text) parts.push(`Visible text:\n${p.text}`);
  else if (!p.error) parts.push("The page shows no text: it may be blank.");
  if (r.project) {
    parts.push(r.serverErrors.length ? `Errors ${r.project} logged meanwhile:\n${formatErrors(r.serverErrors)}` : `${r.project} logged no errors meanwhile.`);
    if (r.serverOutput.length) parts.push(`Its output meanwhile:\n${formatLines(r.serverOutput, 30)}`);
  }
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: parts.join("\n\n") }];
  if (p.screenshot) {
    try {
      content.push({ type: "image", data: readFileSync(p.screenshot).toString("base64"), mimeType: "image/png" });
      content.push({ type: "text", text: `Screenshot saved at ${p.screenshot}` });
    } catch {
      // the picture is a bonus
    }
  }
  return { content };
}

server.registerTool(
  "set_stack",
  {
    title: "Define a project's stack",
    description:
      "Say which processes a project needs running together, when dx can't find that by itself: a front end and an API in two " +
      "repositories, a worker, a database from docker-compose. dx already finds stacks from Procfiles, workspaces, turbo/nx/" +
      "concurrently dev scripts, dev:* scripts and docker-compose databases, so read the project first and only call this when " +
      "start_dev_server doesn't start everything. Writes \"stack\" in the project's .devrc.json; an empty services list removes it.",
    inputSchema: {
      project: z.string().describe("The project the stack belongs to (usually the front end), name or part of it"),
      services: z
        .array(
          z.object({
            name: z.string().describe("Short name: web, api, worker, db"),
            command: z.string().optional().describe("Command to run, e.g. npm run dev"),
            dir: z.string().optional().describe("Folder to run it in, relative to the project, e.g. ../shop-api"),
            project: z.string().optional().describe("Instead of command and dir: another project folder whose own dev command dx uses, e.g. ../shop-api"),
            url: z.string().optional().describe("Where it listens, if it doesn't print it"),
            depends_on: z.array(z.string()).optional().describe("Services that must be ready first"),
            docker: z.string().optional().describe("A docker compose service of this project to start instead of a command"),
          }),
        )
        .describe("The services; empty to remove the stack"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project: name, services }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    for (const s of services) {
      if (!s.command && !s.project && !s.docker) return failure(`Service ${s.name} needs a command, a project or a docker service.`);
    }
    const spec = Object.fromEntries(
      services.map((s) => [
        s.name,
        { dev: s.command, dir: s.dir, project: s.project, url: s.url, dependsOn: s.depends_on, docker: s.docker },
      ]),
    );
    try {
      const file = saveStackSpec(project.dir, services.length ? JSON.parse(JSON.stringify(spec)) : undefined);
      const stack = detectStack(readProject(project.dir) ?? project);
      if (!services.length) return text(`Removed the stack from ${file}.${stack ? ` dx now finds this one by itself: ${stack.services.map((s) => s.name).join(", ")}.` : ""}`);
      if (!stack) return failure(`Wrote ${file}, but dx couldn't read a stack from it. Check the folders and commands.`);
      const order = startOrder(stack).map((wave) => wave.map((s) => s.name).join(" + ")).join(" → ");
      return text(`Saved in ${file}. ${project.name} now starts as: ${order}.\n${stack.services.map((s) => `- ${s.name}: ${s.command} (in ${s.dir})`).join("\n")}\nIf it's running, restart_dev_server applies it.`);
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

interface TrafficEntry {
  id: number;
  at: string;
  host: string;
  service?: string;
  method: string;
  path: string;
  kind: string;
  status?: number;
  ms?: number;
  error?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  truncated?: boolean;
}
const seenTraffic = new Map<string, number>();

server.registerTool(
  "network_log",
  {
    title: "Requests the app made",
    description:
      "The requests that went through a running project's local domain (shop.localhost, api.shop.localhost): method, path, status, " +
      "timing and the start of each request and response body, with passwords, tokens and cookies masked. Use it to see what the front " +
      "end sent to the API and what came back, e.g. after check_url with browser or steps, or when the user clicked something. " +
      "Only traffic through *.localhost is recorded, not localhost:<port>. By default lists API calls only and only what's new since you last asked.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      path: z.string().optional().describe("Only paths containing this, e.g. /api/cart"),
      failed: z.boolean().optional().describe("Only 4xx/5xx or failed requests"),
      all: z.boolean().optional().describe("Include pages, scripts, styles and images too"),
      since_start: z.boolean().optional().describe("Everything kept, not only what's new since you last asked"),
      bodies: z.boolean().optional().describe("Include request and response bodies and headers (default true when 10 or fewer requests)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name, path, failed, all, since_start, bodies }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    const client = await findDashboard();
    if (!client) return text(notRunning(project.name));
    const after = since_start ? 0 : (seenTraffic.get(project.dir) ?? 0);
    const q = new URLSearchParams({ dir: project.dir, after: String(after), ...(path ? { path } : {}), ...(failed ? { failed: "1" } : {}), ...(all ? { all: "1" } : {}) });
    const list = await client.get<TrafficEntry[]>(`/api/traffic?${q}`);
    if (list.length) seenTraffic.set(project.dir, list[list.length - 1].id);
    if (!list.length) {
      return text(
        `No ${after ? "new " : ""}requests${path ? ` to ${path}` : ""} through ${project.name}'s local domain. ` +
          "Requests are recorded when the app is opened at its .localhost address (check_url with browser does that).",
      );
    }
    const detail = bodies ?? list.length <= 10;
    const rows = list.map((e) => {
      const head = `#${e.id} ${e.method} ${e.service ? `[${e.service}] ` : ""}${e.path} → ${e.error ? `failed: ${e.error}` : e.status} ${e.ms !== undefined ? `(${e.ms} ms)` : ""}`;
      if (!detail) return head;
      const lines = [head];
      if (e.requestBody) lines.push(`  request ${e.requestHeaders["content-type"] ?? ""}: ${e.requestBody}`);
      if (e.responseBody) lines.push(`  response ${e.responseHeaders["content-type"] ?? ""}: ${e.responseBody}${e.truncated ? " …(cut)" : ""}`);
      return lines.join("\n");
    });
    return text(`${list.length} request(s), oldest first:\n${rows.join("\n")}`);
  },
);

/** The last activity event the agent saw, per project ("" for all of them). */
const seenActivity = new Map<string, number>();

server.registerTool(
  "activity_log",
  {
    title: "What happened in the app",
    description:
      "The history of what happened in the user's apps, in order: API requests with their payloads and responses, pages loaded, " +
      "front-end route changes, clicks and form submits (never typed values), console output, uncaught errors in the browser, and the " +
      "dev server starting, stopping and printing errors. Passwords, tokens and cookies are masked. Use it to see what the user just did " +
      "and what went wrong (\"I clicked checkout and nothing happened\"), or to replay the steps that led to an error. Recorded for apps " +
      "opened at their .localhost address while the dashboard runs, and for deployed sites the user added (dx sites) and used in the dx " +
      "browser, each event labelled with its site and environment (staging, production); kept 7 days. By default: what's new since you last asked (the last " +
      "30 minutes the first time).",
    inputSchema: {
      project: z.string().optional().describe("Project name, or part of it; every project when left out"),
      since: z.string().optional().describe("30m, 2h, 3d, today, yesterday, 14:30, or a date. Overrides 'only what's new'"),
      types: z
        .array(z.enum(["request", "page", "route", "action", "console", "error", "server", "server-error"]))
        .optional()
        .describe("Only these kinds of event"),
      problems: z.boolean().optional().describe("Only what went wrong: failed requests, errors, console errors and warnings, server errors"),
      search: z.string().optional().describe("Only events mentioning this, in addresses, bodies and stacks too"),
      limit: z.number().int().min(1).max(1000).optional().describe("At most this many, the newest (default 100)"),
      bodies: z.boolean().optional().describe("Include payloads, responses and stacks (default true when 30 or fewer events)"),
      site: z.string().optional().describe("Only what the dx browser recorded on this site, by host (staging.shop-website.dev); \"*.\" for subdomains"),
      env: z.string().optional().describe("Only one environment: local (this computer), staging, production or a label the user gave"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name, since, types, problems, search, limit, bodies, site, env }) => {
    let project: Project | undefined;
    if (name) {
      const found = pickProject(name);
      if (typeof found === "string") return failure(found);
      project = found;
    }
    const key = `${project?.dir ?? ""}|${site ?? ""}|${env ?? ""}`;
    let sinceDate: Date | undefined;
    let after: number | undefined;
    if (since) {
      sinceDate = parseSince(since);
      if (!sinceDate) return failure(`Can't read since "${since}": use 30m, 2h, 3d, today, yesterday, 14:30 or a date.`);
    } else if (seenActivity.has(key)) after = seenActivity.get(key);
    else sinceDate = new Date(Date.now() - 30 * 60_000);
    const query = { dir: project?.dir, types, problems, search, limit: limit ?? 100, since: sinceDate, after, site, env };
    // The dashboard has the last second's events in memory; the files have everything else.
    const client = await findDashboard();
    let list: ActivityEvent[];
    if (client) {
      const q = new URLSearchParams({ limit: String(query.limit) });
      if (project) q.set("dir", project.dir);
      if (types?.length) q.set("types", types.join(","));
      if (problems) q.set("problems", "1");
      if (search) q.set("q", search);
      if (site) q.set("host", site);
      if (env) q.set("env", env);
      if (sinceDate) q.set("since", sinceDate.toISOString());
      if (after !== undefined) q.set("after", String(after));
      list = await client.get<ActivityEvent[]>(`/api/activity?${q}`);
    } else {
      list = readActivity(query);
    }
    if (list.length) seenActivity.set(key, Math.max(seenActivity.get(key) ?? 0, ...list.map((e) => e.id)));
    if (!list.length) {
      return text(
        `Nothing ${after !== undefined ? "new " : ""}recorded${project ? ` for ${project.name}` : ""}${since ? ` since ${since}` : ""}. ` +
          "Activity is recorded for apps opened at their .localhost address while the dx dashboard runs (start_dev_server prints it).",
      );
    }
    const many = !project && new Set(list.map((e) => e.dir)).size > 1;
    const detail = bodies ?? list.length <= 30;
    const problemsSeen = list.filter(isProblem).length;
    return text(
      `${list.length} event(s), oldest first${problemsSeen ? `, ${problemsSeen} of them problems` : ""}:\n` +
        formatActivity(list, { bodies: detail, project: many, maxBody: 1500, visits: true }) +
        (list.some((e) => e.visit) ? "\n\nreplay_visit repeats a visit's clicks in a headless browser." : ""),
    );
  },
);

server.registerTool(
  "replay_visit",
  {
    title: "Do what the user did again",
    description:
      "Repeats a visit from the activity history in a headless browser: opens the page it started on and clicks what the user " +
      "clicked, in order, then reports what broke, like check_url with steps. Use it to reproduce \"I clicked X and it broke\", " +
      "and again after a fix to confirm it. Typed values aren't recorded, so fields stay empty. Without a visit, the user's most " +
      "recent one in the project is used; activity_log shows visits as \"── visit <id>\".",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      visit: z.string().optional().describe("The visit id from activity_log; the most recent one when left out"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ project: name, visit }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    let id = visit;
    if (!id) {
      const recent = readActivity({ dir: project.dir, since: new Date(Date.now() - 86_400_000), types: ["action", "route", "console", "error"], limit: 2000 });
      id = [...recent].reverse().find((e) => e.visit && e.from === "browser" && e.type === "action")?.visit;
      if (!id) return failure(`No visit with clicks in ${project.name}'s history today. Open it at its .localhost address and use it, then try again.`);
    }
    try {
      const client = await ensureDashboard();
      const r = await client.post<{ replay: Replay; result: CheckResult }>("/api/activity/replay", { dir: project.dir, visit: id }, 150_000);
      const head = `Replayed visit ${id}: ${r.replay.url}, then ${r.replay.steps.length} step(s).${r.replay.notes.length ? `\n${r.replay.notes.map((n) => `Note: ${n}`).join("\n")}` : ""}`;
      const report = pageReport(r.result);
      return { ...report, content: [{ type: "text" as const, text: head }, ...report.content] };
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "db_query",
  {
    title: "Query the development database",
    description:
      "Run a read-only query against a project's development database, the Postgres, MySQL/MariaDB or Redis its docker-compose runs. " +
      "It runs inside the container as the user it was set up with, so no credentials are needed. Only SELECT, WITH, SHOW, EXPLAIN and " +
      "DESCRIBE (or Redis commands that read: GET, HGETALL, SCAN, …), one statement at a time, in a read-only session. Leave query out " +
      "to list the tables. Use it to check what an action actually stored. The stack must be running.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      query: z.string().optional().describe("e.g. select id, status from orders order by id desc limit 5, or for Redis: GET session:42"),
      service: z.string().optional().describe("The compose service, when there are several databases"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name, query, service }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    try {
      const r = await queryDatabase(project, { query, service, source: "mcp" });
      const head = `${project.name}/${r.service} (${r.kind}) in ${r.ms} ms`;
      if (r.text !== undefined) return text(`${head}:\n${r.text}`);
      if (!r.rows.length) return text(`${head}: no rows.`);
      const rows = [r.columns.join("\t"), ...r.rows.map((row) => row.join("\t"))];
      return text(`${head}, ${r.rows.length} row(s)${r.truncated ? " (only the first 200)" : ""}:\n${rows.join("\n")}`);
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "run_tests",
  {
    title: "Run a project's tests",
    description:
      "Run a project's tests and get each failure with its test name, file and line, the message, and expected against actual, " +
      "instead of the raw output. Reads vitest, jest, node:test, pytest and go test from their own reports; another test script is " +
      "judged by its exit code, with the end of its output. Use match to rerun only the tests you're fixing, then run them all before you finish.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      match: z.string().optional().describe("Only tests whose name matches (vitest/jest -t, pytest -k, go -run, node --test-name-pattern)"),
      files: z.array(z.string()).optional().describe("Only these test files, relative to the project (not for node:test scripts)"),
      changed: z.boolean().optional().describe("Only tests related to uncommitted changes (vitest and jest)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ project: name, match, files, changed }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    const r = await runTests(project, { match, files, changed, source: "mcp" });
    const head = `${project.name}: ${r.passed} passed, ${r.failed} failed${r.skipped ? `, ${r.skipped} skipped` : ""} in ${(r.ms / 1000).toFixed(1)}s (${r.framework})`;
    const parts = [r.ok ? `${head}. All tests pass.` : head];
    for (const f of r.failures.slice(0, 30)) {
      const where = f.file ? ` at ${f.file}${f.line ? `:${f.line}` : ""}` : "";
      const ea = f.expected !== undefined || f.actual !== undefined ? `\n    expected: ${f.expected ?? "?"}\n    actual:   ${f.actual ?? "?"}` : "";
      const stack = f.stack?.length ? `\n    ${f.stack.join("\n    ")}` : "";
      parts.push(`- ${f.name}${where}\n    ${f.message.split("\n").slice(0, 8).join("\n    ")}${ea}${stack}`);
    }
    if (r.failures.length > 30) parts.push(`…and ${r.failures.length - 30} more.`);
    if (r.error || (!r.ok && !r.failures.length)) parts.push(`${r.error ?? "The command failed."}\nEnd of its output:\n${r.outputTail.join("\n")}`);
    const result = text(parts.join("\n\n"));
    return r.ok ? result : { ...result, isError: true };
  },
);

server.registerTool(
  "fix_dependencies",
  {
    title: "Update a project's packages",
    description:
      "In one Node project: update packages to the newest versions package.json's ranges allow and apply the audit fixes that need no " +
      "breaking change (npm update + npm audit fix, pnpm update, bun update, yarn upgrade). Major versions are left alone and listed, " +
      "since they can need code changes. Reports before and after. Ask the user first, and suggest committing before.",
    inputSchema: { project: z.string().describe("Project name, or part of it") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ project: name }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    if (project.kind !== "node") return failure(`${project.name} isn't a Node project.`);
    const r = await fixDependencies(project);
    recordRun("deps", r.ok, `${project.name} fixed by an AI agent`, "mcp", { project: project.name });
    const was = (d?: DepsReport) => `${d?.outdated.length ?? "?"} outdated, vulnerabilities: ${describeVulnerabilities(d?.vulnerabilities)}`;
    const majors = r.after?.outdated.filter((p) => p.major) ?? [];
    const lines = [
      ...r.steps.map((s) => `${s.ok ? "ok  " : "FAIL"}  ${s.command}${s.ok ? "" : `\n${s.output ?? ""}`}`),
      "",
      `Before: ${was(r.before)}`,
      `After:  ${was(r.after)}`,
      ...(majors.length ? [`Major updates left (may need code changes): ${majors.map((p) => `${p.name} ${p.current ?? "?"} → ${p.latest}`).join(", ")}`] : []),
    ];
    const result = text(lines.join("\n"));
    return r.ok ? result : { ...result, isError: true };
  },
);

server.registerTool(
  "clone_project",
  {
    title: "Set up a repository",
    description:
      "Clone a git repository into the user's projects folder and get it ready to run: install its packages with the tool it uses " +
      "(npm, pnpm, yarn, bun, pip, uv, go) and create .env from .env.example. Reports each step and the variables that still need a value. " +
      "Then start_dev_server runs it. Installing runs the repository's install scripts, so only clone what the user asked for.",
    inputSchema: {
      url: z.string().describe("https://…, git@host:owner/repo.git, or owner/repo for GitHub"),
      name: z.string().optional().describe("Folder name (default: the repository's name)"),
      install: z.boolean().optional().describe("Install packages (default true)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ url, name, install }) => {
    try {
      const r = await cloneProject({ url, name, install, source: "mcp" });
      const steps = r.steps.map((s) => `${s.ok ? "ok  " : "FAIL"}  ${s.name}: ${s.detail ?? ""}${s.fix ? `\n      fix: ${s.fix}` : ""}`);
      const next = r.ok ? `start_dev_server with project "${r.name}" runs it${r.runs ? ` (${r.runs})` : ""}.` : "Fix the failed step, then start_dev_server.";
      const result = text(`${r.name} is in ${r.dir}\n\n${steps.join("\n")}\n\n${next}`);
      return r.ok ? result : { ...result, isError: true };
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "check_env",
  {
    title: "Check .env and committed secrets",
    description:
      "For one project: the variables .env.example lists that no .env file sets (or sets empty), .env files git tracks or doesn't ignore, " +
      "and API keys, tokens and private keys in files git tracks (values masked). Use it when an app fails on a missing setting, " +
      "after cloning, or before committing.",
    inputSchema: { project: z.string().describe("Project name, or part of it") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    const r = checkEnv(project.dir);
    const parts: string[] = [];
    if (r.exampleFile) {
      if (!r.envFiles.length) parts.push(`There is no .env; ${r.exampleFile} lists what it needs. Copy it to .env and fill it in.`);
      if (r.missing.length) parts.push(`Not set in any .env file: ${r.missing.join(", ")}`);
      if (r.empty.length) parts.push(`Set but empty: ${r.empty.join(", ")}`);
      if (r.envFiles.length && !r.missing.length && !r.empty.length) parts.push(`Every variable in ${r.exampleFile} has a value.`);
    } else {
      parts.push("No .env.example to compare with.");
    }
    if (r.tracked.length) parts.push(`Committed .env files (their values are in the repository): ${r.tracked.join(", ")}`);
    if (r.notIgnored.length) parts.push(`.env files git doesn't ignore: ${r.notIgnored.join(", ")}. Add them to .gitignore.`);
    if (r.secrets.length) parts.push(`Keys and tokens in tracked files (move them to .env and revoke them):\n${r.secrets.map((s) => `- ${s.kind} in ${s.file}:${s.line} (${s.preview})`).join("\n")}`);
    else if (r.scanned) parts.push("No keys or tokens in tracked files.");
    // The .gitignore rules OWASP recommends for keeping secrets out of git.
    const audit = auditEnv(project.dir);
    const missing = audit.rules.filter((x) => !x.covered);
    const deeper = audit.files.filter((f) => !f.example && f.name.includes("/"));
    if (deeper.length) parts.push(`.env files in subfolders: ${deeper.map((f) => `${f.name}${f.tracked ? " (committed)" : f.notIgnored ? " (not ignored)" : ""}`).join(", ")}`);
    if (!audit.gitignore) parts.push("There is no .gitignore: git add . would commit everything, .env files and keys included.");
    if (missing.length) {
      parts.push(
        `.gitignore is missing rules that keep secrets out of git (OWASP):\n${missing.map((x) => `- ${x.pattern}: ${x.why}`).join("\n")}\n` +
          `The user can add them in the dashboard's Env & secrets page, or with: dx env ${project.name} --gitignore`,
      );
    } else if (audit.gitignore) parts.push(".gitignore covers .env files, private keys, certificates and keystores.");
    if (audit.exampleIgnored) parts.push(".env.example is ignored too; add !.env.example so the list of variables is shared.");
    return text(`${project.name} (${project.dir})\n\n${parts.join("\n\n")}`);
  },
);

server.registerTool(
  "unsaved_work",
  {
    title: "Find work that isn't backed up",
    description:
      "Across all the user's git projects: uncommitted changes, commits no remote has (with the branches), stashes, and repositories " +
      "with no remote. Most at risk first. Use it when the user asks what they haven't pushed or committed, or before wiping a machine.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const list = await findUnsavedWork();
    if (!list.length) return text("Everything is committed and pushed.");
    const rows = list.map((w) => {
      const parts: string[] = [];
      if (w.noRemote) parts.push("no remote at all");
      if (w.unpushed) parts.push(`${w.unpushed} unpushed commit(s) on ${w.unpushedBranches.join(", ")}`);
      if (w.changed) parts.push(`${w.changed} changed file(s)`);
      if (w.untracked) parts.push(`${w.untracked} untracked file(s)`);
      if (w.stashes) parts.push(`${w.stashes} stash(es), oldest ${w.oldestStash}`);
      return `- ${w.project}${w.branch ? ` (${w.branch})` : ""}: ${parts.join("; ")}\n    ${w.dir}`;
    });
    return text(rows.join("\n"));
  },
);

server.registerTool(
  "resume_project",
  {
    title: "Where the user left off",
    description:
      "For one project: when it was last worked on, on which branch, what was running, the note left last time (by the user or an AI agent) " +
      "on what was in progress, errors open when it stopped, commits since, uncommitted files and recent journal entries about it. " +
      "Read this first when the user says \"carry on with X\" or \"where was I\".",
    inputSchema: { project: z.string().describe("Project name, or part of it") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    const r = resumeInfo(project);
    const s = r.session;
    const parts = [`${project.name} (${project.dir})`];
    if (!s) parts.push("dx has no record of earlier work on it.");
    else {
      parts.push(`Last worked on ${s.at}${s.branch ? ` on branch ${s.branch}` : ""}${s.ran?.length ? `, running ${s.ran.join(" + ")}` : ""}.`);
      if (s.note) parts.push(`Note left ${s.noteAt ?? ""} by ${s.noteBy === "ai" ? "an AI agent" : "the user"}:\n${s.note}`);
      if (s.openErrors?.length) parts.push(`Errors open when it stopped:\n${s.openErrors.map((e) => `- ${e}`).join("\n")}`);
    }
    if (r.branchThen) parts.push(`Then on ${r.branchThen}, now on ${r.branch}.`);
    if (r.newCommits) parts.push(`${r.newCommits} commit(s) since then; latest: ${r.lastCommit?.subject}`);
    else if (r.lastCommit) parts.push(`Last commit ${r.lastCommit.at}: ${r.lastCommit.subject}`);
    if (r.uncommitted.length) parts.push(`Uncommitted: ${r.uncommitted.slice(0, 30).join(", ")}`);
    if (r.journal.length) parts.push(`Journal:\n${r.journal.map((e) => `- ${e.date} ${e.time}: ${e.text}`).join("\n")}`);
    return text(parts.join("\n\n"));
  },
);

server.registerTool(
  "leave_note",
  {
    title: "Leave a note on where things stand",
    description:
      "Save a short note on a project for next time: what is done, what is half-done, the next step, anything to watch out for. " +
      "The user sees it in `dx go`, `dx resume` and the dashboard, and resume_project returns it. Leave one when you stop partway " +
      "through a task. An empty note removes it.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      note: z.string().max(2000).describe("e.g. Checkout form done; payment step half-done in src/pay.ts; next: handle declined cards"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project: name, note }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    leaveNote(project.dir, project.name, note, "ai");
    recordRun("resume", true, `${project.name}: note left by an AI agent`, "mcp", { project: project.name });
    return text(note.trim() ? `Saved the note on ${project.name}.` : `Removed the note on ${project.name}.`);
  },
);

server.registerTool(
  "dx_setup_check",
  {
    title: "Check dx's setup",
    description:
      "Check that everything dx needs works on this computer: Node, projects folders, editor, port listing, clipboard and AI tool connections. " +
      "Each problem comes with a fix, a command to run or a setting to change. Offer to apply the fixes for the user; " +
      "`dx setup` connects dx to every installed AI tool.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const [checks, ai] = await Promise.all([runDoctor(), listAiTools()]);
    const lines = checks.map((c) => `${c.status === "ok" ? "ok  " : c.status === "warn" ? "warn" : "FAIL"}  ${c.name}: ${c.detail}${c.fix ? `\n      fix: ${c.fix}` : ""}`);
    const tools = ai.map(
      (t) =>
        `  ${t.name}: ${!t.installed ? "not installed" : t.connected ? (t.current ? "connected" : "points at an old copy of dx (fix: dx setup)") : "not connected (fix: dx setup)"}`,
    );
    return text(`${lines.join("\n")}\n\nAI tools:\n${tools.join("\n")}`);
  },
);

server.registerTool(
  "visual_diff",
  {
    title: "Did a commit change how the app looks",
    description:
      "Screenshots of a project's most used pages per commit, compared with the commit before's: which pages changed, the share of " +
      "pixels, where (\"around the Checkout button\"), and the diff image (changed pixels orange over a faded copy). dx captures after " +
      "each commit made on the dashboard's Git page, or when HEAD moves, while it runs the project's dev server. capture: true takes a " +
      "capture now (start_dev_server first). Use it after a change to check you didn't move something you didn't mean to.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      commit: z.string().regex(/^[0-9a-fA-F]{4,64}$/).optional().describe("A captured commit's hash; the newest capture when left out"),
      capture: z.boolean().optional().describe("Capture HEAD now through the running dev server, then report"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project: name, commit, capture }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    if (capture) {
      try {
        const client = await ensureDashboard();
        await client.post("/api/visual/capture", { dir: project.dir });
        const end = Date.now() + 5 * 60_000;
        let state: { capturing: boolean; last?: { ok: boolean; message: string } };
        do {
          await new Promise((r) => setTimeout(r, 1000));
          state = await client.get(`/api/visual?dir=${encodeURIComponent(project.dir)}`);
        } while (state.capturing && Date.now() < end);
        if (state.last && !state.last.ok) return failure(`The capture failed: ${state.last.message}`);
      } catch (err) {
        return failure((err as Error).message);
      }
    }
    const list = listVisual(project.dir);
    const wanted = commit?.toLowerCase();
    const e = wanted ? list.find((c) => c.commit.startsWith(wanted)) : list[0];
    if (!e) {
      return failure(
        wanted
          ? `${wanted} has no captures. Captured: ${list.slice(0, 10).map((c) => c.commit.slice(0, 7)).join(", ") || "none yet"}.`
          : `No captures of ${project.name} yet. Start its dev server (start_dev_server), then call this with capture: true.`,
      );
    }
    const lines = [
      `${e.commit.slice(0, 7)} ${e.subject ?? ""}`.trim(),
      `${describeVisualCommit(e)}${e.against ? ` (against ${e.against.slice(0, 7)})` : ""}. Captured ${new Date(e.at).toLocaleString()} from ${e.baseUrl ?? "the dev server"}.`,
      ...e.captures.map((c) => `- ${c.path}${c.viewport === "mobile" ? " (phone)" : ""}: ${describeCapture(c)}${c.box ? ` [box x=${c.box.x} y=${c.box.y} ${c.box.width}×${c.box.height} of ${c.width}×${c.height}]` : ""}`),
      ...describeHealth(e).map((x) => `- ${x}`),
    ];
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: lines.join("\n") }];
    // The diff images of the pages that changed most (at most two), else the first page as it looks.
    const changed = e.captures.filter((c) => c.diff).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0)).slice(0, 2);
    const images = changed.length ? changed.map((c) => [c.name, "diff"] as const) : e.captures.filter((c) => !c.error).slice(0, 1).map((c) => [c.name, "shot"] as const);
    for (const [capName, kind] of images) {
      try {
        content.push({ type: "image", data: readFileSync(visualImageFile(project.dir, e.commit, capName, kind)).toString("base64"), mimeType: "image/png" });
      } catch {
        // the text says it all
      }
    }
    return { content };
  },
);

// ------------------------------------------------------------------ Chaos

/** Starts a run in the dashboard (where the dev servers are) and waits for it to finish. */
async function chaosJob<T>(url: string, body: Record<string, unknown>, maxMs: number): Promise<T> {
  const client = await ensureDashboard();
  let job = await client.post<{ id: string; finishedAt?: string; error?: string; result?: T }>(url, body);
  const end = Date.now() + maxMs;
  while (!job.finishedAt) {
    if (Date.now() > end) {
      await client.post("/api/chaos/job/stop", { id: job.id }).catch(() => undefined);
      throw new Error("It took too long and was stopped. The dashboard's Chaos page has what it found so far.");
    }
    await new Promise((r) => setTimeout(r, 1000));
    job = await client.get(`/api/chaos/job?id=${job.id}`);
  }
  if (job.error) throw new Error(job.error);
  return job.result as T;
}

server.registerTool(
  "chaos_mode",
  {
    title: "Break the app's API calls on purpose (chaos mode), or say what broke",
    description:
      "Chaos mode breaks a project's API calls as they pass through dx (its .localhost address, or the address dx records) the way real " +
      "networks and servers do: slow, 500s, dropped halfway, a 401 as if the session expired, answers out of order, 429s, odd data (a field " +
      "null, empty or 10,000 characters long). Pages, scripts and styles always load. Seeded: the same seed breaks the same calls the same way. " +
      "Levels: wifi (slow and patchy), deploy (server misbehaving), blackfriday (everything, under load). Also sets the page's fake clock " +
      "(clock_at, time_zone, frozen) and the weak phone (phone). With no settings it only reports: what was broken since the run started, " +
      "and what the app did about it (blank pages, uncaught errors, loading indicators that never stopped, the same order sent twice).",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      on: z.boolean().optional().describe("Turn chaos mode on or off"),
      level: z.enum(["wifi", "deploy", "blackfriday"]).optional(),
      seed: z.number().int().min(0).optional().describe("The same seed breaks the same calls the same way"),
      only: z.string().max(300).optional().describe("Only calls whose path matches, e.g. /api/cart/**"),
      clock_at: z.string().max(40).optional().describe('The time the app\'s pages see, e.g. "2026-12-31T23:59:50" (on the time zone\'s clocks); "off" for the real clock'),
      time_zone: z.string().max(60).optional().describe("The time zone the pages see, e.g. Pacific/Auckland"),
      frozen: z.boolean().optional().describe("The fake clock doesn't move"),
      phone: z.boolean().optional().describe("The dx browser and gremlins as a cheap phone on 3G"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project: name, on, level, seed, only, clock_at, time_zone, frozen, phone }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    const patch: Record<string, unknown> = {};
    if (on !== undefined) patch.on = on;
    if (level) patch.level = level;
    if (seed !== undefined) patch.seed = seed;
    if (only !== undefined) patch.paths = only;
    if (phone !== undefined) patch.phone = phone;
    if (clock_at !== undefined || time_zone !== undefined) patch.clock = clock_at === "off" ? null : { at: clock_at ?? "", timeZone: time_zone ?? "", frozen: frozen === true };
    let cfg;
    try {
      if (Object.keys(patch).length) {
        // Through the dashboard when it runs (it owns the dx browser), else straight to the file.
        const client = await findDashboard();
        cfg = client ? await client.post<ReturnType<typeof loadChaos>>("/api/chaos", { dir: project.dir, ...patch }) : setChaos(project.dir, project.name, patch);
      } else cfg = loadChaos(project.dir, project.name);
    } catch (err) {
      return failure((err as Error).message);
    }
    const since = cfg.startedAt ? new Date(cfg.startedAt) : new Date(Date.now() - 3_600_000);
    const r = chaosReport(readActivity({ dir: project.dir, since, limit: 20_000 }), since.toISOString());
    const lines = [
      `${project.name}: chaos ${cfg.on ? `on (${CHAOS_LEVELS[cfg.level].name}, seed ${cfg.seed}${cfg.paths ? `, only ${cfg.paths}` : ""})` : "off"}${cfg.clock ? `; pages see ${cfg.clock.at ?? "the real time"}${cfg.clock.timeZone ? ` in ${cfg.clock.timeZone}` : ""}${cfg.clock.frozen ? ", frozen" : ""}` : ""}${cfg.phone ? "; weak phone on" : ""}.`,
      `Since ${since.toISOString()}: ${r.calls} API calls, ${r.broken} broken on purpose${Object.keys(r.byFault).length ? ` (${Object.entries(r.byFault).map(([k, n]) => `${k} ×${n}`).join(", ")})` : ""}.`,
      ...(r.findings.length
        ? r.findings.slice(0, 30).map((f) => `- ${f.kind}: ${f.title}${f.detail ? ` (${f.detail.split("\n")[0].slice(0, 160)})` : ""}${f.after?.length ? `; after ${f.after.join(", ")}` : ""}`)
        : [r.calls ? "Nothing broke." : "No calls yet: open the app at its .localhost address, or run run_gremlins."]),
    ];
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "run_gremlins",
  {
    title: "Let gremlins loose on the app: a headless browser that clicks, types and double-submits at random",
    description:
      "A headless browser goes through a project's app by itself, on this computer only, through the dev server dx runs: clicks what it " +
      "finds, types nonsense into fields, double-clicks submit buttons, presses Enter, goes back halfway. Controls that look destructive " +
      "(delete, sign out, reset) are left alone unless bold is true. Returns each problem (exceptions, console errors, 5xx answers, failed " +
      "calls, blank pages, error overlays) with the steps that led to it, in the format check_url's steps take, to reproduce it. Seeded. " +
      "With chaos_mode on, its calls are broken too. Takes up to a few minutes.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      path: z.string().max(300).optional().describe("Where to start, a path on the app (default /)"),
      actions: z.number().int().min(5).max(300).optional().describe("How many things to do (default 40)"),
      seed: z.number().int().min(1).optional(),
      phone: z.boolean().optional().describe("As a cheap phone on 3G"),
      bold: z.boolean().optional().describe("Also click destructive-looking controls"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ project: name, path, actions, seed, phone, bold }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    try {
      const run = await chaosJob<GremlinRun>("/api/chaos/gremlins", { dir: project.dir, path, actions, seed, phone, bold }, 10 * 60_000);
      const lines = [`Gremlins #${run.seed} on ${run.url}: ${run.actions} actions, ${run.pages.length} page(s), ${Math.round(run.ms / 1000)} s.${run.skipped.length ? ` Left alone: ${run.skipped.slice(0, 8).join(", ")}.` : ""}`];
      if (!run.findings.length) lines.push("No problems found.");
      for (const f of run.findings) lines.push(`- ${f.kind}: ${f.text} (${f.step ? `after step ${f.step}` : "while the page loaded"}${f.count > 1 ? `, ${f.count} times` : ""})\n  steps: ${JSON.stringify(f.steps)}`);
      return text(lines.join("\n"));
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "behaviour_diff",
  {
    title: "Did a change alter how the app behaves: calls, errors and warnings against an earlier commit",
    description:
      "Loads the same pages on the working copy (its dev server) and on an earlier commit (run as a snapshot on its own port), and compares " +
      "the API calls they make (by method and path, with how often and what they answer), errors, warnings, and the page's status and title. " +
      "\"GET /api/cart is called 3 times, was 1; new warning: …\". The commit defaults to HEAD when there are uncommitted changes, else the " +
      "commit before. Pages default to the most visited ones. Use it after a change as a regression check nobody had to write.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      commit: z.string().regex(/^[0-9a-fA-F]{4,40}$/).optional(),
      paths: z.array(z.string().max(300)).max(3).optional().describe("Paths to load, e.g. [\"/\", \"/cart\"]"),
      visit: z.string().max(40).optional().describe("A visit id from the activity history: its clicks are replayed on both"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project: name, commit, paths, visit }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    try {
      const r = await chaosJob<{ against: string; diffs: BehaviourDiff[] }>("/api/chaos/behaviour", { dir: project.dir, commit, paths, visit }, 15 * 60_000);
      const lines = [`Working copy against ${r.against}:`];
      for (const d of r.diffs) {
        lines.push(`${d.path}: ${d.same ? "behaves the same" : `${d.changes.length} change(s)`}`);
        for (const c of d.changes) lines.push(`- [${c.tone}] ${c.text}`);
      }
      return text(lines.join("\n"));
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "env_values_that_matter",
  {
    title: "Which .env values matter: the app started once per value with that value blank",
    description:
      "Starts the project's dev command on a port of its own, once as it is and once per .env value with only that value blank (the file " +
      "isn't changed; the running dev server keeps running), checks a page each time, and compares. Says which values crash the app, which " +
      "break the page (and how), which nothing notices, and which the code never mentions. Values themselves are never read out. Takes " +
      "about 15 seconds per value.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      path: z.string().max(300).optional().describe("The page to check each time (default /)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project: name, path }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    const r = await probeEnv(project, { path });
    recordRun("env-probe", !r.error, `${project.name}: ${r.error ?? "values checked"}`, "mcp", { project: project.name });
    if (r.error) return failure(r.error);
    const word = { crashes: "crashes without it", breaks: "breaks the page without it", unnoticed: "nothing noticed without it", unused: "never used in the code", skipped: "not tried" };
    return text([`${project.name} (page ${r.path}):`, ...r.values.map((v) => `- ${v.key}: ${word[v.verdict]}${v.problems.length ? ` (${v.problems.slice(0, 3).join("; ")})` : ""}${v.usedCount ? ` [used in ${v.usedIn.join(", ")}]` : ""}`)].join("\n"));
  },
);

server.registerTool(
  "find_unused",
  {
    title: "API routes, pages and mocks nobody used (the endpoint graveyard)",
    description:
      "Routes the code declares (Express, Fastify, Hono, Next.js, SvelteKit, Nuxt, FastAPI, Flask, and the saved API spec), pages from " +
      "file-based routing and router paths, and mocks, matched against the activity history (as many days as dx keeps). Lists what " +
      "was never called or opened. Dead code from what actually ran; only as complete as the history.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      days: z.number().int().min(1).max(90).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project: name, days }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    const g = findGraveyard(project.dir, project.name, { days });
    const part = (title: string, list: typeof g.endpoints) => {
      const dead = list.filter((e) => !e.uses);
      return [`${title} (${dead.length} of ${list.length}):`, ...dead.map((e) => `- ${e.what} (${e.from})`)];
    };
    return text(
      [
        `${project.name}, the last ${g.days} day(s): ${g.events} requests and page events${g.unmatched ? `; ${g.unmatched} call(s) matched no route found` : ""}.`,
        ...part("API routes never called", g.endpoints),
        ...part("Pages never opened", g.pages),
        ...part("Mocks nothing asked for", g.mocks),
      ].join("\n"),
    );
  },
);

server.registerTool(
  "security_check",
  {
    title: "A friendly security pass on the user's own app (XSS, IDOR, CSRF, CORS, cookies, headers, stack traces, login limits)",
    description:
      "Tries the requests and pages in a project's activity history against its own dev server on this computer (started if needed): " +
      "script that comes back unescaped (reflected, and stored through the app's forms, checked in a headless browser), signed-in calls " +
      "that answer without a session, CORS that lets any site read answers, cookies without HttpOnly/SameSite, missing security headers, " +
      "stack traces and SQL errors after malformed input, and logins that take 20 wrong passwords. Each finding has the request that shows " +
      "it, what to fix, and the route's file and line when found. It sends a few test records and wrong passwords to the development " +
      "database unless read_only is true. Use it after adding routes or forms.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      read_only: z.boolean().optional().describe("Skip the checks that change data"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ project: name, read_only }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    try {
      const r = await chaosJob<AttackReport>("/api/chaos/attack", { dir: project.dir, readOnly: read_only === true }, 10 * 60_000);
      const lines = [`${project.name}: ${r.requests} requests. Tried: ${r.tried.join(", ")}.`, ...(r.skipped.length ? [`Not tried: ${r.skipped.join("; ")}.`] : [])];
      if (!r.findings.length) lines.push("Nothing found.");
      for (const f of r.findings) lines.push(`- [${f.severity}] ${f.title}${f.where ? ` (${f.where})` : ""}\n  fix: ${f.fix}\n  proof: ${f.proof}`);
      return text(lines.join("\n"));
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "realistic_data",
  {
    title: "Fill the development database with realistic, connected data (scenes)",
    description:
      "Reads the project's database schema (Prisma, or CREATE TABLE in SQL migrations) and makes believable, connected rows for it: users " +
      "with orders, orders with items, and edge cases (an empty one, a 200-character name, emoji, missing optional values, a deleted user " +
      "who still has records). action: list (the schema and saved scenes), make (a scene from a recipe: typical, big-customer, first-time, " +
      "empty; nothing is written to the database), load (replaces the database's rows with a scene; what was there is saved first as a " +
      "backup scene). Only a database on this computer.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      action: z.enum(["list", "make", "load"]),
      recipe: z.enum(["typical", "big-customer", "first-time", "empty"]).optional(),
      seed: z.number().int().min(0).optional(),
      scene: z.string().max(80).optional().describe("For load: a scene's name or slug from list or make"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ project: name, action, recipe, seed, scene }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    const schema = readDataSchema(project.dir);
    if (!schema) return failure(`No database schema found in ${project.name}: a Prisma schema, or CREATE TABLE in SQL migration files.`);
    const target = dataTarget(project, schema);
    try {
      if (action === "list") {
        const scenes = listScenes(project.dir);
        return text(
          [
            `${schema.tables.length} tables from ${schema.file}: ${schema.tables.map((t) => t.name).join(", ")}.`,
            target.ok ? `Loads into ${target.where}.` : `Can't load here: ${target.why}`,
            scenes.length ? `Scenes:\n${scenes.map((s) => `- ${s.slug} (${s.kind}, ${s.rows} rows)`).join("\n")}` : "No scenes yet.",
          ].join("\n"),
        );
      }
      if (action === "make") {
        const s = makeScene(schema, recipe ?? "typical", seed ?? Math.floor(Math.random() * 9000) + 1000);
        s.name = `${s.name} #${s.seed}`;
        saveScene(project.dir, s);
        return text(`Made scene ${sceneSlug(s.name)}: ${Object.entries(s.rows).map(([t, r]) => `${r.length} ${t}`).join(", ")}. Load it with action load.`);
      }
      if (!scene) return failure("Which scene? Give its slug from action list or make.");
      const r = await loadData(project, schema, loadScene(project.dir, sceneSlug(scene)), { source: "mcp" });
      return text(`Loaded ${r.scene} into ${r.where}: ${r.rows} rows in ${r.tables} tables.${r.backup ? ` The previous data is the scene "${r.backup}".` : ""}`);
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

// ------------------------------------------------------------------ Tour, proof, upgrades, queries, languages

server.registerTool(
  "project_tour",
  {
    title: "A map of a project: how to run it, its pages and the calls each makes, the files behind them, its data and settings",
    description:
      "For getting to know a project before changing it: what it is (README), what it's built with, how to run it (and what dx does first), " +
      "its pages with the API calls each one makes (from the activity history) and the file that answers each call, its database tables, " +
      "the .env settings it needs (names only), how it's tested, its folders and the files changed most lately. Markdown. Read-only.",
    inputSchema: { project: z.string().describe("Project name, or part of it") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    return text(tourMarkdown(projectTour(project)));
  },
);

server.registerTool(
  "pr_proof",
  {
    title: "How the current branch was tested, written for its pull request description",
    description:
      "The 'how was this tested' section for a pull request, from what dx recorded on the branch: the last test run, pages opened and API " +
      "calls made, errors seen (and which still came after the last commit), visual, speed and accessibility changes on its commits, and " +
      "dx's other checks (Gremlins, security, behaviour diffs, translations, upgrades). Markdown with dx's markers. Read-only: it doesn't " +
      "change the pull request (the user does that with dx proof --pr or the Git page).",
    inputSchema: { project: z.string().describe("Project name, or part of it") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    try {
      return text((await prProof(project)).markdown);
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "try_upgrade",
  {
    title: "Try upgrading one package in a throwaway copy, and report what breaks or changes",
    description:
      "Copies the project as it is now (uncommitted changes included) under ~/.dx/snapshots, installs package@version there, runs the " +
      "type check, build and tests before and after, then compares the copy's pages with the project's own dev server: looks, calls, " +
      "errors, speed, accessibility. The project's own folder and node_modules aren't touched. Takes minutes. Use it before upgrading a " +
      "major version.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      package: z.string().describe("A package the project depends on, e.g. react"),
      version: z.string().optional().describe("A version (19, 19.1.0) or a tag (latest, next); default latest"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ project: name, package: pkg, version }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    try {
      const r = await chaosJob<UpgradeReport>("/api/upgrade", { dir: project.dir, name: pkg, version: version ?? "latest" }, 30 * 60_000);
      const verdict = r.verdict === "breaks" ? "breaks something" : r.verdict === "changes" ? "changes how the app looks or behaves" : "nothing changed that dx can see";
      const lines = [`${r.target.name} ${r.target.from ?? "?"} → ${r.target.to}: ${verdict}.`, ...r.summary.map((x) => `- ${x}`)];
      for (const c of r.checks) {
        const fresh = c.after?.errors.filter((e) => !(c.before?.errors ?? []).includes(e)) ?? [];
        if (fresh.length) lines.push(`${c.name} errors:`, ...fresh.slice(0, 10).map((e) => `  ${e}`));
        const failing = (c.after?.failing ?? []).filter((n) => !(c.before?.failing ?? []).includes(n));
        if (failing.length) lines.push("Failing now:", ...failing.slice(0, 10).map((n) => `  ${n}`));
      }
      lines.push(`The copy is ${r.copy} (in ~/.dx/snapshots); the user can remove it from the Git page.`);
      return text(lines.join("\n"));
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "db_queries",
  {
    title: "Database queries per request: N+1, slow queries, busy requests",
    description:
      "For the Postgres or MySQL in the project's docker-compose. action on switches the database's own statement logging on (nothing " +
      "changes in the code), off puts the setting back, report (default) matches each statement since it was switched on to the request " +
      "being answered (from the activity history) and lists N+1 (the same query 10+ times in one request), slow queries (200 ms+) and " +
      "requests with 50+ queries. Values are replaced by ? in every statement.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      action: z.enum(["report", "on", "off"]).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project: name, action }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    try {
      if (action === "on" || action === "off") {
        const state = await setQueryLog(project, action === "on");
        return text(action === "on" ? `Logging ${state?.service}'s queries. Use the app through dx (or check_url), then call db_queries again.` : "Query logging is off; the database setting is back to how it was.");
      }
      const state = queryLogState(project.dir);
      if (!state) return text(`Not logging queries for ${project.name}. Call db_queries with action on first, then use the app.`);
      const r = await queryReport(project, readActivityLog({ dir: project.dir, since: new Date(Date.parse(state.since) - 60_000), limit: 50_000 }));
      const lines = [`${r.queries} queries in ${r.service} since ${r.since}; ${r.requests.length} requests ran some.`];
      if (r.note) lines.push(r.note);
      for (const f of r.findings) lines.push(`- [${f.kind}] ${f.text}${f.shape ? `\n  ${f.shape.slice(0, 300)}` : ""}`);
      for (const q of r.requests.slice(0, 15)) lines.push(`${q.method} ${q.path}: ${q.queries} queries, ${q.dbMs} ms in the database`);
      return text(lines.join("\n"));
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

server.registerTool(
  "translation_check",
  {
    title: "Check pages for other languages: text cut off by longer translations, right to left, and text not in the translation files",
    description:
      "Loads the project's pages on its own dev server three ways: as they are, with every text longer and accented (pseudo text, as " +
      "German or Finnish run), and right to left. Reports text that's cut off or spills out of its box, and text that isn't in the " +
      "project's translation files (so it would never be translated), with the file and line where it's written. Text from the app's own " +
      "API answers is data, and left out.",
    inputSchema: {
      project: z.string().describe("Project name, or part of it"),
      paths: z.array(z.string()).max(6).optional().describe("Pages to check; default the most visited"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name, paths }) => {
    const project = pickProject(name);
    if (typeof project === "string") return failure(project);
    try {
      const r = await chaosJob<LocaleReport>("/api/chaos/locale", { dir: project.dir, paths }, 10 * 60_000);
      const lines = [`${r.pages.length} page(s); ${r.files.length ? `${r.files.length} translation file(s)${r.library ? ` (${r.library})` : ""}` : "no translation files"}; ${r.translated} texts translated, ${r.fromData} from data.`];
      for (const p of r.pages.filter((x) => x.error)) lines.push(`${p.path}: ${p.error}`);
      lines.push(...(r.problems.length ? r.problems.map((p) => `- ${describeLocaleProblem(p)}`) : ["Nothing found."]));
      return text(lines.join("\n"));
    } catch (err) {
      return failure((err as Error).message);
    }
  },
);

// ------------------------------------------------------------------ everything the dashboard does

// Every dashboard action, through the same API and checks as the page (web/src/actions.ts). Risky
// ones go only through dx_do_risky, a tool of its own, so the AI tool asks the user before each
// call (allowing dx_do once doesn't allow them).
const RESULT_MAX = 120_000;

async function doAction(id: string, input: Record<string, unknown> | undefined, risky: boolean) {
  const action = dxAction(id);
  if (!action) return failure(`dx has no action "${id}". dx_actions lists them.`);
  if (action.risky && !risky) return failure(`${id} is risky (${action.title.toLowerCase()}): call dx_do_risky, which asks the user first.`);
  if (!action.risky && risky) return failure(`${id} isn't risky: call dx_do.`);
  let req: ReturnType<typeof actionRequest>;
  try {
    req = actionRequest(action, input ?? {});
  } catch (err) {
    return failure((err as Error).message);
  }
  const client = await ensureDashboard();
  try {
    const result = await client.call(req.method, req.path, req.body, 600_000);
    const out = JSON.stringify(result, null, 2) ?? "ok";
    return text(out.length > RESULT_MAX ? `${out.slice(0, RESULT_MAX)}\n… (cut at ${RESULT_MAX} characters; ask for less, with limit or a narrower input)` : out);
  } catch (err) {
    return failure((err as Error).message);
  }
}

server.registerTool(
  "dx_actions",
  {
    title: "What dx can do",
    description:
      "Everything the dx dashboard can do, as actions to call with dx_do (or dx_do_risky for risky ones): run and check apps, " +
      "git (status, staging, commits, branches, tags, releases, undo), API specs, mocks, rules, the activity history, the project's own tools, " +
      "realistic data, chaos and security checks, .env files, this computer (processes, Docker, ports, cleanup, dependencies), " +
      "the summary and journal, and dx's settings. Without a group, the groups; with one, its actions with their inputs.",
    inputSchema: {
      group: z.string().optional().describe(`One of: ${Object.keys(ACTION_GROUPS).join(", ")}`),
      search: z.string().optional().describe("Words to find actions by, across groups"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ group, search }) => {
    if (!group && !search) return text({ groups: ACTION_GROUPS, next: "Call dx_actions with a group (or search) for its actions and their inputs." });
    const words = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const list = DX_ACTIONS.filter((a) => (!group || a.group === group) && words.every((w) => `${a.id} ${a.title}`.toLowerCase().includes(w)));
    if (!list.length) return failure(group && !ACTION_GROUPS[group] ? `No group "${group}". Groups: ${Object.keys(ACTION_GROUPS).join(", ")}.` : "No action matches.");
    return text(list.map((a) => ({ action: a.id, does: a.title, inputs: a.params, ...(a.risky ? { risky: "use dx_do_risky (the user is asked first)" } : {}) })));
  },
);

server.registerTool(
  "dx_do",
  {
    title: "Do something in dx",
    description:
      "Do one dx action (from dx_actions) that isn't risky: through the dashboard's own API, with its checks. " +
      "Inputs are the action's (dir is a project's folder from list_projects). The answer is the dashboard's, as JSON.",
    inputSchema: {
      action: z.string().describe("An action from dx_actions, e.g. git.status or run.start"),
      input: z.record(z.string(), z.unknown()).optional().describe("The action's inputs"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ action, input }) => doAction(action, input, false),
);

server.registerTool(
  "dx_do_risky",
  {
    title: "Do something risky in dx",
    description:
      "Do one risky dx action (marked risky in dx_actions): it deletes something, can't be undone, leaves this computer (push, release), " +
      "changes the project, its packages or its database, stops a process, or reads secrets. The user is asked before each call. " +
      "Say plainly what it will do before calling it.",
    inputSchema: {
      action: z.string().describe("A risky action from dx_actions, e.g. git.push or env.read"),
      input: z.record(z.string(), z.unknown()).optional().describe("The action's inputs"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ action, input }) => doAction(action, input, true),
);

await server.connect(new StdioServerTransport());
