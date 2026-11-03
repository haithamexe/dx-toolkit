#!/usr/bin/env node
// MCP server: lets Claude (Desktop, Code) and Raycast AI call your dx tools.
// It talks over stdin/stdout, so nothing here may print to stdout except the protocol.

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
  type DevError,
  type Project,
} from "@dx/core";
import { ensureDashboard, findDashboard, type DashboardClient } from "@dx/web/link";

const server = new McpServer({ name: "dx", version: "0.1.0" });

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
      "their work journal, as markdown. Use it to write a standup, weekly update or status report.",
    inputSchema: {
      days: z.number().int().min(1).max(366).optional().describe("How many days back, today included (default 7)"),
      all_authors: z.boolean().optional().describe("Count everyone's commits, not only the user's (default false)"),
      github: z.boolean().optional().describe("Include merged and reviewed GitHub pull requests (default true)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ days, all_authors, github }) => {
    try {
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
      return text(await waitAndReport(client, project, "ready", after, (timeout_seconds ?? 90) * 1000));
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
}

server.registerTool(
  "check_url",
  {
    title: "Request a page or API route",
    description:
      "Request a URL on a locally running app (localhost only) and report the status, timing, page title and the start of the body, " +
      "plus what the dev server printed and any errors it logged while answering. Use it to confirm a change works. " +
      "Give either a full URL, or a project and a path.",
    inputSchema: {
      url: z.string().optional().describe("e.g. http://localhost:5173/checkout, or a stack service's local domain: http://api.shop.localhost/health"),
      project: z.string().optional().describe("Project name; its dev server's address is used"),
      path: z.string().optional().describe("Path on the project's server, e.g. /api/cart (default /)"),
      method: z.string().optional().describe("GET (default), POST, PUT, DELETE…"),
      body: z.string().optional().describe("Request body, e.g. JSON text"),
      headers: z.record(z.string(), z.string()).optional().describe("Request headers"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ url, project: name, path, method, body, headers }) => {
    let dir: string | undefined;
    if (!url) {
      if (!name) return failure("Give a url, or a project and a path.");
      const project = pickProject(name);
      if (typeof project === "string") return failure(project);
      dir = project.dir;
    }
    try {
      const client = await ensureDashboard();
      const r = await client.post<CheckResult>("/api/check", { url, dir, path, method, body, headers });
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
