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
}

export function defaultConfig(): DxConfig {
  return {
    projectsRoots: [path.join(os.homedir(), "Desktop", "projects")],
    editor: "code",
    scanDepth: 2,
    ignore: ["node_modules", "dist", "build", "out", "vendor", "target", "bin", "obj"],
    devServerTimeout: 90,
  };
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
    fs.writeFileSync(file, JSON.stringify(defaults, null, 2) + "\n", "utf8");
    return defaults;
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
