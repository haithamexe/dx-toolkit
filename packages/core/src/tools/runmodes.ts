import fs from "node:fs";
import path from "node:path";
import { stripBom } from "../config.js";
import { EXAMPLE_FILES, parseDotenv } from "./envcheck.js";
import { detectPackageManager, type Project } from "./projects.js";

/**
 * The ways a project can be run, besides its dev server: a production build then its server, the
 * project's own per-environment scripts (`start:staging`), and modes the project names in
 * `.devrc.json`. Separately, any `.env.<name>` file can be laid over a run: its values go into the
 * process's environment, which dotenv, Vite, Next.js and `node --env-file` all let win over the
 * project's `.env`. Commands come only from the project's own files (package.json scripts,
 * `.devrc.json`) or fixed words; nothing from a request.
 */

export interface RunMode {
  /** "dev", "production", "script:<name>" or "devrc:<name>". */
  id: string;
  label: string;
  /** Run first, and the server only when it succeeds. */
  build?: string;
  command: string;
  /** Set for this run (NODE_ENV=production for a production build). */
  vars?: Record<string, string>;
  /** A `.env.<name>` file the mode uses unless another is picked. */
  envFile?: string;
  /** Where it came from, for the page. */
  source: "dev" | "production" | "script" | "devrc";
}

export interface RunEnvFile {
  /** ".env.staging" */
  file: string;
  /** "staging" */
  name: string;
  /** How many values it sets (never the values). */
  count: number;
}

export interface RunChoice {
  mode?: string;
  /** A file name from runEnvFiles(), or "" / undefined for none. */
  env?: string;
}

/** Words that name an environment in a script (`start:staging`, `serve:prod`). */
const ENV_WORDS = /^(prod|production|staging|stage|stg|preview|qa|uat|test|demo|sandbox|local|development|dev)$/i;
/** `.env.<name>` files that aren't an environment of their own: examples and the local overrides. */
const NOT_AN_ENV = /^(example|sample|template|dist|defaults?|local|.*\.local)$/i;

interface DevRcModes {
  modes?: Record<string, { label?: unknown; build?: unknown; run?: unknown; env?: unknown; vars?: unknown }>;
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8"))) as T;
  } catch {
    return undefined;
  }
};

/** The `.env.<name>` files in the project's folder, each named by what follows `.env.`. */
export function runEnvFiles(dir: string): RunEnvFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((f) => /^\.env\.[\w.-]+$/.test(f) && !EXAMPLE_FILES.includes(f))
    .map((file) => ({ file, name: file.slice(5) }))
    .filter((e) => !NOT_AN_ENV.test(e.name))
    .filter((e) => {
      try {
        return fs.lstatSync(path.join(dir, e.file)).isFile();
      } catch {
        return false;
      }
    })
    .map((e) => ({ ...e, count: readEnvValues(dir, e.file).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The values of one of runEnvFiles()'s files: a plain file in the project's own folder only. */
export function readEnvValues(dir: string, file: string): Map<string, string> {
  if (!/^\.env\.[\w.-]+$/.test(file) || file.includes("..")) return new Map();
  const full = path.join(dir, file);
  try {
    if (!fs.lstatSync(full).isFile() || fs.statSync(full).size > 256 * 1024) return new Map();
    return parseDotenv(fs.readFileSync(full, "utf8"));
  } catch {
    return new Map();
  }
}

/** Every way to run the project: its dev server first. */
export function runModes(project: Project): RunMode[] {
  const modes: RunMode[] = [];
  if (project.devCommand) modes.push({ id: "dev", label: "Dev server", command: project.devCommand, source: "dev" });
  const pkgFile = path.join(project.dir, "package.json");
  const pkg = readJson<{ scripts?: Record<string, string>; packageManager?: string }>(pkgFile);
  const scripts = pkg?.scripts ?? {};
  const pm = pkg ? detectPackageManager(project.dir, pkg) : undefined;
  const run = (s: string) => `${pm ?? "npm"} run ${s}`;
  const envFiles = runEnvFiles(project.dir);
  const envFor = (word: string) => envFiles.find((e) => e.name.toLowerCase() === word.toLowerCase() || (/^prod/i.test(word) && /^prod/i.test(e.name)))?.file;

  if (pkg) {
    // A production build and its own server: next start, vite/astro preview, a serve script. A
    // start script that is the dev server (react-scripts start, the dev command) doesn't count.
    const devScript = project.devCommand?.match(/ run ([\w:.-]+)$/)?.[1];
    const server = ["start", "preview", "serve", "start:prod", "serve:prod"].find((s) => scripts[s] && s !== devScript && !/react-scripts start|vite(\s|$)(?!build|preview)|next dev|nodemon|--watch|watch\b/.test(scripts[s]));
    if (scripts.build && server) {
      modes.push({ id: "production", label: "Production build", build: run("build"), command: run(server), vars: { NODE_ENV: "production" }, envFile: envFor("production"), source: "production" });
    }
    for (const [name] of Object.entries(scripts)) {
      const m = /^(dev|start|serve|preview):([\w-]+)$/.exec(name);
      if (!m || !ENV_WORDS.test(m[2]) || name === server || name === devScript) continue;
      const build = scripts[`build:${m[2]}`] ? run(`build:${m[2]}`) : m[1] !== "dev" && scripts.build ? run("build") : undefined;
      modes.push({ id: `script:${name}`, label: `${name}`, build, command: run(name), envFile: envFor(m[2]), vars: /^prod/i.test(m[2]) ? { NODE_ENV: "production" } : undefined, source: "script" });
    }
  } else if (project.kind === "rust") {
    modes.push({ id: "production", label: "Release build", command: "cargo run --release", source: "production" });
  } else if (project.kind === "dotnet") {
    modes.push({ id: "production", label: "Release build", command: "dotnet run -c Release", vars: { ASPNETCORE_ENVIRONMENT: "Production" }, source: "production" });
  }

  // The project's own modes, named in .devrc.json: { "modes": { "staging": { "build": "...", "run": "...", "env": ".env.staging" } } }
  const devrc = readJson<DevRcModes>(path.join(project.dir, ".devrc.json"));
  for (const [name, m] of Object.entries(devrc?.modes ?? {})) {
    if (!/^[\w-]{1,40}$/.test(name) || !m || typeof m.run !== "string" || !m.run.trim()) continue;
    const vars = m.vars && typeof m.vars === "object" ? Object.fromEntries(Object.entries(m.vars as Record<string, unknown>).filter(([k, v]) => /^[A-Za-z_][\w]*$/.test(k) && typeof v === "string")) as Record<string, string> : undefined;
    const env = typeof m.env === "string" && envFiles.some((e) => e.file === m.env) ? m.env : undefined;
    const mode: RunMode = { id: `devrc:${name}`, label: typeof m.label === "string" && m.label.trim() ? m.label.trim().slice(0, 60) : name, build: typeof m.build === "string" && m.build.trim() ? m.build : undefined, command: m.run, vars, envFile: env, source: "devrc" };
    modes.push(mode);
  }
  return modes;
}

/** Just a .env file's values, for a stack (each app service gets them). Throws on a file the project doesn't have. */
export function resolveEnvFile(project: Project, file: string): { env: Record<string, string>; envFile: string } {
  if (!runEnvFiles(project.dir).some((e) => e.file === file)) throw new Error(`${project.name} has no ${file}.`);
  return { env: Object.fromEntries(readEnvValues(project.dir, file)), envFile: file };
}

export interface ResolvedRun {
  mode: RunMode;
  /** The whole command: the build, then the server only if it succeeded. */
  command: string;
  /** Variables for the process: the env file's values, then the mode's own. */
  env: Record<string, string>;
  envFile?: string;
  /** For the log: never values. */
  note: string;
}

/**
 * The run to start for a choice: the mode (dev when none), its build joined with `&&` (which cmd.exe
 * and sh both read as "only if it worked"), and the env file laid over it. Throws on a mode or env
 * file the project doesn't have.
 */
export function resolveRun(project: Project, choice: RunChoice = {}): ResolvedRun {
  const modes = runModes(project);
  const mode = modes.find((m) => m.id === (choice.mode || "dev"));
  if (!mode) throw new Error(choice.mode && choice.mode !== "dev" ? `${project.name} has no run mode "${choice.mode}". It has: ${modes.map((m) => m.id).join(", ") || "none"}.` : `${project.name} has no dev command. Add one in .devrc.json: { "dev": "..." }`);
  const envFile = choice.env === "" ? undefined : choice.env ?? mode.envFile;
  if (envFile && !runEnvFiles(project.dir).some((e) => e.file === envFile)) throw new Error(`${project.name} has no ${envFile}.`);
  const values = envFile ? Object.fromEntries(readEnvValues(project.dir, envFile)) : {};
  const env = { ...values, ...(mode.vars ?? {}) };
  const command = mode.build ? `${mode.build} && ${mode.command}` : mode.command;
  const parts = [mode.id === "dev" ? undefined : mode.label, envFile ? `${envFile} (${Object.keys(values).length} values)` : undefined].filter(Boolean);
  return { mode, command, env, envFile, note: parts.length ? `Running as ${parts.join(", with ")}.` : "" };
}
