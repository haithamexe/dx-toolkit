import { spawn } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { ensureDashboard } from "@dx/web/link";
import {
  detectStack,
  runEnvFiles,
  runModes,
  findProjects,
  getProjectPort,
  killPort,
  listListeningPorts,
  loadConfig,
  openInEditor,
  openTerminal,
  openUrl,
  readProject,
  recordRun,
  rememberSession,
  resumeInfo,
  scanProjects,
  waitForPort,
  type Project,
} from "@dx/core";
import type { Command } from "../command.js";
import { projectLabel } from "./projects.js";
import { printResume } from "./resume.js";
import { follow } from "./stack.js";
import { c, confirm, info, ok, pick, tildify, UsageError, warn } from "../ui.js";

export const goCommand: Command = {
  name: "go",
  aliases: ["open"],
  summary: "Open a project in your editor and start its dev server",
  usage: [
    "dx go [search] [options]",
    "",
    "  -w, --window     run the dev server in a new terminal window instead of this one",
    "  --no-dev         only open the editor",
    "  --no-editor      only start the dev server",
    "  --no-browser     don't open the browser when the server is ready",
    "  --mode <id>      run it another way: production (build, then its server), script:<name>,",
    "                   devrc:<name> (from .devrc.json \"modes\"); --modes lists them",
    "  --env <file>     lay a .env.<name> file over .env, e.g. --env .env.staging",
    "",
    "Without a search, picks from your most recently active projects.",
    "Use . for the project in the current folder: dx go .",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        window: { type: "boolean", short: "w" },
        dev: { type: "boolean", default: true },
        editor: { type: "boolean", default: true },
        browser: { type: "boolean", default: true },
        mode: { type: "string" },
        env: { type: "string" },
        modes: { type: "boolean" },
      },
    });
    const config = loadConfig();
    const query = positionals.join(" ").trim();
    let project: Project | undefined;
    if (query === ".") {
      project = readProject(process.cwd());
      if (!project) throw new UsageError(`${process.cwd()} doesn't look like a project (no package.json, go.mod, .git, …).`);
    } else {
      const projects = scanProjects(config);
      if (projects.length === 0) throw new UsageError("No projects found. Add a folder with: dx config add-root <path>");
      project = await choose(query, projects);
    }
    if (!project) return 1;

    console.log(`${c.bold(project.name)} ${c.dim(tildify(project.dir))}`);
    // Coming back after a while: where you left off.
    const back = resumeInfo(project);
    if (back.session && (back.away ?? 0) > 2 * 3600_000) printResume(back);
    rememberSession(project.dir, project.name);

    if (values.editor) {
      const editor = project.editor ?? config.editor;
      try {
        await openInEditor(project.dir, editor);
        ok(`Opened in ${editor}`);
      } catch (err) {
        warn(`Couldn't open ${editor}: ${(err as Error).message}`);
      }
    }

    if (!values.dev) {
      recordRun("go", true, project.name, "cli", { project: project.name });
      return;
    }

    if (values.modes) {
      const modes = runModes(project);
      const envs = runEnvFiles(project.dir);
      if (!modes.length) info(`${project.name} has no way to run it yet. Add one in .devrc.json: { "dev": "..." }`);
      for (const m of modes) console.log(`  ${c.cyan(m.id.padEnd(22))} ${m.build ? `${m.build} && ` : ""}${m.command}${m.envFile ? c.dim(`  (with ${m.envFile})`) : ""}`);
      if (envs.length) console.log(`\n  .env files for --env: ${envs.map((e) => `${e.file} ${c.dim(`(${e.count})`)}`).join(", ")}`);
      return;
    }
    // Another mode or an env file: run through the dashboard, which checks both against the project's files.
    if (values.mode || values.env !== undefined) {
      const client = await ensureDashboard();
      const started = await client.post<{ run?: { label: string; envFile?: string } }>("/api/dev/start", { dir: project.dir, by: "terminal", ...(values.mode ? { mode: values.mode } : {}), ...(values.env !== undefined ? { env: values.env } : {}) });
      info(`Running ${project.name}${started.run ? ` as ${[started.run.label, started.run.envFile && `with ${started.run.envFile}`].filter(Boolean).join(", ")}` : ""}  ${c.dim("(Ctrl+C stops it)")}\n`);
      return follow(client, project, values.browser);
    }
    const stack = detectStack(project);
    if (stack) {
      if (values.window) {
        await openTerminal(project.dir, "dx go . --no-editor", project.name);
        ok(`Started the stack in a new terminal window`);
        return;
      }
      info(`Starting ${stack.services.map((s) => c.cyan(s.name)).join(", ")} in order  ${c.dim("(Ctrl+C stops them all)")}\n`);
      const client = await ensureDashboard();
      await client.post("/api/dev/start", { dir: project.dir, by: "terminal" });
      return follow(client, project, values.browser);
    }
    if (!project.devCommand) {
      info(`No dev command found. Add one in ${tildify(path.join(project.dir, ".devrc.json"))}: { "dev": "..." }`);
      recordRun("go", true, project.name, "cli", { project: project.name });
      return;
    }

    const port = getProjectPort(project);
    if (port !== undefined) {
      const decision = await handleBusyPort(project, port);
      if (decision === "already-running") {
        if (values.browser && project.url) await openBrowser(project.url);
        recordRun("go", true, `${project.name} (already running)`, "cli", { project: project.name });
        return;
      }
    }

    const timeoutMs = config.devServerTimeout * 1000;
    if (values.window) {
      await openTerminal(project.dir, project.devCommand, project.name);
      ok(`Started ${c.cyan(project.devCommand)} in a new terminal window`);
      if (values.browser && port !== undefined && project.url) await openWhenReady(project.url, port, timeoutMs);
      recordRun("go", true, project.name, "cli", { project: project.name });
      return;
    }

    info(`Running ${c.cyan(project.devCommand)}  ${c.dim("(Ctrl+C to stop)")}\n`);
    const startedAt = Date.now();
    const { code, interrupted } = await runForeground(
      project,
      values.browser && port !== undefined ? port : undefined,
      timeoutMs,
    );
    // Stopping the server with Ctrl+C is the normal way to finish, not a failure.
    if (interrupted) {
      recordRun("go", true, `${project.name} dev stopped with Ctrl+C`, "cli", { project: project.name, ms: Date.now() - startedAt });
      return 0;
    }
    recordRun("go", code === 0, `${project.name} dev exited with ${code}`, "cli", { project: project.name, ms: Date.now() - startedAt });
    return code;
  },
};

async function choose(query: string, projects: Project[]): Promise<Project | undefined> {
  const { match, candidates } = findProjects(query, projects);
  if (match) return match;
  if (candidates.length === 0) {
    console.log(`No project matches "${query}". See them all with: dx projects`);
    return undefined;
  }
  if (candidates.length === 1) return candidates[0];
  console.log(query ? `Several projects match "${query}":` : "Recent projects:");
  return pick(candidates.slice(0, 12), projectLabel);
}

/**
 * If the project's port is taken: when it's this project's own dev server, reuse it;
 * otherwise offer to kill whatever holds it.
 */
async function handleBusyPort(project: Project, port: number): Promise<"free" | "already-running" | "busy"> {
  let entries;
  try {
    entries = await listListeningPorts(port);
  } catch {
    return "free"; // can't inspect ports; let the dev server report a clash itself
  }
  if (entries.length === 0) return "free";

  const dir = project.dir.toLowerCase();
  const own = entries.find((e) => e.commandLine?.toLowerCase().includes(dir));
  if (own) {
    ok(`Already running on port ${port} (PID ${own.pid}), opening it`);
    return "already-running";
  }

  const who = entries.map((e) => `${e.processName ?? "unknown"} (PID ${e.pid})`).join(", ");
  warn(`Port ${port} is already used by ${who}.`);
  if (await confirm(`Kill it and continue?`)) {
    const { results } = await killPort(port);
    for (const r of results) (r.ok ? ok : warn)(r.message);
    return "free";
  }
  info("Starting anyway; the dev server may pick another port.");
  return "busy";
}

async function openWhenReady(url: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const ready = await waitForPort(port, timeoutMs, signal);
  if (signal?.aborted) return;
  if (!ready) {
    warn(`Port ${port} didn't open within ${Math.round(timeoutMs / 1000)}s, so the browser wasn't opened.`);
    return;
  }
  await openBrowser(url);
}

async function openBrowser(url: string): Promise<void> {
  try {
    await openUrl(url);
    ok(`Ready, opened ${c.cyan(url)}`);
  } catch (err) {
    warn(`Couldn't open the browser: ${(err as Error).message}. The app is at ${url}`);
  }
}

function runForeground(
  project: Project,
  port: number | undefined,
  timeoutMs: number,
): Promise<{ code: number; interrupted: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(project.devCommand!, { cwd: project.dir, shell: true, stdio: "inherit" });
    const abort = new AbortController();
    // Ctrl+C reaches the dev server directly; dx just notes it and waits for the server to shut down.
    let interrupted = false;
    const onInterrupt = () => {
      interrupted = true;
    };
    process.on("SIGINT", onInterrupt);
    if (port !== undefined && project.url) void openWhenReady(project.url, port, timeoutMs, abort.signal);
    const finish = (code: number) => {
      abort.abort();
      process.off("SIGINT", onInterrupt);
      resolve({ code, interrupted });
    };
    child.once("error", (err) => {
      warn(`Couldn't start the dev server: ${err.message}`);
      finish(1);
    });
    child.once("exit", (code, signal) => finish(code ?? (signal ? 130 : 1)));
  });
}
