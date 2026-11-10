import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Two checks before an app crashes on "undefined" or a key leaks:
 * - which variables .env.example lists that your .env files don't set;
 * - which keys and tokens are committed, and whether .env is kept out of git.
 */

export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
  /** The start of the value and its length, never the whole value. */
  preview: string;
}

export interface EnvReport {
  dir: string;
  /** .env.example (or .env.sample, …) when the project has one. */
  exampleFile?: string;
  /** The .env files that exist: .env, .env.local, .env.development, … */
  envFiles: string[];
  /** Listed in the example and set in no .env file. */
  missing: string[];
  /** Set, but empty, in every .env file that has it. */
  empty: string[];
  /** .env files git tracks, so their values are in the repository. */
  tracked: string[];
  /** .env files that exist and git doesn't ignore, so a `git add .` would commit them. */
  notIgnored: string[];
  /** Keys and tokens found in files git tracks. */
  secrets: SecretFinding[];
  /** Whether secrets were looked for (only in git repositories). */
  scanned: boolean;
}

export const EXAMPLE_FILES = [".env.example", ".env.sample", ".env.template", ".env.dist", "example.env"];
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.dev"];

/** KEY=value lines, with `export`, quotes and comments handled the way dotenv does. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out.set(m[1], value);
  }
  return out;
}

export function findExampleFile(dir: string): string | undefined {
  return EXAMPLE_FILES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
}

/** Creates .env from .env.example when there's no .env yet. Returns the file it created. */
export function ensureEnvFile(dir: string): string | undefined {
  const example = findExampleFile(dir);
  const env = path.join(dir, ".env");
  if (!example || fs.existsSync(env)) return undefined;
  fs.copyFileSync(example, env);
  return env;
}

/**
 * The .env checks are written once as steps: each `yield` asks for git's answer (or the scan of the
 * tracked files) and gets it back. `runEnvSteps` answers them with the synchronous calls (the CLI,
 * an AI tool's server, tests); `runEnvStepsAsync` with ones that don't hold up the dashboard, which
 * also runs the proxy to your dev servers, while git starts for each of 22 projects.
 */
export type EnvStep = { dir: string; git: string[]; sep: string } | { dir: string; scan: string[] };
export type EnvSteps<T> = Generator<EnvStep, T, unknown>;

/** git's output as lines. */
export function* gitLinesStep(dir: string, args: string[], sep = "\n"): EnvSteps<string[]> {
  return (yield { dir, git: args, sep }) as string[];
}
/** The keys and tokens in these tracked files. */
export function* scanStep(dir: string, files: string[]): EnvSteps<SecretFinding[]> {
  return (yield { dir, scan: files }) as SecretFinding[];
}
/** Whether `dir` is inside a git repository. */
export function* isGitRepoStep(dir: string): EnvSteps<boolean> {
  return (yield* gitLinesStep(dir, ["rev-parse", "--show-toplevel"])).length > 0;
}

export function runEnvSteps<T>(steps: EnvSteps<T>): T {
  let r = steps.next();
  while (!r.done) r = steps.next("git" in r.value ? gitLines(r.value.dir, r.value.git, r.value.sep) : scanSecrets(r.value.dir, r.value.scan));
  return r.value;
}

export async function runEnvStepsAsync<T>(steps: EnvSteps<T>): Promise<T> {
  let r = steps.next();
  while (!r.done) r = steps.next("git" in r.value ? await gitLinesAsync(r.value.dir, r.value.git, r.value.sep) : await scanSecretsAsync(r.value.dir, r.value.scan));
  return r.value;
}

export function checkEnv(dir: string, options: { secrets?: boolean } = {}): EnvReport {
  return runEnvSteps(checkEnvSteps(dir, options));
}

export function checkEnvAsync(dir: string, options: { secrets?: boolean } = {}): Promise<EnvReport> {
  return runEnvStepsAsync(checkEnvSteps(dir, options));
}

export function* checkEnvSteps(dir: string, options: { secrets?: boolean } = {}): EnvSteps<EnvReport> {
  const report: EnvReport = { dir, envFiles: [], missing: [], empty: [], tracked: [], notIgnored: [], secrets: [], scanned: false };
  const example = findExampleFile(dir);
  if (example) report.exampleFile = example;
  const values = new Map<string, string[]>();
  for (const name of ENV_FILES) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    report.envFiles.push(file);
    for (const [k, v] of parseDotenv(read(file))) values.set(k, [...(values.get(k) ?? []), v]);
  }
  if (example) {
    for (const key of parseDotenv(read(example)).keys()) {
      const set = values.get(key);
      if (!set) report.missing.push(key);
      else if (set.every((v) => v === "")) report.empty.push(key);
    }
  }

  const git = yield* isGitRepoStep(dir);
  if (git) {
    const tracked = yield* gitLinesStep(dir, ["ls-files", "-z", "--cached"], "\0");
    const isEnv = (f: string) => /(^|\/)\.env(\.[\w.-]+)?$/.test(f) && !EXAMPLE_FILES.some((e) => f === e || f.endsWith(`/${e}`));
    report.tracked = tracked.filter(isEnv);
    const unTracked = report.envFiles.map((f) => path.relative(dir, f).split(path.sep).join("/")).filter((f) => !report.tracked.includes(f));
    if (unTracked.length) {
      const ignored = new Set(yield* gitLinesStep(dir, ["check-ignore", "--", ...unTracked]));
      report.notIgnored = unTracked.filter((f) => !ignored.has(f));
    }
    if (options.secrets !== false) {
      report.secrets = yield* scanStep(dir, tracked);
      report.scanned = true;
    }
  }
  return report;
}

interface SecretPattern {
  kind: string;
  re: RegExp;
}

// Shapes of real credentials only, so ordinary code and placeholders don't match.
const PATTERNS: SecretPattern[] = [
  { kind: "Private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
  { kind: "OpenAI API key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/ },
  { kind: "Stripe live key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "SendGrid key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
];

const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock)$|\.(min\.js|map|png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mp3|wasm|exe|dll|so|dylib)$/i;
const MAX_FILE = 512 * 1024;
const MAX_FINDINGS = 50;

function scanSecrets(dir: string, files: string[]): SecretFinding[] {
  const found: SecretFinding[] = [];
  for (const rel of files) {
    if (SKIP.test(rel)) continue;
    const file = path.join(dir, rel);
    let text: string;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      const buf = fs.readFileSync(file);
      if (buf.includes(0)) continue; // binary
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    found.push(...findSecrets(rel, text, MAX_FINDINGS - found.length));
    if (found.length >= MAX_FINDINGS) return found;
  }
  return found;
}

/** The keys and tokens on each line of one file's text, at most `room` of them. */
function findSecrets(rel: string, text: string, room: number): SecretFinding[] {
  const found: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      const m = p.re.exec(lines[i]);
      if (!m) continue;
      // An OpenAI-shaped match that is really an Anthropic key is reported once, as Anthropic.
      if (p.kind === "OpenAI API key" && m[0].startsWith("sk-ant-")) continue;
      found.push({ file: rel, line: i + 1, kind: p.kind, preview: mask(m[0]) });
      if (found.length >= room) return found;
    }
  }
  return found;
}

/** scanSecrets, reading the files without holding up the dashboard: a file at a time, with the event loop free in between. */
async function scanSecretsAsync(dir: string, files: string[]): Promise<SecretFinding[]> {
  const found: SecretFinding[] = [];
  for (const rel of files) {
    if (SKIP.test(rel)) continue;
    let buf: Buffer;
    try {
      const file = path.join(dir, rel);
      const st = await fs.promises.stat(file);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      buf = await fs.promises.readFile(file);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binary
    found.push(...findSecrets(rel, buf.toString("utf8"), MAX_FINDINGS - found.length));
    if (found.length >= MAX_FINDINGS) break;
  }
  return found;
}

function mask(value: string): string {
  if (value.startsWith("-----")) return "-----BEGIN … PRIVATE KEY-----";
  return `${value.slice(0, Math.min(6, Math.floor(value.length / 4)))}… (${value.length} characters)`;
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** git output split into lines, without waiting for it on the main thread. */
function gitLinesAsync(dir: string, args: string[], sep = "\n"): Promise<string[]> {
  return new Promise((resolve) => {
    const split = (out: unknown) => (typeof out === "string" ? out.split(sep).map((l) => l.trim()).filter(Boolean) : []);
    execFile("git", args, { cwd: dir, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(split(err ? (err as { stdout?: string }).stdout : stdout)));
  });
}

/** git output split into lines; check-ignore exits 1 when nothing is ignored, which isn't an error. */
function gitLines(dir: string, args: string[], sep = "\n"): string[] {
  try {
    const out = execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return out.split(sep).map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    const out = (err as { stdout?: string }).stdout;
    return typeof out === "string" ? out.split(sep).map((l) => l.trim()).filter(Boolean) : [];
  }
}
