import { parseArgs } from "node:util";
import {
  autoConnectAiTools,
  connectAiTools,
  disconnectAiTools,
  findProjects,
  listAiTools,
  loadConfig,
  recordRun,
  saveConfig,
  scanProjects,
  type AiToolId,
  type DevError,
  type Project,
} from "@dx/core";
import { findDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, info, ok, UsageError, warn } from "../ui.js";

const IDS: AiToolId[] = ["claude-code", "claude-desktop", "cursor", "windsurf", "vscode"];

export const setupCommand: Command = {
  name: "setup",
  summary: "Connect dx to your AI tools (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code)",
  usage: [
    "dx setup              connect dx to every AI tool installed here (it also does this by itself on first use)",
    "dx setup --list       show which tools are installed and connected",
    "dx setup --undo       remove dx from every AI tool, and stop connecting new ones",
    "dx setup cursor       only this tool: claude-code, claude-desktop, cursor, windsurf or vscode",
    "",
    "Connected tools can run your projects' dev servers, read their output and errors, and check pages.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { list: { type: "boolean" }, undo: { type: "boolean" } },
    });
    for (const p of positionals) if (!IDS.includes(p as AiToolId)) throw new UsageError(`Unknown AI tool: ${p}. One of: ${IDS.join(", ")}`);
    const ids = positionals.length ? (positionals as AiToolId[]) : undefined;

    if (values.list) {
      for (const t of await listAiTools()) {
        const state = !t.installed && !t.connected ? c.dim("not installed") : t.connected ? (t.current ? c.green("connected") : c.yellow("points at an old copy of dx")) : c.yellow("not connected");
        console.log(`  ${t.name.padEnd(15)} ${state}`);
      }
      return;
    }

    if (values.undo) {
      const results = await disconnectAiTools(ids);
      if (!ids) saveConfig({ ...loadConfig(), autoConnectAi: false });
      if (!results.length) info("dx isn't connected to any AI tool.");
      for (const r of results) (r.ok ? ok : warn)(`${r.name}: ${r.message}`);
      if (!ids) info(c.dim("dx won't connect itself to new AI tools. Run dx setup to turn that back on."));
      recordRun("setup", results.every((r) => r.ok), `disconnected ${results.map((r) => r.name).join(", ") || "nothing"}`);
      return results.every((r) => r.ok) ? 0 : 1;
    }

    if (!ids && loadConfig().autoConnectAi === false) saveConfig({ ...loadConfig(), autoConnectAi: true });
    const results = await connectAiTools(ids);
    if (!results.length) {
      info("No AI tools found. dx works with Claude Code, Claude Desktop, Cursor, Windsurf and VS Code.");
      return;
    }
    for (const r of results) (r.ok ? ok : warn)(`${r.name}: ${r.message}`);
    recordRun("setup", results.every((r) => r.ok), results.map((r) => `${r.name}: ${r.message}`).join("; "));
    return results.every((r) => r.ok) ? 0 : 1;
  },
};

/** Runs once, the first time dx is used, so connecting AI tools needs no setup step. */
export async function firstRunSetup(): Promise<void> {
  const config = loadConfig();
  if (config.aiToolsSeen !== undefined || config.autoConnectAi === false) return;
  try {
    const results = await autoConnectAiTools();
    const done = results.filter((r) => r.ok);
    if (done.length) {
      info(c.dim(`dx connected itself to ${done.map((r) => r.name).join(", ")}, so they can run and check your apps. Undo: dx setup --undo`));
    }
  } catch {
    // Never let this get in the way of the command that was asked for.
  }
}

// ------------------------------------------------------------ dev servers in the dashboard

interface DevInfo {
  project: string;
  dir: string;
  url?: string;
  status: string;
  startedBy: string;
  errorCount: number;
  lastLine: number;
}

function pick(query: string): Project {
  const { match, candidates } = findProjects(query, scanProjects(loadConfig()));
  const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (project) return project;
  throw new Error(candidates.length ? `Several projects match "${query}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}` : `No project matches "${query}".`);
}

export const logsCommand: Command = {
  name: "logs",
  summary: "Show a dev server's output from the dashboard (one an AI agent started, say)",
  usage: ["dx logs todo-app        print its output so far", "dx logs todo-app -f     and keep following it (Ctrl+C stops)"].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { follow: { type: "boolean", short: "f" } } });
    if (!positionals[0]) throw new UsageError("Which project?");
    const project = pick(positionals[0]);
    const client = await findDashboard();
    if (!client) {
      info(`${project.name} isn't running in the dashboard. Start it with dx ui, or ask your AI tool to.`);
      return 1;
    }
    let after = 0;
    const show = async () => {
      const r = await client.get<{ lines: { n: number; stream: string; text: string }[]; server?: DevInfo }>(
        `/api/dev/logs?dir=${encodeURIComponent(project.dir)}&after=${after}`,
      );
      for (const l of r.lines) console.log(l.stream === "err" ? c.red(l.text) : l.stream === "dx" ? c.cyan(l.text) : l.text);
      if (r.lines.length) after = r.lines[r.lines.length - 1].n;
      return r.server;
    };
    const server = await show();
    if (!server) {
      info(`${project.name} isn't running in the dashboard.`);
      return 1;
    }
    if (!values.follow) return;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => void show().catch(() => (clearInterval(timer), resolve())), 1000);
      process.once("SIGINT", () => (clearInterval(timer), resolve()));
    });
  },
};

export const errorsCommand: Command = {
  name: "errors",
  summary: "Errors in the dev servers running in the dashboard, with file and line",
  usage: ["dx errors               every running server", "dx errors todo-app      one project", "dx errors --all         include errors a clean rebuild resolved"].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: "boolean" } } });
    const dir = positionals[0] ? pick(positionals[0]).dir : "";
    const client = await findDashboard();
    const list = client
      ? await client.get<{ project: string; errors: DevError[] }[]>(`/api/dev/errors?dir=${encodeURIComponent(dir)}${values.all ? "&all=1" : ""}`)
      : [];
    if (!list.length) {
      info("No dev servers are running in the dashboard.");
      return;
    }
    let total = 0;
    for (const s of list) {
      console.log(c.bold(s.project));
      if (!s.errors.length) console.log(`  ${c.green("✓")} no errors`);
      for (const e of s.errors) {
        total++;
        const where = e.file ? c.cyan(` ${e.file}${e.line ? `:${e.line}` : ""}${e.column ? `:${e.column}` : ""}`) : "";
        console.log(`  ${e.resolved ? c.dim("resolved") : c.red("✗")} ${e.message}${where}${e.count > 1 ? c.dim(` ×${e.count}`) : ""}`);
      }
    }
    return total ? 1 : 0;
  },
};

export const fixCommand: Command = {
  name: "fix",
  summary: "Ask Claude Code for a fix to a dev server's newest error, and print the patch (nothing is applied)",
  usage: [
    "dx fix todo-app         the newest error of its dev server in the dashboard",
    "",
    "Sends the error, the code around it and your uncommitted changes to your Claude account (claude -p).",
    "The patch is only printed: apply it from the Projects page (Ask Claude to fix), where Undo puts the files back.",
  ].join("\n"),
  async run(argv) {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
    if (!positionals[0]) throw new UsageError("Which project?");
    const project = pick(positionals[0]);
    const client = await findDashboard();
    const [server] = client ? await client.get<{ project: string; errors: DevError[] }[]>(`/api/dev/errors?dir=${encodeURIComponent(project.dir)}`) : [];
    const error = server?.errors[0];
    if (!client || !server) {
      info(`${project.name} isn't running in the dashboard. Start it with dx ui, or ask your AI tool to.`);
      return 1;
    }
    if (!error) {
      ok(`${project.name} has no errors right now.`);
      return;
    }
    info(`Asking Claude about ${c.bold(error.message)}${c.dim(" (this can take a minute)")}`);
    const r = await client.post<{ ok: boolean; id?: string; patch?: string; files?: string[]; explanation: string; reason?: string; answer: string }>(
      "/api/fix/propose",
      { dir: project.dir, source: "dev", id: error.id },
      120_000,
    );
    if (!r.ok) {
      warn(r.reason ?? "Claude's answer can't be applied.");
      console.log(c.dim(r.answer));
      return 1;
    }
    for (const line of (r.patch ?? "").replace(/\n$/, "").split("\n")) {
      console.log(line.startsWith("+") && !line.startsWith("+++") ? c.green(line) : line.startsWith("-") && !line.startsWith("---") ? c.red(line) : line.startsWith("@@") ? c.cyan(line) : line);
    }
    if (r.explanation) console.log(`\n${r.explanation}`);
    info(c.dim(`Nothing was changed. To apply it, open the error on the Projects page (dx ui) and use Ask Claude to fix there, or apply this patch yourself.`));
  },
};
