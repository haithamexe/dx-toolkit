import fs from "node:fs";
import path from "node:path";
import { stripBom } from "../config.js";
import { detectPackageManager, guessDevUrl, readProject, type Project } from "./projects.js";

/**
 * A stack is the set of processes an app needs to run locally: a front end, an API, a worker, a
 * database. dx finds it from what the project already has, in this order:
 *
 *   1. "stack" in .devrc.json, written by you or by your AI agent (set_stack);
 *   2. Procfile.dev or Procfile;
 *   3. a root "dev" script that runs turbo, nx, concurrently, npm-run-all or lerna: that one
 *      command, its output split back into services by the prefixes those tools print;
 *   4. root scripts named dev:web, dev:api, …;
 *   5. workspaces (npm, yarn or pnpm) whose packages have a "dev" script;
 *   6. docker-compose.yml services that are infrastructure (postgres, redis, …), added to any
 *      of the above and started first with `docker compose up -d`.
 *
 * A project with only one thing to run has no stack; it runs as before.
 */

export type ServiceRole = "data" | "backend" | "frontend" | "other";

export interface StackService {
  /** Short name, unique in the stack: web, api, postgres. Lowercase letters, digits and dashes. */
  name: string;
  role: ServiceRole;
  /** "process" runs `command` in `dir`; "docker" is a docker compose service. */
  kind: "process" | "docker";
  dir: string;
  command: string;
  /** Where it will listen, when known or guessed. */
  url?: string;
  /** Services that must be ready before this one starts. */
  dependsOn: string[];
  /** Extra environment, e.g. PORT for Procfile services. */
  env?: Record<string, string>;
  /** For docker services: the compose service name, and the host port it publishes. */
  composeService?: string;
  hostPort?: number;
}

export interface Stack {
  source: "devrc" | "procfile" | "runner" | "scripts" | "workspaces" | "compose";
  /** The project folder the stack belongs to. */
  dir: string;
  services: StackService[];
  /**
   * For "runner" stacks: the one command that starts every app service. Its output lines carry a
   * prefix naming the service ("web:dev: …" from turbo, "[api] …" from concurrently).
   */
  runner?: { command: string };
  /** The compose file docker services come from. */
  composeFile?: string;
}

/** What .devrc.json's "stack" may hold, per service name. */
export interface DevRcService {
  /** Command to run. */
  dev?: string;
  /** Folder to run it in, relative to the project (may be outside it, e.g. ../shop-api). */
  dir?: string;
  /** Another project dx knows, by folder (relative or absolute): its own dev command and URL are used. */
  project?: string;
  url?: string;
  dependsOn?: string[];
  /** A docker compose service of this project to start. */
  docker?: string;
  role?: ServiceRole;
}

const RUNNER = /\b(turbo|nx|concurrently|npm-run-all|run-p|lerna)\b|pnpm\b[^&|]*\s(-r|--recursive|--parallel|--filter)\b|\b(npm|yarn)\b[^&|]*\s--(workspaces|ws)\b|\byarn workspaces foreach\b/;
const DATA_IMAGES =
  /\b(postgres|postgis|mysql|mariadb|mongo|redis|valkey|keydb|rabbitmq|kafka|zookeeper|elasticsearch|opensearch|minio|mailhog|mailpit|localstack|memcached|nats|clickhouse|meilisearch|typesense|azurite|dynamodb|neo4j|cassandra|couchdb|influxdb|qdrant|weaviate|supabase|surrealdb|adminer|pgadmin)\b/i;

export function detectStack(project: Project): Stack | undefined {
  const dir = project.dir;
  const devrc = readJson<{ stack?: Record<string, DevRcService> }>(path.join(dir, ".devrc.json"));
  const compose = readCompose(dir);
  const infra = compose ? dockerServices(compose.file, compose.services) : [];

  let stack: Stack | undefined;
  if (devrc?.stack && typeof devrc.stack === "object") {
    stack = fromDevrc(project, devrc.stack, compose);
  } else {
    stack = fromProcfile(dir) ?? fromRunner(project) ?? fromDevScripts(project) ?? fromWorkspaces(project);
    if (stack && infra.length) {
      stack.services.unshift(...infra);
      stack.composeFile = compose?.file;
    } else if (!stack && infra.length && project.devCommand) {
      // One app plus its database: still a stack.
      stack = {
        source: "compose",
        dir,
        composeFile: compose?.file,
        services: [...infra, { name: "app", role: "frontend", kind: "process", dir, command: project.devCommand, url: project.url, dependsOn: [] }],
      };
    }
  }
  if (!stack) return undefined;
  const appServices = stack.services.filter((s) => s.kind === "process").length;
  if (stack.source !== "devrc" && stack.services.length < 2 && !(stack.runner && appServices >= 2)) return undefined;
  orderDependencies(stack);
  return stack;
}

// ------------------------------------------------------------ sources

function fromDevrc(project: Project, spec: Record<string, DevRcService>, compose?: Compose): Stack | undefined {
  const services: StackService[] = [];
  for (const [rawName, s] of Object.entries(spec)) {
    if (!s || typeof s !== "object") continue;
    const name = serviceName(rawName);
    if (s.docker) {
      const c = compose?.services.find((x) => x.name === s.docker);
      services.push({
        name,
        role: s.role ?? "data",
        kind: "docker",
        dir: project.dir,
        command: `docker compose up -d ${s.docker}`,
        composeService: s.docker,
        hostPort: c?.hostPort,
        url: c?.hostPort ? `http://localhost:${c.hostPort}` : undefined,
        dependsOn: (s.dependsOn ?? []).map(serviceName),
      });
      continue;
    }
    let dir = s.dir ? path.resolve(project.dir, s.dir) : project.dir;
    let command = s.dev;
    let url = s.url;
    if (s.project) {
      const other = readProject(path.resolve(project.dir, s.project));
      if (other) {
        dir = other.dir;
        command ??= other.devCommand;
        url ??= other.url;
      }
    }
    if (!command) continue;
    services.push({ name, role: s.role ?? roleOf(name, command), kind: "process", dir, command, url, dependsOn: (s.dependsOn ?? []).map(serviceName) });
  }
  if (!services.length) return undefined;
  return { source: "devrc", dir: project.dir, services, composeFile: compose?.file };
}

/** Procfile lines: `web: bin/rails server -p $PORT`. Ports are handed out like foreman does: 5000, 5100, … */
function fromProcfile(dir: string): Stack | undefined {
  const file = ["Procfile.dev", "Procfile"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!file) return undefined;
  const services: StackService[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(line.trim());
    if (!m || line.trim().startsWith("#")) continue;
    const port = 5000 + services.length * 100;
    const name = serviceName(m[1]);
    const usesPort = /\$\{?PORT\b/.test(m[2]);
    services.push({
      name,
      role: roleOf(name, m[2]),
      kind: "process",
      dir,
      command: m[2],
      env: { PORT: String(port) },
      url: usesPort ? `http://localhost:${port}` : guessDevUrl(m[2]),
      dependsOn: [],
    });
  }
  return services.length >= 2 ? { source: "procfile", dir, services } : undefined;
}

/** A root dev script that runs every workspace at once: keep it, and split its output by service. */
function fromRunner(project: Project): Stack | undefined {
  const pkg = readJson<PackageJson>(path.join(project.dir, "package.json"));
  const dev = pkg?.scripts?.dev;
  if (!dev || !RUNNER.test(dev)) return undefined;
  const pm = detectPackageManager(project.dir, pkg);
  const workspaces = workspacePackages(project.dir, pkg).filter((w) => w.scripts.dev);
  const scripts = Object.entries(pkg?.scripts ?? {}).filter(([k]) => /^dev:./.test(k));
  const names =
    workspaces.length > 0
      ? workspaces.map((w) => ({ name: serviceName(w.folder), command: w.scripts.dev!, dir: w.dir, label: w.name }))
      : scripts.map(([k, v]) => ({ name: serviceName(k.slice(4)), command: v, dir: project.dir, label: k }));
  return {
    source: "runner",
    dir: project.dir,
    runner: { command: `${pm} run dev` },
    services: names.map((n) => ({
      name: n.name,
      role: roleOf(n.name, n.command),
      kind: "process",
      dir: n.dir,
      command: n.command,
      url: guessDevUrl(n.command),
      dependsOn: [],
      // The runner prints the package name or script name; remember it to match output prefixes.
      env: { DX_LABEL: n.label },
    })),
  };
}

/** Root scripts dev:web, dev:api, … run as separate services. */
function fromDevScripts(project: Project): Stack | undefined {
  const pkg = readJson<PackageJson>(path.join(project.dir, "package.json"));
  const scripts = Object.entries(pkg?.scripts ?? {}).filter(([k]) => /^dev:[\w-]+$/.test(k));
  if (scripts.length < 2) return undefined;
  const pm = detectPackageManager(project.dir, pkg);
  return {
    source: "scripts",
    dir: project.dir,
    services: scripts.map(([k, v]) => {
      const name = serviceName(k.slice(4));
      return { name, role: roleOf(name, v), kind: "process" as const, dir: project.dir, command: `${pm} run ${k}`, url: guessDevUrl(v), dependsOn: [] };
    }),
  };
}

function fromWorkspaces(project: Project): Stack | undefined {
  const pkg = readJson<PackageJson>(path.join(project.dir, "package.json"));
  const pm = detectPackageManager(project.dir, pkg);
  const services = workspacePackages(project.dir, pkg)
    .filter((w) => w.scripts.dev)
    .map((w) => {
      const name = serviceName(w.folder);
      return { name, role: roleOf(name, w.scripts.dev!), kind: "process" as const, dir: w.dir, command: `${pm} run dev`, url: guessDevUrl(w.scripts.dev!), dependsOn: [] };
    });
  return services.length >= 2 ? { source: "workspaces", dir: project.dir, services } : undefined;
}

function dockerServices(file: string, services: ComposeService[]): StackService[] {
  return services
    .filter((s) => !s.build && s.image && DATA_IMAGES.test(s.image))
    .map((s) => ({
      name: serviceName(s.name),
      role: "data" as const,
      kind: "docker" as const,
      dir: path.dirname(file),
      command: `docker compose up -d ${s.name}`,
      composeService: s.name,
      hostPort: s.hostPort,
      url: s.hostPort ? `http://localhost:${s.hostPort}` : undefined,
      dependsOn: [],
    }));
}

// ------------------------------------------------------------ order

const TIER: Record<ServiceRole, number> = { data: 0, backend: 1, other: 2, frontend: 3 };

/** Guesses what a service is from its name and command. */
export function roleOf(name: string, command = ""): ServiceRole {
  const n = name.toLowerCase();
  if (/^(db|database|postgres|mysql|redis|mongo|cache|queue)$/.test(n)) return "data";
  if (/(^|[-_])(api|server|backend|gateway|graphql|functions?|worker|jobs?|queue)([-_]|$)/.test(n)) return "backend";
  if (/(^|[-_])(web|app|client|frontend|site|ui|admin|dashboard|www|docs|storybook|landing|portal)([-_]|$)/.test(n)) return "frontend";
  if (/\b(vite|next|nuxt|astro|remix|svelte-kit|ng serve|gatsby|expo|webpack)\b/.test(command)) return "frontend";
  if (/\b(nodemon|tsx watch|ts-node|uvicorn|gunicorn|flask|rails s|go run|cargo run|nest start|fastify|express)\b/.test(command)) return "backend";
  return "other";
}

/**
 * Turns roles into dependencies, when the stack didn't name its own: data services first, then
 * back ends, then anything else, then front ends. Services in one tier start together.
 */
function orderDependencies(stack: Stack): void {
  if (stack.services.some((s) => s.dependsOn.length)) return;
  for (const s of stack.services) {
    const below = stack.services.filter((o) => TIER[o.role] < TIER[s.role]);
    const nearest = Math.max(-1, ...below.map((o) => TIER[o.role]));
    s.dependsOn = below.filter((o) => TIER[o.role] === nearest).map((o) => o.name);
  }
}

/** Groups services into the order they start in: each group only after the one before is ready. */
export function startOrder(stack: Stack): StackService[][] {
  const done = new Set<string>();
  const names = new Set(stack.services.map((s) => s.name));
  const left = [...stack.services];
  const waves: StackService[][] = [];
  while (left.length) {
    const wave = left.filter((s) => s.dependsOn.every((d) => done.has(d) || !names.has(d)));
    // A dependency loop: start the rest together rather than never.
    const now = wave.length ? wave : [...left];
    waves.push(now);
    for (const s of now) {
      done.add(s.name);
      left.splice(left.indexOf(s), 1);
    }
  }
  return waves;
}

/** The service a browser should open: the first front end, else the first app service. */
export function mainService(stack: Stack): StackService | undefined {
  return stack.services.find((s) => s.role === "frontend" && s.kind === "process") ?? stack.services.find((s) => s.kind === "process");
}

/** "@acme/Web App" → "web-app" */
export function serviceName(raw: string): string {
  return (
    raw
      .replace(/^@[^/]+\//, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "service"
  );
}

/**
 * Which service a line from a runner belongs to, and the line without its prefix.
 * turbo: "web:dev: ready" or "@acme/web:dev: ready"; concurrently and npm-run-all: "[api] listening".
 */
export function splitRunnerLine(text: string, services: StackService[]): { service?: string; text: string } {
  const m = /^(?:\x1b\[[0-9;]*m)*([@\w./-]+):[\w:-]+: ?(.*)$/.exec(text) ?? /^(?:\x1b\[[0-9;]*m)*\[([^\]]+)\] ?(.*)$/.exec(text);
  if (!m) return { text };
  const label = m[1];
  const service =
    services.find((s) => s.env?.DX_LABEL === label || s.name === serviceName(label) || s.env?.DX_LABEL === `dev:${label}`)?.name ?? serviceName(label);
  return { service, text: m[2] };
}

/**
 * Writes (or with no services, removes) the "stack" in a project's .devrc.json, keeping the rest
 * of the file. This is how an AI agent sets up a stack dx can't guess, such as two repositories.
 */
export function saveStackSpec(dir: string, spec: Record<string, DevRcService> | undefined): string {
  const file = path.join(dir, ".devrc.json");
  const current = readJson<Record<string, unknown>>(file) ?? {};
  if (spec && Object.keys(spec).length) current.stack = spec;
  else delete current.stack;
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\n", "utf8");
  return file;
}

// ------------------------------------------------------------ files

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

interface Workspace {
  dir: string;
  folder: string;
  name: string;
  scripts: Record<string, string>;
}

/** The packages listed in package.json "workspaces" or pnpm-workspace.yaml. Patterns: "apps/*", "packages/**", or a folder. */
export function workspacePackages(dir: string, pkg = readJson<PackageJson>(path.join(dir, "package.json"))): Workspace[] {
  let patterns: string[] = [];
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) patterns = ws;
  else if (ws && Array.isArray(ws.packages)) patterns = ws.packages;
  const pnpm = path.join(dir, "pnpm-workspace.yaml");
  if (!patterns.length && fs.existsSync(pnpm)) {
    let inPackages = false;
    for (const line of fs.readFileSync(pnpm, "utf8").split(/\r?\n/)) {
      if (/^packages:\s*$/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
        if (m) patterns.push(m[1]);
      }
    }
  }
  const out: Workspace[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue;
    const base = pattern.replace(/\/\*\*?$/, "");
    const dirs = /\/\*\*?$/.test(pattern) ? subdirs(path.join(dir, base)) : [path.join(dir, pattern)];
    for (const d of dirs) {
      const p = readJson<PackageJson>(path.join(d, "package.json"));
      if (!p || seen.has(d)) continue;
      seen.add(d);
      out.push({ dir: d, folder: path.basename(d), name: p.name ?? path.basename(d), scripts: p.scripts ?? {} });
    }
  }
  return out;
}

interface ComposeService {
  name: string;
  image?: string;
  build?: boolean;
  hostPort?: number;
}
interface Compose {
  file: string;
  services: ComposeService[];
}

/**
 * Reads the services of a compose file: just enough YAML for names, image, build and the first
 * published port. Anything it can't read is skipped, never guessed.
 */
export function readCompose(dir: string): Compose | undefined {
  const file = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!file) return undefined;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const services: ComposeService[] = [];
  let inServices = false;
  let serviceIndent = -1;
  let current: ComposeService | undefined;
  let inPorts = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inServices = /^services:\s*$/.test(line);
      current = undefined;
      serviceIndent = -1;
      continue;
    }
    if (!inServices) continue;
    if (serviceIndent === -1) serviceIndent = indent;
    if (indent === serviceIndent) {
      const m = /^\s*([\w.-]+):\s*$/.exec(line);
      current = m ? { name: m[1] } : undefined;
      if (current) services.push(current);
      inPorts = false;
      continue;
    }
    if (!current) continue;
    const kv = /^\s*([\w-]+):\s*(.*)$/.exec(line);
    if (kv && indent === serviceIndent + 2) {
      inPorts = kv[1] === "ports";
      if (kv[1] === "image") current.image = kv[2].replace(/^['"]|['"]$/g, "");
      if (kv[1] === "build") current.build = true;
      if (kv[1] === "ports" && kv[2].startsWith("[")) current.hostPort ??= hostPortOf(kv[2].slice(1).split(",")[0]);
      continue;
    }
    if (inPorts && /^\s*-\s*/.test(line)) current.hostPort ??= hostPortOf(line.replace(/^\s*-\s*/, ""));
  }
  return { file, services };
}

/** "5432:5432", "127.0.0.1:6379:6379", "8080:80/tcp" → the host port. */
function hostPortOf(spec: string): number | undefined {
  const parts = spec.trim().replace(/^['"]|['"]$/g, "").replace(/\/\w+$/, "").split(":");
  if (parts.length < 2) return undefined;
  const n = Number(parts[parts.length - 2]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8"))) as T;
  } catch {
    return undefined;
  }
}
