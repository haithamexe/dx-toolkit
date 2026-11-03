import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dxPath, expandHome, loadConfig, stripBom, type DxConfig } from "../config.js";
import { findProjects, scanProjects } from "./projects.js";

/**
 * `dx new`: start a project from a template folder (~/.dx/templates/<name>) or from a copy of an
 * existing project. Copies leave out what belongs to the old project: git history, installed
 * packages, build output and .env files with secrets (.env.example is kept).
 */
export interface Template {
  name: string;
  dir: string;
}

export type SourceKind = "template" | "project" | "folder";

export interface Source {
  kind: SourceKind;
  name: string;
  dir: string;
}

/** Folders and files never copied. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".cache",
  ".vercel",
  ".output",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
]);
const SKIP_FILES = /^(\.env(\..+)?|.*\.log|\.DS_Store|Thumbs\.db|.*\.tsbuildinfo)$/i;
const KEEP_FILES = /^\.env\.(example|sample|template)$/i;
/** Placeholder replaced with the new project's name in template files and file names. */
export const NAME_PLACEHOLDER = "{{name}}";
const MAX_TEXT_BYTES = 1024 * 1024;

export function templatesDir(config: DxConfig = loadConfig()): string {
  return config.templatesDir ? expandHome(config.templatesDir) : dxPath("templates");
}

export function listTemplates(config: DxConfig = loadConfig()): Template[] {
  const dir = templatesDir(config);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, dir: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** A template by exact name, else a folder path, else a project with a clear name match. */
export function resolveSource(input: string, config: DxConfig = loadConfig()): Source | { candidates: string[] } {
  const template = listTemplates(config).find((t) => t.name.toLowerCase() === input.toLowerCase());
  if (template) return { kind: "template", ...template };
  const asPath = path.resolve(expandHome(input));
  if (/[\\/]/.test(input) && isDir(asPath)) return { kind: "folder", name: path.basename(asPath), dir: asPath };
  const { match, candidates } = findProjects(input, scanProjects(config));
  if (match) return { kind: "project", name: match.name, dir: match.dir };
  return { candidates: candidates.slice(0, 8).map((p) => p.name) };
}

/** Lowercase letters, digits, dots, dashes and underscores: valid as a folder and an npm package name. */
export function isValidProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,213}$/.test(name);
}

export interface CopyResult {
  dir: string;
  files: number;
  /** Files whose {{name}} placeholder was filled in. */
  filled: number;
}

/**
 * Copies `source` to `dest` (which must not exist yet) and gives the copy its new name:
 * package.json and .devrc.json get `name`, and template files get {{name}} filled in.
 */
export function copyProject(source: Source, dest: string, name: string): CopyResult {
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists.`);
  const destParent = path.dirname(dest);
  const rel = path.relative(source.dir, dest);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error("The new project can't be inside the one it's copied from.");
  fs.mkdirSync(destParent, { recursive: true });

  const fill = source.kind === "template";
  let files = 0;
  let filled = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of filesToCopy(source.dir)) {
    const parts = rel.split("/");
    if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) continue;
    const base = parts[parts.length - 1];
    if (SKIP_FILES.test(base) && !KEEP_FILES.test(base)) continue;
    const src = path.join(source.dir, ...parts);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(src);
    } catch {
      continue; // listed by git but deleted on disk
    }
    if (!stat.isFile()) continue; // symlinks are left out rather than pointing back into the source
    const dst = path.join(dest, ...(fill ? parts.map((p) => p.split(NAME_PLACEHOLDER).join(name)) : parts));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fill && fillPlaceholder(src, dst, name)) filled++;
    else fs.copyFileSync(src, dst);
    files++;
  }
  renameManifest(path.join(dest, "package.json"), name);
  renameManifest(path.join(dest, ".devrc.json"), name, true);
  return { dir: dest, files, filled };
}

/**
 * The files that make up a project, as "/"-separated paths. In a git repo that's what git tracks
 * plus new files it doesn't ignore, so local reports, uploads and caches stay behind. Elsewhere,
 * every file except the skipped folders.
 */
function filesToCopy(dir: string): string[] {
  if (fs.existsSync(path.join(dir, ".git"))) {
    try {
      const out = execFileSync("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        windowsHide: true,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return [...new Set(out.toString("utf8").split("\0").filter(Boolean))];
    } catch {
      // git not available: fall back to walking the folder
    }
  }
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(abs, e.name), childRel);
      } else if (e.isFile()) out.push(childRel);
    }
  };
  walk(dir, "");
  return out;
}

/** Writes a copy of a text file with {{name}} replaced. False when it isn't text or has no placeholder. */
function fillPlaceholder(src: string, dst: string, name: string): boolean {
  if (fs.statSync(src).size > MAX_TEXT_BYTES) return false;
  const buf = fs.readFileSync(src);
  if (buf.includes(0)) return false; // binary
  const text = buf.toString("utf8");
  if (!text.includes(NAME_PLACEHOLDER)) return false;
  fs.writeFileSync(dst, text.split(NAME_PLACEHOLDER).join(name), "utf8");
  return true;
}

/** Sets "name" in a JSON manifest, keeping its formatting style (2-space or tab). */
function renameManifest(file: string, name: string, onlyIfSet = false): void {
  if (!fs.existsSync(file)) return;
  try {
    const text = stripBom(fs.readFileSync(file, "utf8"));
    const json = JSON.parse(text) as Record<string, unknown>;
    if (onlyIfSet && json.name === undefined) return;
    json.name = name;
    const indent = /^\t/m.test(text) ? "\t" : 2;
    fs.writeFileSync(file, JSON.stringify(json, null, indent) + (text.endsWith("\n") ? "\n" : ""), "utf8");
  } catch {
    // not valid JSON: leave it as copied
  }
}

/** Saves a copy of a project as a template, leaving out the same things a copy does. */
export function saveAsTemplate(source: Source, templateName: string, config: DxConfig = loadConfig()): CopyResult {
  if (!isValidProjectName(templateName)) throw new Error(`"${templateName}" isn't a valid template name (lowercase, digits, - _ .).`);
  return copyProject({ ...source, kind: "project" }, path.join(templatesDir(config), templateName), templateName);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
