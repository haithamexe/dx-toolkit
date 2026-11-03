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
  readJournal,
  recordRun,
  scanProjects,
} from "@dx/core";

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
      "Open one of the user's projects in their editor, and optionally start its dev server in a new terminal window.",
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

await server.connect(new StdioServerTransport());
