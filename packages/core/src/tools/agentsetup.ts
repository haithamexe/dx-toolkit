import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic.js";
import { loadConfig } from "../config.js";
import { recordRun } from "../runs.js";
import { scanProjects, type Project } from "./projects.js";
import { classifyCommand } from "./hookrules.js";
import { detectTestFramework } from "./tests.js";

export { classifyCommand, type ShellKind } from "./hookrules.js";

/**
 * Making a project's Claude Code sessions use dx as the way to run, test and check the app.
 * Three small, local things, all undoable (`dx claude --undo`), none of them committed:
 *
 *  1. `CLAUDE.local.md`: a marked block saying which dx tools to use here, with the project's own
 *     test and dev commands, so a session reaches for `run_tests` and not a bare `npm test`.
 *  2. `.claude/settings.local.json`: the read-only and run/test dx tools allowed without a prompt
 *     (the risky ones, a commit, a delete, `.env` values, keep asking), and a PreToolUse hook that
 *     only *nudges*: it never blocks and never approves a command, it adds a line of guidance.
 *  3. Both files are listed in the repository's own `.git/info/exclude`, never `.gitignore`, so
 *     nothing shows up as changed and nothing reaches a teammate.
 *
 * The hook is `dx hook pre-bash` (the fixed text below). It reads Claude Code's JSON on stdin and
 * answers with `additionalContext` only. Nothing in a request or a project's files becomes a command.
 */

/** The dx tools a session may use without being asked each time: they read, or run the project's own tests and dev server. */
export const DX_ALLOWED_TOOLS = [
  "list_projects",
  "dev_servers",
  "dev_logs",
  "dev_errors",
  "wait_for_rebuild",
  "check_url",
  "run_tests",
  "start_dev_server",
  "check_env",
  "unsaved_work",
  "dx_actions",
  "dx_status",
  "dx_verify",
] as const;

/** The hook's command, fixed: `dx` is on PATH wherever dx is installed. */
export const DX_HOOK_COMMAND = "dx hook pre-bash";

const NOTE_FILE = "CLAUDE.local.md";
const SETTINGS_FILE = path.join(".claude", "settings.local.json");
const START = "<!-- dx:start (written by dx; `dx claude --undo` takes it out) -->";
const END = "<!-- dx:end -->";

export interface ClaudeSetupState {
  /** The note is in CLAUDE.local.md. */
  note: boolean;
  /** The dx tools are allowed in .claude/settings.local.json. */
  permissions: boolean;
  /** The nudge hook is in .claude/settings.local.json. */
  hook: boolean;
  /** All three. */
  on: boolean;
}

type Settings = { permissions?: { allow?: string[]; [k: string]: unknown }; hooks?: { PreToolUse?: HookGroup[]; [k: string]: unknown }; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: { type?: string; command?: string; [k: string]: unknown }[]; [k: string]: unknown };

const allowRule = (tool: string) => `mcp__dx__${tool}`;
const isOurs = (g: HookGroup) => !!g.hooks?.some((x) => x.command === DX_HOOK_COMMAND);

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The settings file as an object; one that isn't valid JSON is left alone (the person's own comments and edits matter more). */
function readSettings(dir: string): Settings {
  const text = readText(path.join(dir, SETTINGS_FILE));
  if (text === undefined || !text.trim()) return {};
  try {
    const data = JSON.parse(text) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Settings;
  } catch {
    // below
  }
  throw new Error(`${SETTINGS_FILE} isn't valid JSON, so dx left it alone. Fix or remove it, then run dx claude again.`);
}

function writeSettings(dir: string, settings: Settings): void {
  const file = path.join(dir, SETTINGS_FILE);
  if (!Object.keys(settings).length) {
    fs.rmSync(file, { force: true });
    // The folder dx made, if nothing else is in it.
    try {
      fs.rmdirSync(path.dirname(file));
    } catch {
      // not empty: someone else's files are there
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The file's own line endings are kept; in place, not a rename: a link to a dotfile elsewhere stays a link.
  const json = `${JSON.stringify(settings, null, 2)}\n`;
  writeFileAtomic(file, (readText(file) ?? "").includes("\r\n") ? json.replace(/\n/g, "\r\n") : json, { direct: true });
}

export function claudeSetupState(dir: string): ClaudeSetupState {
  const note = (readText(path.join(dir, NOTE_FILE)) ?? "").includes(START);
  let permissions = false;
  let hook = false;
  try {
    const s = readSettings(dir);
    const allow = s.permissions?.allow ?? [];
    permissions = DX_ALLOWED_TOOLS.every((t) => allow.includes(allowRule(t)));
    hook = !!s.hooks?.PreToolUse?.some(isOurs);
  } catch {
    // an unreadable file is "not set up"
  }
  return { note, permissions, hook, on: note && permissions && hook };
}

/** The block for CLAUDE.local.md, with this project's own commands. */
export function projectNote(project: Pick<Project, "name" | "dir" | "devCommand">): string {
  const found = detectTestFramework(project.dir);
  const testWords = found ? `${found.framework === "script" ? "its test script" : found.framework}${found.script ? `, run as \`${found.script}\`` : ""}` : "its tests";
  return [
    START,
    "## Working in this project through dx",
    "",
    `This project runs under **dx**, a local dev dashboard the user watches while you work. Its tools are the MCP server \`dx\`; use them instead of raw shell commands, so each result is structured (failures with file and line, errors with their stack) and the user sees it too. The project's name in dx is \`${project.name}\`.`,
    "",
    `- **Tests:** \`run_tests\` (${testWords}), not a bare test command. \`match\` reruns only what you're fixing; run them all before you finish.`,
    `- **The app:** \`start_dev_server\`${project.devCommand ? ` (it runs \`${project.devCommand}\`)` : ""}, then \`wait_for_rebuild\` after an edit, \`dev_errors\` for errors with file:line, \`check_url\` to try a page. Don't start the dev server in a shell: dx already runs it.`,
    "- **After a change:** `dx_verify` does the loop in one call (waits for the rebuild, runs the changed tests, checks the page). `dx_status` says where things stand.",
    "- Anything else the dashboard can do is `dx_actions` / `dx_do`; what could lose work or leave this computer asks the user first.",
    END,
    "",
  ].join("\n");
}

/** `.git/info/exclude` of the repository this folder is in, so the two files never show as changed. */
function excludeFile(dir: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    return out ? path.resolve(dir, out) : undefined;
  } catch {
    return undefined;
  }
}

function excludeLocalFiles(dir: string): void {
  const file = excludeFile(dir);
  if (!file) return;
  const text = readText(file) ?? "";
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const add = [NOTE_FILE, ".claude/settings.local.json"].filter((l) => !lines.includes(l));
  if (!add.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
}

/** A file the repository tracks: it would show as a change and could be committed, so dx doesn't write it. */
function tracked(dir: string, file: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", file], { cwd: dir, stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Puts the note, the permissions and the nudge in place; says which of them it had to add. */
export function applyClaudeSetup(project: Pick<Project, "name" | "dir" | "devCommand">, source = "cli"): string[] {
  const did: string[] = [];
  // The settings first: if that file can't be read, nothing is half done.
  const settings = readSettings(project.dir);
  const state = claudeSetupState(project.dir);
  // A file the repository tracks is left alone: a change there would be part of the project's own history.
  for (const [file, label] of [[SETTINGS_FILE.split(path.sep).join("/"), SETTINGS_FILE.split(path.sep).join("/")], [NOTE_FILE, NOTE_FILE]]) {
    if (tracked(project.dir, file)) throw new Error(`${label} is committed in this repository, so dx left it alone (it would show up as a change).`);
  }

  const noteFile = path.join(project.dir, NOTE_FILE);
  const existing = readText(noteFile) ?? "";
  const block = projectNote(project);
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  const next = start >= 0 && end > start ? `${existing.slice(0, start)}${block}${existing.slice(end + END.length).replace(/^\r?\n/, "")}` : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${block}`;
  if (next !== existing) {
    fs.writeFileSync(noteFile, next);
    if (!state.note) did.push(`a note in ${NOTE_FILE}`);
  }

  settings.permissions ??= {};
  const allow = (settings.permissions.allow ??= []);
  const missing = DX_ALLOWED_TOOLS.map(allowRule).filter((r) => !allow.includes(r));
  if (missing.length) {
    allow.push(...missing);
    did.push(`${plural(missing.length, "dx tool")} allowed without asking`);
  }
  settings.hooks ??= {};
  const pre = (settings.hooks.PreToolUse ??= []);
  if (!pre.some(isOurs)) {
    pre.push({ matcher: "Bash", hooks: [{ type: "command", command: DX_HOOK_COMMAND, timeout: 10 }] });
    did.push("a hint when a shell test or dev command could go through dx");
  }
  if (did.some((d) => !d.startsWith("a note"))) writeSettings(project.dir, settings);
  excludeLocalFiles(project.dir);
  if (did.length) recordRun("claude-setup", true, `${project.name}: ${did.join(", ")}`, source, { project: project.name });
  return did;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Takes exactly what applyClaudeSetup added back out. Returns what it removed. */
export function undoClaudeSetup(project: Pick<Project, "name" | "dir">, source = "cli"): string[] {
  const removed: string[] = [];
  const noteFile = path.join(project.dir, NOTE_FILE);
  const text = readText(noteFile);
  if (text?.includes(START)) {
    const start = text.indexOf(START);
    const end = text.indexOf(END);
    if (end > start) {
      const rest = `${text.slice(0, start).replace(/\s+$/, "")}${text.slice(end + END.length).replace(/^\s+/, text.slice(0, start).trim() ? "\n\n" : "")}`.trimEnd();
      if (rest.trim()) fs.writeFileSync(noteFile, `${rest}\n`);
      else fs.rmSync(noteFile, { force: true });
      removed.push(`the note in ${NOTE_FILE}`);
    }
  }
  const settings = readSettings(project.dir);
  const ours = new Set<string>(DX_ALLOWED_TOOLS.map(allowRule));
  if (settings.permissions?.allow?.some((r) => ours.has(r))) {
    settings.permissions.allow = settings.permissions.allow.filter((r) => !ours.has(r));
    if (!settings.permissions.allow.length) delete settings.permissions.allow;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
    removed.push("the allowed dx tools");
  }
  if (settings.hooks?.PreToolUse?.some(isOurs)) {
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((g) => !isOurs(g));
    if (!settings.hooks.PreToolUse.length) delete settings.hooks.PreToolUse;
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    removed.push("the hint hook");
  }
  if (removed.some((r) => r !== `the note in ${NOTE_FILE}`)) writeSettings(project.dir, settings);
  if (removed.length) recordRun("claude-setup", true, `${project.name}: removed ${removed.join(", ")}`, source, { project: project.name });
  return removed;
}

// ------------------------------------------------------------------ the hook

const inside = (dir: string, cwd: string) => {
  const rel = path.relative(path.resolve(dir), path.resolve(cwd));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * What `dx hook pre-bash` prints for Claude Code's JSON on stdin: nothing for most commands; for a
 * test or dev command in a dx project, a line of guidance (`additionalContext`), and never a
 * decision: the command runs, and still asks the person as it would have. `projects` is for tests.
 */
export function preBashHook(stdin: string, projects?: Project[]): string {
  let input: { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
  try {
    input = JSON.parse(stdin) as typeof input;
  } catch {
    return "";
  }
  const command = input.tool_input?.command;
  if (input.tool_name !== "Bash" || typeof command !== "string" || typeof input.cwd !== "string") return "";
  const kind = classifyCommand(command);
  if (!kind) return "";
  // Only now, the (slower) look at which project this is.
  const list = projects ?? scanProjects(loadConfig());
  const project = list.filter((p) => inside(p.dir, input.cwd as string)).sort((a, b) => b.dir.length - a.dir.length)[0];
  if (!project) return "";
  const text =
    kind === "test"
      ? `This project runs under dx: use the run_tests tool (project "${project.name}") instead of a shell test command. It reads the framework's own report, so each failure comes back with file, line, expected and actual, and the user sees the run in the dx dashboard. match reruns only what you're fixing.`
      : `This project runs under dx: use start_dev_server (project "${project.name}") instead of starting it in a shell, then wait_for_rebuild after edits and dev_errors for errors. dx already runs and watches the server, and the user sees its output in the dashboard.`;
  recordRun("claude-nudge", true, `${kind}: ${project.name}`, "hook", { project: project.name });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
}
