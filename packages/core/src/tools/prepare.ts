import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dxPath, stripBom } from "../config.js";
import { commandExists } from "./doctor.js";
import { ensureEnvFile, parseDotenv } from "./envcheck.js";
import { listListeningPorts } from "./ports.js";
import { getProjectPort, type PackageManager, type Project } from "./projects.js";

/**
 * Getting a project ready before its dev server starts, so Run works on a fresh clone or after a
 * pull: packages installed (again when the lock file changed), .env made from its example, Docker
 * running, code generated (Prisma), workspace packages the app imports built, database
 * migrations applied, the usual port free. Each step says why it runs, shows its output, and on
 * failure says how to fix it. Steps are found from the project's own files; nothing runs while
 * finding them. What finished is remembered (~/.dx/prepare.json) so the next start skips it.
 *
 * Migrations run only against a database on this computer (localhost, Docker, SQLite): when the
 * project's .env points somewhere else, dx says so and leaves it alone.
 */

export type StepAction = "shell" | "env" | "docker" | "port";
export type StepStatus = "todo" | "ok" | "skip" | "running" | "done" | "warn" | "failed";

export interface PrepareStep {
  id: string;
  title: string;
  /** Why it runs (or why it's skipped, or what it found). */
  why: string;
  /** "before" runs before anything starts; "db" once a stack's databases are up (migrations). */
  phase: "before" | "db";
  action?: StepAction;
  /** For "shell": a command made of fixed words and the project's own file and script names. */
  command?: string;
  cwd?: string;
  /** Stops the start when it fails. */
  blocking: boolean;
  status: StepStatus;
  fix?: string;
  /** After a failure: the line of its output that says what went wrong. */
  output?: string;
  /** Remembered once it succeeded, so the same inputs don't run it again. */
  fingerprint?: { key: string; value: string };
  timeoutMs?: number;
  /** What the step needs on PATH. */
  needs?: string;
}

export interface PrepareOptions {
  /** Run every step, as if nothing were remembered (Prepare again). */
  force?: boolean;
  /** For a stack: it has Docker services, so Docker must be running. */
  docker?: boolean;
  /** Stack services' folders, for their own packages (a back end in its own folder). */
  extraDirs?: string[];
}

interface DevRcPrepare {
  prepare?: false | Array<string | { run: string; after?: "db"; title?: string }>;
}

// ------------------------------------------------------------------ remembering what finished

function storeFile(): string {
  return dxPath("prepare.json");
}
function dirKey(dir: string): string {
  const r = path.resolve(dir);
  return process.platform === "linux" ? r : r.toLowerCase();
}
function loadStore(): Record<string, Record<string, string>> {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), "utf8"));
  } catch {
    return {};
  }
}
export function remembered(dir: string, key: string): string | undefined {
  return loadStore()[dirKey(dir)]?.[key];
}
export function remember(dir: string, key: string, value: string): void {
  const store = loadStore();
  (store[dirKey(dir)] ??= {})[key] = value;
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(store, null, 1));
  } catch {
    // run again next time
  }
}
/** Forgets what finished for a project, so every step runs on the next start. */
export function forgetPrepared(dir: string): void {
  const store = loadStore();
  delete store[dirKey(dir)];
  try {
    fs.writeFileSync(storeFile(), JSON.stringify(store, null, 1));
  } catch {
    // nothing to forget
  }
}

const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
function fileHash(file: string): string | undefined {
  try {
    return hash(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
  } catch {
    return undefined;
  }
}
/** Names and sizes of the files in a folder (two levels): changes when a migration is added or edited. */
function folderPrint(dir: string): string | undefined {
  if (!isDir(dir)) return undefined;
  const parts: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const e of safeReaddir(d)) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 2 && e.name !== "__pycache__" && e.name !== "node_modules") walk(full, depth + 1);
      } else {
        try {
          parts.push(`${path.relative(dir, full)}:${fs.statSync(full).size}`);
        } catch {
          // gone
        }
      }
    }
  };
  walk(dir, 0);
  return hash(parts.sort().join("\n"));
}

// ------------------------------------------------------------------ finding the steps

/** What a project needs before its dev server starts. Reads files only; quick. */
export function planPrepare(project: Pick<Project, "dir" | "name" | "packageManager"> & Partial<Project>, options: PrepareOptions = {}): PrepareStep[] {
  const dir = project.dir;
  const devrc = readJson<DevRcPrepare>(path.join(dir, ".devrc.json"));
  if (devrc?.prepare === false) return [];
  const steps: PrepareStep[] = [];
  const add = (s: Omit<PrepareStep, "status"> & { status?: StepStatus; doneWhy?: string }) => {
    const done = !options.force && s.fingerprint && remembered(dir, s.fingerprint.key) === s.fingerprint.value;
    const { doneWhy, ...step } = s;
    steps.push({ ...step, status: s.status ?? (done ? "ok" : "todo"), why: done && !s.status ? (doneWhy ?? "done, and nothing it depends on changed since") : s.why });
  };

  for (const d of [dir, ...(options.extraDirs ?? []).filter((x) => dirKey(x) !== dirKey(dir))]) packageSteps(d, d === dir ? project.packageManager : undefined, add, dir);
  envSteps(dir, add);
  if (options.docker) add({ id: "docker", title: "Docker is running", why: "the stack starts its databases with docker compose", phase: "before", action: "docker", blocking: true, fix: "Start Docker Desktop (or the docker service), then Run again" });
  generateSteps(dir, add);
  workspaceBuildSteps(dir, project.packageManager, add);
  migrationSteps(dir, project.packageManager, add, !!options.docker);
  for (const [i, c] of (Array.isArray(devrc?.prepare) ? devrc!.prepare : []).entries()) {
    const step = typeof c === "string" ? { run: c } : c;
    if (!step?.run || typeof step.run !== "string") continue;
    add({ id: `custom-${i}`, title: step.title ?? step.run, why: "from .devrc.json", phase: step.after === "db" ? "db" : "before", action: "shell", command: step.run, cwd: dir, blocking: true, timeoutMs: 600_000, fix: "Fix what it says and Run again, or change the step in .devrc.json" });
  }
  const port = project.url ? getProjectPort(project as Project) : undefined;
  if (port) add({ id: "port", title: `Port ${port} is free`, why: `${project.name} usually runs there`, phase: "before", action: "port", blocking: false });
  return steps;
}

type Add = (s: Omit<PrepareStep, "status"> & { status?: StepStatus; doneWhy?: string }) => void;

function packageSteps(dir: string, pm: PackageManager | undefined, add: Add, root: string): void {
  const rel = path.relative(root, dir) || ".";
  const where = rel === "." ? "" : ` in ${rel}`;
  if (exists(dir, "package.json")) {
    const manager = pm ?? detectPm(dir);
    const lock = ({ npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: exists(dir, "bun.lock") ? "bun.lock" : "bun.lockb" } as const)[manager];
    const lockPrint = fileHash(path.join(dir, lock)) ?? fileHash(path.join(dir, "package.json"));
    const nm = path.join(dir, "node_modules");
    // A workspace package's packages come with the root's install.
    if (rel !== "." && !exists(dir, lock)) return;
    // Nothing to install: no dependencies at all, and no workspaces that might have some.
    const manifest = readJson<{ dependencies?: object; devDependencies?: object; optionalDependencies?: object; workspaces?: unknown }>(path.join(dir, "package.json"));
    const hasDeps = [manifest?.dependencies, manifest?.devDependencies, manifest?.optionalDependencies].some((d) => d && Object.keys(d).length) || !!manifest?.workspaces || exists(dir, "pnpm-workspace.yaml");
    if (!hasDeps) return;
    const missing = !isDir(nm) || safeReaddir(nm).filter((e) => !e.name.startsWith(".")).length === 0;
    let why = missing ? "node_modules is missing" : `${exists(dir, lock) ? lock : "package.json"} changed since the last install`;
    let status: StepStatus | undefined;
    if (!missing && !remembered(root, `install:${rel}`)) {
      // First time dx sees it: installed packages newer than the lock file count as installed.
      const marker = ["node_modules/.package-lock.json", "node_modules/.modules.yaml", "node_modules/.yarn-integrity", "node_modules/.yarn-state.yml"].map((m) => path.join(dir, m)).find((m) => fs.existsSync(m)) ?? nm;
      if (mtime(marker) >= mtime(path.join(dir, exists(dir, lock) ? lock : "package.json"))) {
        remember(root, `install:${rel}`, lockPrint ?? "");
        why = "already installed";
        status = "ok";
      }
    }
    add({
      id: `install:${rel}`,
      title: `Install packages${where} (${manager} install)`,
      why,
      phase: "before",
      action: "shell",
      command: `${manager} install`,
      needs: manager,
      cwd: dir,
      blocking: true,
      status: missing ? "todo" : status,
      fix: manager === "npm" ? "Run npm install in the project to see the whole error" : `Install ${manager} (corepack enable), or run ${manager} install in the project`,
      fingerprint: missing ? undefined : { key: `install:${rel}`, value: lockPrint ?? "" },
      doneWhy: `installed, and ${exists(dir, lock) ? lock : "package.json"} hasn't changed since`,
      timeoutMs: 900_000,
    });
  }
  const venv = [".venv", "venv"].find((v) => isDir(path.join(dir, v)));
  if (exists(dir, "uv.lock")) {
    add({ id: `python:${rel}`, title: `Install Python packages${where} (uv sync)`, why: venv ? "uv.lock changed since the last sync" : "no virtual environment yet", phase: "before", action: "shell", command: "uv sync", needs: "uv", cwd: dir, blocking: true, fingerprint: { key: `python:${rel}`, value: fileHash(path.join(dir, "uv.lock")) ?? "" }, doneWhy: "installed, and uv.lock hasn't changed since", timeoutMs: 900_000 });
  } else if (exists(dir, "requirements.txt")) {
    const python = process.platform === "win32" ? "python" : "python3";
    const venvPython = venvBin(dir, venv ?? ".venv", "python");
    const command = venv ? `"${venvPython}" -m pip install -r requirements.txt` : `${python} -m venv .venv && "${venvBin(dir, ".venv", "python")}" -m pip install -r requirements.txt`;
    add({ id: `python:${rel}`, title: `Install Python packages${where} (pip)`, why: venv ? "requirements.txt changed since the last install" : "no virtual environment yet (.venv)", phase: "before", action: "shell", command, needs: venv ? undefined : python, cwd: dir, blocking: true, fingerprint: { key: `python:${rel}`, value: fileHash(path.join(dir, "requirements.txt")) ?? "" }, doneWhy: "installed, and requirements.txt hasn't changed since", timeoutMs: 900_000, status: venv ? undefined : "todo" });
  }
}

function envSteps(dir: string, add: Add): void {
  const example = [".env.example", ".env.sample", ".env.template", ".env.dist"].find((f) => exists(dir, f));
  if (!example) return;
  if (!exists(dir, ".env")) {
    add({ id: "env", title: `Create .env from ${example}`, why: ".env is missing", phase: "before", action: "env", cwd: dir, blocking: false, fix: `Fill in its empty values: the Env & secrets page shows which` });
    return;
  }
  // Values the example has and .env doesn't: a warning, since the app may run without them.
  const want = parseDotenv(readText(path.join(dir, example)) ?? "");
  const have = parseDotenv(readText(path.join(dir, ".env")) ?? "");
  const missing = [...want.keys()].filter((k) => !have.has(k));
  if (missing.length) add({ id: "env", title: ".env has every value", why: `${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""} ${missing.length === 1 ? "is" : "are"} in ${example} but not in .env`, phase: "before", blocking: false, status: "warn", fix: "Add them on the Env & secrets page" });
}

function generateSteps(dir: string, add: Add): void {
  const schema = prismaSchema(dir);
  if (!schema) return;
  const generated = isDir(path.join(dir, "node_modules", ".prisma", "client")) || isDir(path.join(dir, "node_modules", "@prisma", "client", "runtime"));
  add({
    id: "prisma-generate",
    title: "Generate the Prisma client (prisma generate)",
    why: generated ? "the schema changed since it was generated" : "it hasn't been generated yet",
    phase: "before",
    action: "shell",
    command: "npx prisma generate",
    cwd: dir,
    blocking: true,
    fingerprint: { key: "prisma-generate", value: fileHash(schema) ?? "" },
    doneWhy: "generated, and the schema hasn't changed since",
    status: generated ? undefined : "todo",
    timeoutMs: 300_000,
  });
}

/**
 * Workspace packages the app imports whose entry points at a build folder that isn't there
 * (main: "dist/index.js" with no dist): built first, with their own build script.
 */
function workspaceBuildSteps(dir: string, pm: PackageManager | undefined, add: Add): void {
  const pkg = readJson<{ workspaces?: string[] | { packages?: string[] }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(path.join(dir, "package.json"));
  if (!pkg) return;
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? pnpmWorkspaces(dir));
  if (!patterns.length) return;
  const manager = pm ?? detectPm(dir);
  for (const wsDir of expandWorkspaces(dir, patterns)) {
    const p = readJson<{ name?: string; main?: string; types?: string; module?: string; exports?: unknown; scripts?: Record<string, string> }>(path.join(wsDir, "package.json"));
    if (!p?.name || !p.scripts?.build) continue;
    const entry = [p.main, p.module, p.types, typeof p.exports === "string" ? p.exports : undefined].find((x): x is string => typeof x === "string" && /^(\.\/)?(dist|build|lib|out)\//.test(x));
    if (!entry || fs.existsSync(path.join(wsDir, entry))) continue;
    const command = manager === "pnpm" ? `pnpm --filter ${p.name} build` : manager === "yarn" ? `yarn workspace ${p.name} build` : manager === "bun" ? `bun run --cwd "${path.relative(dir, wsDir)}" build` : `npm run build -w ${p.name}`;
    add({ id: `build:${p.name}`, title: `Build ${p.name}`, why: `the app imports it from ${entry}, which isn't built yet`, phase: "before", action: "shell", command, cwd: dir, blocking: true, status: "todo", timeoutMs: 600_000 });
  }
}

/** The project's way to apply database migrations, its own script first. */
function migrationSteps(dir: string, pm: PackageManager | undefined, add: Add, stackHasDocker: boolean): void {
  const pkg = readJson<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(path.join(dir, "package.json"));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const manager = pm ?? detectPm(dir);
  const runScript = (s: string) => (manager === "npm" ? `npm run ${s}` : `${manager} run ${s}`);
  type Found = { tool: string; command: string; print?: string; needs?: string };
  let found: Found | undefined;

  const script = ["db:migrate", "migrate", "migrate:latest", "migration:run", "migrations:run", "db:migrate:dev", "prisma:migrate", "typeorm:migrate"].find((s) => pkg?.scripts?.[s]);
  const schema = prismaSchema(dir);
  const prismaMigrations = schema ? path.join(path.dirname(schema), "migrations") : undefined;
  if (script) {
    const text = pkg!.scripts![script];
    // A script that also wipes, resets or seeds the database is for a person to run, not dx.
    if (/\breset\b|\bdrop\b|fresh|accept-data-loss|force-reset|truncate|\bseed\b|db\s+push/i.test(text)) {
      add({ id: "migrate", title: `Apply database migrations (its ${script} script)`, why: `the script also resets, drops or seeds data (${text.slice(0, 80)}), so dx doesn't run it by itself`, phase: "db", blocking: false, status: "skip", fix: `Run ${runScript(script)} yourself when you mean to` });
      return;
    }
    const migrationsDir = [prismaMigrations, ...["migrations", "db/migrations", "src/migrations", "drizzle", "src/db/migrations", "database/migrations"].map((m) => path.join(dir, m))].find((m): m is string => !!m && isDir(m));
    found = { tool: `its ${script} script`, command: runScript(script), print: migrationsDir ? folderPrint(migrationsDir) : undefined };
  } else if (schema && prismaMigrations && isDir(prismaMigrations)) {
    found = { tool: "Prisma", command: "npx prisma migrate deploy", print: folderPrint(prismaMigrations) };
  } else if (deps["drizzle-kit"] && ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs"].some((f) => exists(dir, f))) {
    const out = ["drizzle", "migrations", "src/db/migrations"].find((m) => isDir(path.join(dir, m)));
    if (out) found = { tool: "Drizzle", command: "npx drizzle-kit migrate", print: folderPrint(path.join(dir, out)) };
  } else if (["knexfile.js", "knexfile.ts", "knexfile.cjs", "knexfile.mjs"].some((f) => exists(dir, f))) {
    found = { tool: "Knex", command: "npx knex migrate:latest", print: folderPrint(path.join(dir, "migrations")) };
  } else if (deps["sequelize-cli"] && (exists(dir, ".sequelizerc") || isDir(path.join(dir, "migrations")))) {
    found = { tool: "Sequelize", command: "npx sequelize-cli db:migrate", print: folderPrint(path.join(dir, "migrations")) };
  } else if (exists(dir, "manage.py")) {
    const venv = [".venv", "venv"].find((v) => isDir(path.join(dir, v)));
    const python = venv ? `"${venvBin(dir, venv, "python")}"` : process.platform === "win32" ? "python" : "python3";
    const apps = safeReaddir(dir).filter((e) => e.isDirectory() && isDir(path.join(dir, e.name, "migrations")));
    found = { tool: "Django", command: `${python} manage.py migrate --noinput`, print: hash(apps.map((a) => folderPrint(path.join(dir, a.name, "migrations"))).join(",")) };
  } else if (exists(dir, "bin/rails") && isDir(path.join(dir, "db", "migrate"))) {
    found = { tool: "Rails", command: process.platform === "win32" ? "ruby bin/rails db:migrate" : "bin/rails db:migrate", print: folderPrint(path.join(dir, "db", "migrate")) };
  } else if (exists(dir, "artisan") && isDir(path.join(dir, "database", "migrations"))) {
    found = { tool: "Laravel", command: "php artisan migrate --force", print: folderPrint(path.join(dir, "database", "migrations")), needs: "php" };
  } else if (exists(dir, "alembic.ini")) {
    const venv = [".venv", "venv"].find((v) => isDir(path.join(dir, v)));
    found = { tool: "Alembic", command: venv ? `"${venvBin(dir, venv, "alembic")}" upgrade head` : "alembic upgrade head", print: folderPrint(path.join(dir, "alembic", "versions")) ?? folderPrint(path.join(dir, "migrations", "versions")) };
  }
  if (!found) return;

  const db = databaseUrl(dir);
  const local = db === undefined || isLocalDatabase(db);
  if (!local) {
    add({ id: "migrate", title: `Apply database migrations (${found.tool})`, why: `the database in .env is at ${hostOf(db!)}, not on this computer, so dx leaves it alone`, phase: "db", blocking: false, status: "skip", fix: `Run ${found.command} yourself if you mean to migrate that database` });
    return;
  }
  // Without a migrations folder to watch, the project's commit stands in: a pull runs them again.
  const print = found.print ?? (gitHead(dir) ? `head:${gitHead(dir)}:${hash(found.command)}` : undefined);
  add({
    id: "migrate",
    title: `Apply database migrations (${found.tool})`,
    why: found.print ? "new or changed migrations since the last run" : print ? "the project changed since the last run" : "to bring the database up to date",
    // In a stack with Docker databases, after they're up; otherwise before the server starts.
    phase: stackHasDocker ? "db" : "before",
    action: "shell",
    command: found.command,
    needs: found.needs,
    cwd: dir,
    blocking: true,
    fix: "Check the database is running and .env points at it (DATABASE_URL), then Run again",
    fingerprint: print ? { key: "migrate", value: print } : undefined,
    doneWhy: "applied, and nothing new since",
    timeoutMs: 300_000,
  });
}

/** The project's database address, from .env and its relatives (DATABASE_URL and the usual names). */
export function databaseUrl(dir: string): string | undefined {
  const env: Record<string, string> = {};
  for (const f of [".env", ".env.local", ".env.development", ".env.development.local"]) for (const [k, v] of parseDotenv(readText(path.join(dir, f)) ?? "")) env[k] = v;
  const url = ["DATABASE_URL", "DB_URL", "POSTGRES_URL", "MYSQL_URL", "MONGODB_URI", "MONGO_URL", "PRISMA_DATABASE_URL"].map((k) => env[k]).find(Boolean);
  if (url) return url;
  const host = ["DB_HOST", "DATABASE_HOST", "POSTGRES_HOST", "PGHOST", "MYSQL_HOST"].map((k) => env[k]).find(Boolean);
  return host ? `db://${host}` : undefined;
}

/** On this computer: localhost, a Docker service name, SQLite, or a file. */
export function isLocalDatabase(url: string): boolean {
  if (/^(file:|sqlite)/i.test(url) || !url.includes("://")) return true;
  const host = hostOf(url).toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "0.0.0.0" || host === "host.docker.internal" || !host.includes(".");
}

function hostOf(url: string): string {
  try {
    return new URL(url.replace(/^([a-z+]+):\/\//i, "http://")).hostname;
  } catch {
    return /@([^:/?]+)/.exec(url)?.[1] ?? url;
  }
}

// ------------------------------------------------------------------ running them

export interface PrepareStepResult {
  ok: boolean;
  /** Last lines of output, for the failure message. */
  tail?: string;
  message?: string;
}

/** Runs one step: its command (output line by line to `log`), or its check. */
export async function runStep(step: PrepareStep, dir: string, log: (line: string) => void): Promise<PrepareStepResult> {
  if (step.action === "env") {
    const made = ensureEnvFile(dir);
    return made ? { ok: true, message: `Created ${path.basename(made)}` } : { ok: true, message: ".env was already there" };
  }
  if (step.action === "docker") {
    const ok = await quiet("docker", ["info", "--format", "{{.ServerVersion}}"], 15_000);
    return ok ? { ok: true } : { ok: false, message: (await commandExists("docker")) ? "Docker isn't running" : "Docker isn't installed" };
  }
  if (step.action === "port") {
    const port = Number(/Port (\d+)/.exec(step.title)?.[1]);
    const holders = await listListeningPorts(port).catch(() => []);
    if (!holders.length) return { ok: true };
    const who = holders.map((h) => `${h.processName ?? "a process"} (PID ${h.pid})`).join(", ");
    return { ok: false, message: `${who} is already listening on ${port}: the dev server may fail or move to another port. Stop it on the Ports page if it's an old one.` };
  }
  if (step.action !== "shell" || !step.command) return { ok: true };
  if (step.needs && !(await commandExists(step.needs))) return { ok: false, message: `${step.needs} isn't installed` };
  log(`$ ${step.command}`);
  const r = await runShell(step.command, step.cwd ?? dir, log, step.timeoutMs ?? 300_000);
  return r.ok ? { ok: true } : { ok: false, tail: r.tail, message: r.timedOut ? "it took too long and was stopped" : `it exited with ${r.code}` };
}

/** Runs the steps of one phase in order; a blocking step that fails stops the rest. */
export async function runPrepare(
  steps: PrepareStep[],
  dir: string,
  phase: "before" | "db",
  hooks: { log: (line: string) => void; changed?: (steps: PrepareStep[]) => void },
): Promise<{ ok: boolean; failed?: PrepareStep }> {
  for (const step of steps) {
    if (step.phase !== phase || (step.status !== "todo" && !(step.action === "docker" || step.action === "port"))) continue;
    if (step.status === "ok" && step.action !== "docker" && step.action !== "port") continue;
    step.status = "running";
    hooks.changed?.(steps);
    hooks.log(`▸ ${step.title} — ${step.why}`);
    const r = await runStep(step, dir, hooks.log);
    if (r.ok) {
      step.status = "done";
      if (r.message) step.why = r.message;
      if (step.fingerprint) remember(dir, step.fingerprint.key, step.fingerprint.value);
      hooks.log(`✓ ${step.title}`);
    } else {
      step.status = step.blocking ? "failed" : "warn";
      step.why = r.message ?? step.why;
      step.output = telling(r.tail);
      hooks.log(`${step.blocking ? "✗" : "!"} ${step.title}: ${r.message ?? "failed"}${step.fix && step.blocking ? `. ${step.fix}` : ""}`);
      if (step.blocking) {
        hooks.changed?.(steps);
        return { ok: false, failed: step };
      }
    }
    hooks.changed?.(steps);
  }
  return { ok: true };
}

/** The output line that says what went wrong: the last one that looks like an error, else the last line. */
export function telling(tail: string | undefined): string | undefined {
  const lines = (tail ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(npm (ERR!|error) (A complete log|code|path|command|cwd|errno)|at )/.test(l));
  const line = [...lines].reverse().find((l) => /\b(error|failed|cannot|can't|not found|refused|denied|missing|ENOENT|EADDRINUSE)\b/i.test(l)) ?? lines.at(-1);
  return line ? line.slice(0, 300) : undefined;
}

/** Whether anything in this phase needs doing (or checking). */
export function hasWork(steps: PrepareStep[], phase: "before" | "db"): boolean {
  return steps.some((s) => s.phase === phase && (s.status === "todo" || s.action === "docker" || s.action === "port"));
}

function runShell(command: string, cwd: string, log: (line: string) => void, timeoutMs: number): Promise<{ ok: boolean; code: number | null; tail: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // The command is dx's own (package managers, migration tools) or the project's .devrc.json: never from a request.
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", CI: process.env.CI ?? "", npm_config_yes: "true" } });
    const tail: string[] = [];
    let partial = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const onData = (b: Buffer) => {
      const lines = (partial + b.toString("utf8")).split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        log(l);
        tail.push(l);
        if (tail.length > 12) tail.shift();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, tail: err.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (partial.trim()) log(partial);
      resolve({ ok: code === 0 && !timedOut, code, tail: tail.join("\n"), timedOut });
    });
  });
}

function quiet(cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: "ignore" });
    const t = setTimeout(() => (child.kill(), resolve(false)), timeoutMs);
    child.on("error", () => (clearTimeout(t), resolve(false)));
    child.on("close", (code) => (clearTimeout(t), resolve(code === 0)));
  });
}

// ------------------------------------------------------------------ small helpers

function exists(dir: string, f: string): boolean {
  return fs.existsSync(path.join(dir, f));
}
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function safeReaddir(d: string): fs.Dirent[] {
  try {
    return fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return [];
  }
}
function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
function readText(f: string): string | undefined {
  try {
    return stripBom(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
}
function readJson<T>(f: string): T | undefined {
  const t = readText(f);
  if (!t) return undefined;
  try {
    return JSON.parse(t) as T;
  } catch {
    return undefined;
  }
}
function lower(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
/** The commit checked out, read from .git (a worktree's .git file included), without running git. */
function gitHead(dir: string): string | undefined {
  let gitDir = path.join(dir, ".git");
  try {
    if (fs.statSync(gitDir).isFile()) gitDir = path.resolve(dir, /gitdir:\s*(.+)/.exec(fs.readFileSync(gitDir, "utf8"))?.[1]?.trim() ?? "");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return head.slice(0, 40);
    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim().slice(0, 40);
    const packed = readText(path.join(gitDir, "packed-refs")) ?? "";
    return new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(packed)?.[1];
  } catch {
    return undefined;
  }
}

function detectPm(dir: string): PackageManager {
  if (exists(dir, "pnpm-lock.yaml")) return "pnpm";
  if (exists(dir, "yarn.lock")) return "yarn";
  if (exists(dir, "bun.lockb") || exists(dir, "bun.lock")) return "bun";
  return "npm";
}
function venvBin(dir: string, venv: string, name: string): string {
  return process.platform === "win32" ? path.join(dir, venv, "Scripts", `${name}.exe`) : path.join(dir, venv, "bin", name);
}
function prismaSchema(dir: string): string | undefined {
  const pkg = readJson<{ prisma?: { schema?: string } }>(path.join(dir, "package.json"));
  const candidates = [pkg?.prisma?.schema, "prisma/schema.prisma", "schema.prisma"].filter((x): x is string => !!x);
  for (const c of candidates) {
    const full = path.resolve(dir, c);
    if (full.startsWith(path.resolve(dir)) && fs.existsSync(full)) return full;
  }
  // Prisma's folder form: prisma/schema/*.prisma.
  return isDir(path.join(dir, "prisma", "schema")) ? path.join(dir, "prisma", "schema") : undefined;
}
function pnpmWorkspaces(dir: string): string[] {
  const t = readText(path.join(dir, "pnpm-workspace.yaml"));
  if (!t) return [];
  return [...t.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1]);
}
function expandWorkspaces(dir: string, patterns: string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    if (p.startsWith("!")) continue;
    const clean = p.replace(/\/\*\*?$/, "").replace(/\\/g, "/");
    if (p.endsWith("*")) {
      for (const e of safeReaddir(path.join(dir, clean))) if (e.isDirectory()) out.push(path.join(dir, clean, e.name));
    } else out.push(path.join(dir, clean));
  }
  return out.filter((d) => exists(d, "package.json"));
}
