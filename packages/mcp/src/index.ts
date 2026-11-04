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
  type DepsReport,
  findUnsavedWork,
  leaveNote,
  resumeInfo,
  runTests,
  queryDatabase,
  buildYearReview,
  formatYearReview,
  formatActivity,
  auditEnv,
  isProblem,
  parseSince,
  readActivity,
  type ActivityEvent,
  type Replay,
  type DevError,
  type PageCheck,
  type Project,
} from "@dx/core";
import { ensureDashboard, findDashboard, type DashboardClient } from "@dx/web/link";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const server = new McpServer({ name: "dx", version });

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const failure = (message: string) => ({ ...text(message), isError: true });

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
      if (year !== undefined) return text(formatYearReview(await buildYearReview(year, { allAuthors: all_authors, github: github ?? true })));
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
      "opened at their .localhost address while the dashboard runs, kept 7 days. By default: what's new since you last asked (the last " +
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
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ project: name, since, types, problems, search, limit, bodies }) => {
    let project: Project | undefined;
    if (name) {
      const found = pickProject(name);
      if (typeof found === "string") return failure(found);
      project = found;
    }
    const key = project?.dir ?? "";
    let sinceDate: Date | undefined;
    let after: number | undefined;
    if (since) {
      sinceDate = parseSince(since);
      if (!sinceDate) return failure(`Can't read since "${since}": use 30m, 2h, 3d, today, yesterday, 14:30 or a date.`);
    } else if (seenActivity.has(key)) after = seenActivity.get(key);
    else sinceDate = new Date(Date.now() - 30 * 60_000);
    const query = { dir: project?.dir, types, problems, search, limit: limit ?? 100, since: sinceDate, after };
    // The dashboard has the last second's events in memory; the files have everything else.
    const client = await findDashboard();
    let list: ActivityEvent[];
    if (client) {
      const q = new URLSearchParams({ limit: String(query.limit) });
      if (project) q.set("dir", project.dir);
      if (types?.length) q.set("types", types.join(","));
      if (problems) q.set("problems", "1");
      if (search) q.set("q", search);
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

await server.connect(new StdioServerTransport());
