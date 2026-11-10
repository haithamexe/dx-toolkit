import fs from "node:fs";
import path from "node:path";
import { loadConfig, stripBom, type DxConfig } from "../config.js";
import { fuzzyRank } from "../fuzzy.js";
import { devCommandFromFiles } from "./runfiles.js";

export type ProjectKind = "node" | "go" | "rust" | "python" | "dotnet" | "other";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface Project {
  name: string;
  dir: string;
  /** Which projects root it was found under. */
  root: string;
  kind: ProjectKind;
  packageManager?: PackageManager;
  /** Command that starts the project locally, from .devrc.json or detected. */
  devCommand?: string;
  /** Where the dev server will be, from .devrc.json or guessed from the dev script. */
  url?: string;
  /** True when `url` was guessed from the framework rather than set in .devrc.json. */
  urlGuessed?: boolean;
  /** Editor override from .devrc.json. */
  editor?: string;
  scripts: string[];
  hasGit: boolean;
  /** Last time something happened in the project (ms since epoch). */
  lastActive: number;
}

/**
 * Optional per-project file, `.devrc.json` in the project folder:
 *   { "dev": "npm run dev -- --turbo", "url": "http://localhost:3000", "name": "shop", "editor": "cursor" }
 */
export interface DevRc {
  name?: string;
  dev?: string;
  url?: string;
  editor?: string;
}

const MARKERS: Array<[file: string, kind: ProjectKind]> = [
  ["package.json", "node"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["manage.py", "python"],
];

/** Files that make a folder a project without telling its language (Rails, a stack of containers, …). */
const OTHER_MARKERS = ["Gemfile", "Procfile", "Procfile.dev", "compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

export function scanProjects(config: DxConfig = loadConfig()): Project[] {
  const found = new Map<string, Project>();
  const ignore = new Set(config.ignore.map((n) => n.toLowerCase()));
  for (const root of config.projectsRoots) {
    if (!isDir(root)) continue;
    walk(root, root, 1);
  }
  return [...found.values()].sort((a, b) => b.lastActive - a.lastActive);

  function walk(dir: string, root: string, depth: number): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || ignore.has(entry.name.toLowerCase())) continue;
      const child = path.join(dir, entry.name);
      const project = readProject(child, root);
      if (project) {
        found.set(child.toLowerCase(), project);
      } else if (depth < config.scanDepth) {
        walk(child, root, depth + 1);
      }
    }
  }
}

// The dashboard asks "is this one of my projects?" on nearly every request, and a full scan walks the
// projects folders (about 17 ms for 22 projects). The list is kept a few seconds, per set of roots.
// A project that isn't in it makes a fresh scan, so one just made is found at once, and one that is
// in it is read again on its own, so its scripts and activity are never stale.
const SCAN_TTL_MS = 5000;
let scanned: { key: string; at: number; list: Project[] } | undefined;

const scanKey = (config: DxConfig) => JSON.stringify([config.projectsRoots, config.ignore, config.scanDepth]);

/** scanProjects, from the last scan when it's under five seconds old and the roots are the same. */
export function scanProjectsCached(config: DxConfig = loadConfig(), ttlMs = SCAN_TTL_MS): Project[] {
  const key = scanKey(config);
  if (scanned && scanned.key === key && Date.now() - scanned.at < ttlMs) return scanned.list;
  const list = scanProjects(config);
  scanned = { key, at: Date.now(), list };
  return list;
}

/** Forget the kept scan: a project was cloned or created, or the projects folders changed. */
export function invalidateProjectScan(): void {
  scanned = undefined;
}

/**
 * The project at `dir` if it's one dx finds (compared without regard to case), read fresh. Looks in
 * the kept scan first; a folder that isn't there is looked for with a new scan before it's refused.
 */
export function findKnownProject(dir: string, config: DxConfig = loadConfig()): Project | undefined {
  const wanted = dir.toLowerCase();
  const hit = scanProjectsCached(config).find((p) => p.dir.toLowerCase() === wanted);
  if (hit) {
    const fresh = readProject(hit.dir, hit.root);
    if (fresh) return fresh;
  }
  invalidateProjectScan();
  return scanProjectsCached(config).find((p) => p.dir.toLowerCase() === wanted);
}

/** Returns project info if `dir` looks like a project, otherwise undefined. */
export function readProject(dir: string, root = path.dirname(dir)): Project | undefined {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  const hasGit = has(".git");
  const devrc = readJson<DevRc>(path.join(dir, ".devrc.json"));
  let kind: ProjectKind | undefined = MARKERS.find(([f]) => has(f))?.[1];
  if (!kind && hasDotnetProject(dir)) kind = "dotnet";
  if (!kind && (hasGit || devrc || OTHER_MARKERS.some(has))) kind = "other";
  if (!kind) return undefined;

  const pkg = kind === "node" ? readJson<PackageJson>(path.join(dir, "package.json")) : undefined;
  const scripts = Object.keys(pkg?.scripts ?? {});
  const packageManager = kind === "node" ? detectPackageManager(dir, pkg) : undefined;

  let devCommand = devrc?.dev;
  let devScript: string | undefined;
  if (!devCommand) {
    if (kind === "node" && pkg?.scripts) {
      const script = ["dev", "start", "serve", "develop"].find((s) => pkg.scripts?.[s]);
      if (script) {
        devCommand = `${packageManager ?? "npm"} run ${script}`;
        devScript = pkg.scripts[script];
      }
    }
    // A task runner or the framework's own command, from the project's files.
    devCommand ??= devCommandFromFiles(dir);
    if (!devCommand && kind === "go") devCommand = "go run .";
    else if (!devCommand && kind === "rust") devCommand = "cargo run";
  }

  let url = devrc?.url;
  let urlGuessed = false;
  if (!url && devScript) {
    url = guessDevUrl(devScript);
    urlGuessed = Boolean(url);
  }

  return {
    name: devrc?.name ?? path.basename(dir),
    dir,
    root,
    kind,
    packageManager,
    devCommand,
    url,
    urlGuessed: url ? urlGuessed : undefined,
    editor: devrc?.editor,
    scripts,
    hasGit,
    lastActive: lastActivity(dir, hasGit),
  };
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  packageManager?: string;
}

export function detectPackageManager(dir: string, pkg?: PackageJson): PackageManager {
  const declared = pkg?.packageManager?.split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  return "npm";
}

/**
 * Best guess at the local URL from a dev script such as "next dev -p 3001" or "vite --port 5174".
 * Only used to open the browser once that port is actually listening, so a wrong guess is harmless.
 */
export function guessDevUrl(script: string): string | undefined {
  const explicit =
    /(?:^|\s)(?:-p|--port)(?:\s+|=)(\d{2,5})\b/.exec(script) ?? /\bPORT=(\d{2,5})\b/.exec(script);
  const port = explicit ? Number(explicit[1]) : frameworkDefaultPort(script);
  return port ? `http://localhost:${port}` : undefined;
}

function frameworkDefaultPort(script: string): number | undefined {
  const s = script.toLowerCase();
  if (/\bnext\b/.test(s) || /\bnuxt\b/.test(s) || /\bremix dev\b/.test(s)) return 3000;
  if (/\bvite\b/.test(s) || /react-router dev/.test(s) || /\bsvelte-kit dev\b/.test(s)) return 5173;
  if (/\bastro\b/.test(s)) return 4321;
  if (/\bng serve\b/.test(s)) return 4200;
  if (/\bgatsby develop\b/.test(s)) return 8000;
  if (/\bexpo start\b/.test(s)) return 8081;
  if (/webpack(-dev-server| serve)/.test(s)) return 8080;
  return undefined;
}

export function getProjectPort(project: Project): number | undefined {
  if (!project.url) return undefined;
  try {
    const u = new URL(project.url);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

export interface FindResult {
  /** Set when one project is a clear winner. */
  match?: Project;
  /** Ranked candidates (best first), for asking the user to pick. */
  candidates: Project[];
}

/** Fuzzy-find projects by name. An empty query returns the most recently active ones. */
export function findProjects(query: string, projects: Project[]): FindResult {
  const q = query.trim();
  if (!q) return { candidates: projects };
  const ranked = fuzzyRank(q, projects, (p) => [p.name, path.basename(p.dir)]);
  // On equal scores prefer the project touched most recently.
  ranked.sort((a, b) => b.score - a.score || b.item.lastActive - a.item.lastActive);
  const candidates = ranked.map((r) => r.item);
  if (ranked.length === 0) return { candidates };
  const [first, second] = ranked;
  const clear = ranked.length === 1 || first.score >= 1000 || first.score - (second?.score ?? 0) >= 150;
  return { match: clear ? first.item : undefined, candidates };
}

function lastActivity(dir: string, hasGit: boolean): number {
  const files = [dir, path.join(dir, "package.json")];
  if (hasGit) files.push(path.join(dir, ".git", "index"), path.join(dir, ".git", "HEAD"), path.join(dir, ".git", "FETCH_HEAD"));
  let latest = 0;
  for (const f of files) {
    try {
      latest = Math.max(latest, fs.statSync(f).mtimeMs);
    } catch {
      // file not present
    }
  }
  return latest;
}

function hasDotnetProject(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith(".sln") || f.endsWith(".csproj"));
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8"))) as T;
  } catch {
    return undefined;
  }
}
