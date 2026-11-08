import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandExists } from "./doctor.js";

/**
 * Claude Code (`claude -p`), for the buttons that ask it something: Write message on the Git page
 * and Ask Claude to fix. Only ever on a click, since what's sent goes to the user's own Claude
 * account. The arguments are fixed and the prompt goes in on stdin, built by the caller from the
 * server's own records, never from a request.
 */

/** Where `claude` is, if Claude Code is installed (looked up again at most once a minute, or when PATH changes). */
let found: { at: number; envPath?: string; path?: string } | undefined;
export async function claudeCli(): Promise<string | undefined> {
  if (found && Date.now() - found.at < 60_000 && found.envPath === process.env.PATH) return found.path;
  found = { at: Date.now(), envPath: process.env.PATH, path: await commandExists("claude") };
  return found.path;
}

export interface ClaudeResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Effort levels Claude Code takes (`--effort`); Codex gets the nearest it has. */
export const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

/** A model name as the CLIs take it ("opus", "sonnet", a full id): letters, digits, dots and dashes only, so it can't be more than one argument. */
export function cleanAiModel(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(raw)) throw new Error("A model is a name like opus, sonnet or a model's full id (letters, digits, dots and dashes).");
  return raw;
}

export function cleanAiEffort(raw: unknown): AiEffort | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (!AI_EFFORTS.includes(raw as AiEffort)) throw new Error(`Effort is one of ${AI_EFFORTS.join(", ")}.`);
  return raw as AiEffort;
}

/**
 * Runs `claude -p --max-turns 1` with the prompt on stdin (and a checked model and effort when
 * given). dx only wants text back, so Claude Code gets none of its built-in tools (`--tools ""`)
 * and none of the user's MCP servers (`--strict-mcp-config`): with them it might reach for one
 * (read a file, call dx) and stop at "Reached max turns". It runs in an empty folder, so no
 * project's CLAUDE.md comes along. A Claude Code too old for those flags is asked again without
 * them. A .cmd shim (npm on Windows) needs cmd.exe; the arguments are fixed either way.
 */
export async function runClaude(cli: string, input: string, options: { timeoutMs?: number; model?: string; effort?: AiEffort; free?: { cwd: string } } = {}): Promise<ClaudeResult> {
  const model = cleanAiModel(options.model);
  const effort = cleanAiEffort(options.effort);
  const chosen = [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
  // Free: like talking to Claude Code yourself (the Tools chat). No turn limit, its own tools and
  // the user's MCP servers, in the project's folder, no time limit. Its own permission rules still
  // apply: with nobody to ask in -p, anything that needs an OK (an edit, a command) is refused.
  if (options.free) return spawnClaude(cli, ["-p", ...chosen], input, options.free.cwd, options.timeoutMs);
  const args = ["-p", "--max-turns", "1", ...chosen];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dx-claude-"));
  try {
    const r = await spawnClaude(cli, [...args, "--tools", "", "--strict-mcp-config"], input, work, options.timeoutMs);
    if (r.code !== 0 && /unknown option|unrecognized|unexpected argument/i.test(r.stderr) && /--tools|--strict-mcp-config/.test(r.stderr)) return await spawnClaude(cli, args, input, work, options.timeoutMs);
    return r;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function spawnClaude(cli: string, args: string[], input: string, cwd: string, timeoutMs = 60_000): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(cli);
    // An empty argument is written "" on the command line, as cmd.exe passes it on.
    const line = args.map((a) => (a === "" ? '""' : a)).join(" ");
    const child = shim
      ? // cmd /s takes off the outermost quotes, so the whole line is quoted once more.
        spawn("cmd.exe", ["/d", "/s", "/c", `""${cli}" ${line}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(cli, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // No timer at all for an unlimited run (setTimeout takes Infinity as at once).
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : undefined;
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: e.message, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Claude Code's own words when it failed, with a hint to sign in when that's what it's about. */
export function claudeFailure(r: ClaudeResult, what: string): string {
  const said = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-6).join("\n");
  return `${what}${said ? `: ${said}` : ""}${/log ?in|auth|api key/i.test(said) ? " (sign in by running claude in a terminal)" : ""}`;
}
