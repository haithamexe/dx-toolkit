import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkEnv, EXAMPLE_FILES, parseDotenv, type SecretFinding } from "./envcheck.js";

/**
 * The Env page's view of a project: its .env files (wherever they are in the project), whether
 * git would commit any of them, and what the project's .gitignore is missing to keep secrets
 * out of the repository, following OWASP's secrets management guidance: environment files,
 * private keys, certificates and keystores never go into version control.
 */

export interface EnvFileInfo {
  /** Relative to the project, with forward slashes: ".env", "apps/web/.env.local". */
  name: string;
  /** .env.example and similar: meant to be committed, with no real values. */
  example: boolean;
  keys: number;
  bytes: number;
  /** git tracks it, so its values are in the repository's history. */
  tracked: boolean;
  /** A `git add .` would commit it: it exists, isn't tracked, and nothing ignores it. */
  notIgnored: boolean;
}

export interface GitignoreRule {
  /** What goes in .gitignore. */
  pattern: string;
  /** What it keeps out, in words. */
  why: string;
  /** Whether the project's own .gitignore already covers it. */
  covered: boolean;
}

export interface ProjectEnv {
  dir: string;
  git: boolean;
  /** The project has a .gitignore at its root. */
  gitignore: boolean;
  files: EnvFileInfo[];
  /** Every recommended rule, covered or not. */
  rules: GitignoreRule[];
  /** .env.example (or similar) is ignored, so the template isn't shared with the code. */
  exampleIgnored: boolean;
  /** Variables the example lists that no .env file sets, and those set but empty. */
  missingVars: string[];
  emptyVars: string[];
  /** Keys and tokens in tracked files (with `secrets: true`). */
  secrets: SecretFinding[];
  scanned: boolean;
  /** How many things need looking at: files git would commit or tracks, uncovered rules, keys found. */
  problems: number;
}

/** What a project's .gitignore should cover, and a path each rule is tested with. */
export const GITIGNORE_RULES: { pattern: string; why: string; test: string[] }[] = [
  { pattern: ".env", why: "Local environment files hold API keys and passwords", test: [".env", "apps/web/.env"] },
  { pattern: ".env.*", why: "So do .env.local, .env.production and the rest (the example stays shared)", test: [".env.local", ".env.production", "apps/web/.env.development.local"] },
  { pattern: "*.pem", why: "Private keys and certificates", test: ["certs/server.pem"] },
  { pattern: "*.key", why: "Private keys", test: ["certs/server.key"] },
  { pattern: "*.p12", why: "Certificate stores with their private keys", test: ["certs/client.p12"] },
  { pattern: "*.pfx", why: "Certificate stores with their private keys (Windows)", test: ["certs/client.pfx"] },
  { pattern: "*.jks", why: "Java and Android keystores", test: ["android/release.jks"] },
  { pattern: "*.keystore", why: "Android signing keystores", test: ["android/release.keystore"] },
  { pattern: "id_rsa*", why: "SSH private keys", test: ["id_rsa", "deploy/id_rsa"] },
  { pattern: "id_ed25519*", why: "SSH private keys", test: ["id_ed25519"] },
];

const ENV_NAME = /^\.env(\.[\w.-]+)?$|^[\w-]+\.env$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "vendor", "target", ".next", ".nuxt", ".svelte-kit", ".turbo", ".venv", "venv", "__pycache__", "coverage", ".cache", "bin", "obj"]);
const MAX_FILES = 50;
const MAX_ENV_BYTES = 256 * 1024;

/** The project's .env files, its root first, at most three folders down. */
export function findEnvFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && ENV_NAME.test(e.name)) out.push(child);
    }
    if (depth >= 3) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

export function isExampleFile(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  return EXAMPLE_FILES.includes(base) || /\.(example|sample|template|dist)$/.test(base);
}

/** The Env page's view of one project. `secrets` also scans tracked files for keys (slower). */
export function auditEnv(dir: string, options: { secrets?: boolean } = {}): ProjectEnv {
  const git = isGitRepo(dir);
  const names = findEnvFiles(dir);
  const tracked = new Set(git ? gitLines(dir, ["ls-files", "-z", "--cached", "--", ...names], "\0") : []);
  const untracked = names.filter((n) => !tracked.has(n));
  const ignored = new Set(git && untracked.length ? gitLines(dir, ["check-ignore", "--", ...untracked]) : []);
  const ignoreText = readText(path.join(dir, ".gitignore"));
  const lines = ignoreText === undefined ? [] : ignoreText.split(/\r?\n/);

  const files: EnvFileInfo[] = names.map((name) => {
    const text = readText(path.join(dir, name)) ?? "";
    const example = isExampleFile(name);
    // Outside git there's nothing to commit to; inside, the project's own rules decide.
    const notIgnored = !example && !tracked.has(name) && (git ? !ignored.has(name) : !matchesGitignore(lines, name));
    return { name, example, keys: parseDotenv(text).size, bytes: Buffer.byteLength(text), tracked: !example && tracked.has(name), notIgnored };
  });

  const rules = GITIGNORE_RULES.map((r) => ({ pattern: r.pattern, why: r.why, covered: r.test.every((t) => matchesGitignore(lines, t)) }));
  const exampleIgnored = matchesGitignore(lines, ".env.example");

  const report = options.secrets ? checkEnv(dir) : checkEnv(dir, { secrets: false });
  const problems =
    files.filter((f) => f.tracked || f.notIgnored).length +
    // No .gitignore, or one missing rules, is one thing to fix: the button adds them all.
    (ignoreText === undefined || rules.some((r) => !r.covered) ? 1 : 0) +
    (exampleIgnored ? 1 : 0) +
    report.secrets.length;
  return {
    dir,
    git,
    gitignore: ignoreText !== undefined,
    files,
    rules,
    exampleIgnored,
    missingVars: report.missing,
    emptyVars: report.empty,
    secrets: report.secrets,
    scanned: report.scanned,
    problems,
  };
}

/**
 * Adds the missing rules to the project's .gitignore (creating it if there's none), under a
 * comment saying why. Only rules from GITIGNORE_RULES can be added. Returns the lines added.
 */
export function addGitignoreRules(dir: string, patterns: string[]): string[] {
  const known = new Set(GITIGNORE_RULES.map((r) => r.pattern));
  const file = path.join(dir, ".gitignore");
  const text = readText(file) ?? "";
  const lines = text.split(/\r?\n/);
  const add = patterns.filter((p) => known.has(p) && !lines.some((l) => l.trim() === p));
  const audit = GITIGNORE_RULES.filter((r) => add.includes(r.pattern));
  if (!audit.length && !matchesGitignore(lines, ".env.example")) return [];
  const out = [...audit.map((r) => r.pattern)];
  // An example file is shared on purpose: keep it out of `.env.*`.
  if (out.includes(".env.*") || matchesGitignore([...lines, ...out], ".env.example")) {
    // .env.example always, and any other example file the project has (.env.sample, …).
    const examples = EXAMPLE_FILES.filter((e) => e.startsWith(".env.") && (e === ".env.example" || fs.existsSync(path.join(dir, e))));
    for (const ex of examples) if (!lines.some((l) => l.trim() === `!${ex}`)) out.push(`!${ex}`);
  }
  if (!out.length) return [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = `${text && !text.endsWith("\n") ? eol : ""}${text ? eol : ""}# Secrets: keys, certificates and local settings stay out of git (OWASP)${eol}${out.join(eol)}${eol}`;
  fs.appendFileSync(file, block);
  return out;
}

/** Reads one .env file of a project; only files the Env page lists, inside the project. */
export function readEnvFile(dir: string, name: string): string {
  const file = envFilePath(dir, name, true);
  const st = fs.statSync(file);
  if (st.size > MAX_ENV_BYTES) throw new Error(`${name} is larger than 256 KB; open it in your editor instead.`);
  return fs.readFileSync(file, "utf8");
}

/** Saves one .env file of a project, or creates one next to the others. Written whole, through a temp file. */
export function writeEnvFile(dir: string, name: string, content: string): void {
  if (Buffer.byteLength(content) > MAX_ENV_BYTES) throw new Error("That's larger than 256 KB, more than a .env file should be.");
  if (content.includes("\0")) throw new Error("A .env file is text; that has a NUL character in it.");
  const file = envFilePath(dir, name, false);
  // Keep the file's own permissions; a new one is readable by you only.
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // a new file
  }
  const tmp = `${file}.dx-${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

/**
 * The absolute path of a project's .env file, refused unless it's named like one, sits inside
 * the project (links followed), and isn't a link itself.
 */
function envFilePath(dir: string, name: string, mustExist: boolean): string {
  const root = fs.realpathSync.native(dir);
  const rel = String(name).replace(/\\/g, "/");
  const base = rel.split("/").pop() ?? "";
  if (!ENV_NAME.test(base) || rel.split("/").some((p) => p === ".." || p === "") || path.isAbsolute(rel)) {
    throw new Error(`Not a .env file of this project: ${name}`);
  }
  if (rel.split("/").slice(0, -1).some((p) => SKIP_DIRS.has(p))) throw new Error(`Not a .env file of this project: ${name}`);
  const file = path.join(root, ...rel.split("/"));
  const parent = fs.realpathSync.native(path.dirname(file));
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error(`Not inside the project: ${name}`);
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(file);
  } catch {
    if (mustExist) throw new Error(`${name} doesn't exist.`);
  }
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new Error(`${name} isn't a plain file.`);
  return file;
}

/**
 * Whether .gitignore lines ignore a path, the way git reads them: `!` to un-ignore, a slash to
 * anchor, `*`, `**` and `?`, a trailing slash for folders. Only the project's own root file.
 */
export function matchesGitignore(lines: string[], rel: string): boolean {
  const parts = rel.split("/");
  let ignored = false;
  for (const raw of lines) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const re = globToRegExp(line);
    let hit = false;
    // The path itself, or one of the folders it's in.
    for (let i = 1; i <= parts.length && !hit; i++) {
      const isDir = i < parts.length;
      if (dirOnly && !isDir) continue;
      hit = anchored ? re.test(parts.slice(0, i).join("/")) : re.test(parts[i - 1]);
    }
    if (hit) ignored = !negate;
  }
  return ignored;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += glob.slice(i, end + 1).replace(/^\[!/, "[^");
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function isGitRepo(dir: string): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim() !== "";
  } catch {
    return false;
  }
}

function gitLines(dir: string, args: string[], sep = "\n"): string[] {
  try {
    const out = execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return out.split(sep).map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    const out = (err as { stdout?: string }).stdout;
    return typeof out === "string" ? out.split(sep).map((l) => l.trim()).filter(Boolean) : [];
  }
}
