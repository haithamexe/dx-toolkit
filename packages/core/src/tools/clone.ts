import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type DxConfig } from "../config.js";
import { recordRun } from "../runs.js";
import { commandExists } from "./doctor.js";
import { checkEnv, ensureEnvFile, type EnvReport } from "./envcheck.js";
import { readProject, type Project } from "./projects.js";
import { isValidProjectName } from "./scaffold.js";
import { detectStack } from "./stacks.js";

/**
 * Gets a repository ready to run with one command: clone it into your projects folder, install
 * its packages with the package manager it uses, and create .env from .env.example. What can't be
 * done for you (a secret only you have) is listed at the end.
 */

export interface CloneStep {
  name: string;
  ok: boolean;
  detail?: string;
  /** How to do it by hand when it failed. */
  fix?: string;
}

export interface CloneOptions {
  url: string;
  /** Folder name; the repository's name by default. */
  name?: string;
  /** Where to put it; the first projects folder by default. */
  root?: string;
  /** Install packages (default true). */
  install?: boolean;
  /** Called as each step starts, for progress output. */
  onStep?: (step: string) => void;
  /** Called with each line the commands print. */
  onOutput?: (line: string) => void;
  /** Let git ask for a password in the terminal (only the CLI does). */
  interactive?: boolean;
  /** Where it was asked from, for dx runs: cli, mcp or dashboard. */
  source?: string;
  config?: DxConfig;
}

export interface CloneResult {
  ok: boolean;
  dir: string;
  name: string;
  steps: CloneStep[];
  project?: Project;
  env?: EnvReport;
  /** What starts when it runs: the dev command, or the stack's services. */
  runs?: string;
}

/** https, ssh and scp-style git addresses, or GitHub's owner/repo. Anything else is refused. */
export function normalizeGitUrl(input: string): string | undefined {
  const raw = input.trim();
  if (!raw || raw.startsWith("-") || /\s/.test(raw)) return undefined;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw) && !raw.includes("..")) return `https://github.com/${raw.replace(/\.git$/, "")}.git`;
  if (/^(https?|ssh|git):\/\/[^/]+\/.+/.test(raw)) return raw;
  if (/^file:\/\/\/.+/.test(raw)) return raw;
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(raw)) return raw;
  return undefined;
}

/** "https://github.com/octocat/todo-app.git" → "todo-app" */
export function repoName(url: string): string {
  return url.replace(/[\\/]+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() ?? "project";
}

export async function cloneProject(options: CloneOptions): Promise<CloneResult> {
  const url = normalizeGitUrl(options.url);
  if (!url) throw new Error(`"${options.url}" isn't a git address. Use https://…, git@host:owner/repo.git or owner/repo.`);
  const config = options.config ?? loadConfig();
  const name = options.name ?? repoName(url);
  if (!isValidProjectName(name)) throw new Error(`"${name}" can't be a folder name. Pass another with --name.`);
  const root = options.root ?? config.projectsRoots[0];
  if (!root) throw new Error("No projects folder is set. dx config add-root <folder>");
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, name);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists. Open it with: dx go ${name}`);
  if (!(await commandExists("git"))) throw new Error("git isn't installed. Install it from https://git-scm.com/downloads, then try again.");

  const result: CloneResult = { ok: false, dir, name, steps: [] };
  const step = (s: CloneStep) => result.steps.push(s);

  options.onStep?.(`Cloning ${url}`);
  const env = options.interactive ? process.env : { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const clone = await runStreaming("git", ["clone", "--", url, dir], root, options.onOutput, env);
  if (!clone.ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    const auth = /Authentication failed|could not read Username|Permission denied|Repository not found/i.test(clone.output);
    recordRun("clone", false, `${url}: ${lastLine(clone.output)}`, options.source ?? "cli");
    throw new Error(
      `git clone failed: ${lastLine(clone.output)}${auth ? "\nFor a private repository, sign in first: gh auth login, or set up an SSH key, then try again." : ""}`,
    );
  }
  step({ name: "Clone", ok: true, detail: dir });

  const project = readProject(dir, root);
  result.project = project;

  if (options.install !== false) {
    for (const install of await installSteps(dir, project)) {
      options.onStep?.(install.label);
      if (!install.command) {
        step({ name: install.label, ok: false, detail: install.why, fix: install.fix });
        continue;
      }
      const r = await runStreaming(install.command, install.args, install.cwd ?? dir, options.onOutput, process.env, install.shell);
      step({ name: install.label, ok: r.ok, detail: r.ok ? `${install.command} ${install.args.join(" ")}` : lastLine(r.output), fix: r.ok ? undefined : install.fix });
    }
  }

  const created = ensureEnvFile(dir);
  if (created) step({ name: "Environment", ok: true, detail: `created .env from ${path.basename(checkEnv(dir, { secrets: false }).exampleFile ?? ".env.example")}` });
  result.env = checkEnv(dir, { secrets: false });
  const needed = [...result.env.missing, ...result.env.empty];
  if (needed.length) {
    step({
      name: "Environment",
      ok: false,
      detail: `${needed.length} variable(s) have no value yet: ${needed.slice(0, 12).join(", ")}${needed.length > 12 ? ", …" : ""}`,
      fix: `Fill them in ${path.join(dir, ".env")}`,
    });
  }

  if (project) {
    const stack = detectStack(project);
    result.runs = stack ? stack.services.map((s) => s.name).join(" + ") : project.devCommand;
  }
  result.ok = result.steps.every((s) => s.ok || s.name === "Environment");
  recordRun("clone", result.ok, `${name}${result.ok ? "" : `: ${result.steps.filter((s) => !s.ok).map((s) => s.name).join(", ")} failed`}`, options.source ?? "cli", { project: name });
  return result;
}

interface InstallStep {
  label: string;
  command?: string;
  args: string[];
  cwd?: string;
  shell?: boolean;
  why?: string;
  fix?: string;
}

/** How to install this project's packages, with the tool its lock file says it uses. */
async function installSteps(dir: string, project: Project | undefined): Promise<InstallStep[]> {
  const steps: InstallStep[] = [];
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has("package.json")) {
    const pm = project?.packageManager ?? "npm";
    if (await commandExists(pm)) {
      steps.push({ label: `Install packages (${pm})`, command: pm, args: ["install"], shell: process.platform === "win32" });
    } else if (pm !== "npm" && pm !== "bun" && (await commandExists("corepack"))) {
      // Node ships corepack, which runs the pnpm or yarn version the project asks for.
      steps.push({ label: `Install packages (${pm}, through corepack)`, command: "corepack", args: [pm, "install"], shell: process.platform === "win32" });
    } else if (pm !== "npm" && pm !== "bun") {
      steps.push({ label: `Install packages (${pm}, through npx)`, command: "npx", args: ["--yes", pm, "install"], shell: process.platform === "win32" });
    } else {
      steps.push({ label: `Install packages (${pm})`, args: [], why: `${pm} isn't installed`, fix: pm === "bun" ? "npm install -g bun, then run bun install in the project" : "Install Node.js from https://nodejs.org" });
    }
  }
  if (has("requirements.txt") || has("pyproject.toml")) {
    const uv = has("uv.lock") && (await commandExists("uv"));
    if (uv) {
      steps.push({ label: "Install Python packages (uv)", command: "uv", args: ["sync"] });
    } else if (has("requirements.txt")) {
      const python = (await commandExists("python3")) ? "python3" : (await commandExists("python")) ? "python" : undefined;
      if (!python) {
        steps.push({ label: "Install Python packages", args: [], why: "Python isn't installed", fix: "Install Python from https://www.python.org/downloads/" });
      } else {
        const venvPython = process.platform === "win32" ? path.join(dir, ".venv", "Scripts", "python.exe") : path.join(dir, ".venv", "bin", "python");
        steps.push({ label: "Create a Python virtual environment", command: python, args: ["-m", "venv", ".venv"] });
        steps.push({ label: "Install Python packages", command: venvPython, args: ["-m", "pip", "install", "-r", "requirements.txt"] });
      }
    }
  }
  if (has("go.mod") && (await commandExists("go"))) steps.push({ label: "Download Go modules", command: "go", args: ["mod", "download"] });
  return steps;
}

function runStreaming(
  command: string,
  args: string[],
  cwd: string,
  onOutput: ((line: string) => void) | undefined,
  env: NodeJS.ProcessEnv,
  shell = false,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // The command and its arguments are fixed words chosen above; the URL is passed after "--".
    const child = shell
      ? spawn([command, ...args].join(" "), { cwd, env, shell: true, windowsHide: true })
      : spawn(command, args, { cwd, env, windowsHide: true });
    let output = "";
    let partial = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-20_000);
      if (!onOutput) return;
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) onOutput(l);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => resolve({ ok: false, output: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0, output }));
  });
}

function lastLine(output: string): string {
  return output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "no output";
}

