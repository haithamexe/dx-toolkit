import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Everything dx stores lives in one folder: ~/.dx (override with the DX_HOME env var). */
export function dxHome(): string {
  return process.env.DX_HOME ?? path.join(os.homedir(), ".dx");
}

export function dxPath(...parts: string[]): string {
  return path.join(dxHome(), ...parts);
}

export interface DxConfig {
  /** Folders that hold your projects. Each is scanned `scanDepth` levels deep. */
  projectsRoots: string[];
  /** Command that opens a folder in your editor: "code", "cursor", or a full quoted path. */
  editor: string;
  /** How many folder levels below a root to look for projects (1 = direct children only). */
  scanDepth: number;
  /** Folder names never scanned (in addition to anything starting with "."). */
  ignore: string[];
  /** Seconds `dx go` waits for the dev server port before giving up on opening the browser. */
  devServerTimeout: number;
  /** Your GitHub username, for pull requests in `dx summary`. Guessed from your repos' remotes when unset. */
  githubUser?: string;
  /** Where `dx new` looks for templates (default ~/.dx/templates). */
  templatesDir?: string;
  /** Connect dx to newly installed AI tools automatically (default true). */
  autoConnectAi?: boolean;
  /** AI tools dx has already offered itself to, so one you disconnected stays disconnected. */
  aiToolsSeen?: string[];
  /** Serve running apps at name.localhost (default true). */
  localDomains?: boolean;
  /** Port for name.localhost; default 80, or 1355 when 80 is taken. */
  localDomainsPort?: number;
}

/** Folders people usually keep their code in, checked on first run. */
const COMMON_ROOTS = [
  "projects",
  "code",
  "dev",
  "Developer",
  "src",
  "repos",
  "workspace",
  "git",
  "GitHub",
  path.join("Documents", "GitHub"),
  path.join("Documents", "projects"),
  path.join("Documents", "code"),
  path.join("Desktop", "projects"),
  path.join("source", "repos"),
];
const COMMON_EDITORS = ["code", "cursor", "windsurf", "zed", "subl", "webstorm", "idea"];

/** The common code folders that exist on this computer. */
export function detectProjectRoots(home = os.homedir()): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const rel of COMMON_ROOTS) {
    const dir = path.join(home, rel);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const real = fs.realpathSync.native(dir);
      const id = process.platform === "linux" ? real : real.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(real);
    } catch {
      // not there
    }
  }
  return found;
}

/** The first editor command found on PATH, or "code". */
export function detectEditor(): string {
  for (const editor of COMMON_EDITORS) {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [editor], { windowsHide: true, stdio: "ignore" });
    if (r.status === 0) return editor;
  }
  return "code";
}

export function defaultConfig(): DxConfig {
  return {
    projectsRoots: [path.join(os.homedir(), "projects")],
    editor: "code",
    scanDepth: 2,
    ignore: ["node_modules", "dist", "build", "out", "vendor", "target", "bin", "obj"],
    devServerTimeout: 90,
  };
}

/** The config written on first run: the defaults, with code folders and editor found on this computer. */
export function firstRunConfig(): DxConfig {
  const config = defaultConfig();
  const roots = detectProjectRoots();
  if (roots.length) config.projectsRoots = roots;
  config.editor = detectEditor();
  return config;
}

export const CONFIG_FILE = "config.json";

export function configPath(): string {
  return dxPath(CONFIG_FILE);
}

export function ensureDxHome(): string {
  const home = dxHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Reads ~/.dx/config.json, creating it with defaults on first run.
 * Missing keys fall back to defaults, so old config files keep working as options are added.
 */
export function loadConfig(): DxConfig {
  const file = configPath();
  const defaults = defaultConfig();
  if (!fs.existsSync(file)) {
    ensureDxHome();
    const first = firstRunConfig();
    fs.writeFileSync(file, JSON.stringify(first, null, 2) + "\n", "utf8");
    return first;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (err) {
    throw new Error(`Your dx config isn't valid JSON: ${file}\n${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Your dx config should be a JSON object: ${file}`);
  }
  const merged = { ...defaults, ...(raw as Partial<DxConfig>) };
  if (!Array.isArray(merged.projectsRoots)) merged.projectsRoots = [String(merged.projectsRoots)];
  merged.projectsRoots = merged.projectsRoots.map(expandHome);
  return merged;
}

export function saveConfig(config: DxConfig): void {
  ensureDxHome();
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
