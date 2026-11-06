import { spawn } from "node:child_process";
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

/** Runs `claude -p --max-turns 1` with the prompt on stdin (and a checked model and effort when given). A .cmd shim (npm on Windows) needs cmd.exe; the arguments are fixed either way. */
export function runClaude(cli: string, input: string, options: { timeoutMs?: number; model?: string; effort?: AiEffort } = {}): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const args = ["-p", "--max-turns", "1"];
    const model = cleanAiModel(options.model);
    const effort = cleanAiEffort(options.effort);
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(cli);
    const child = shim
      ? // cmd /s takes off the outermost quotes, so the whole line is quoted once more.
        spawn("cmd.exe", ["/d", "/s", "/c", `""${cli}" ${args.join(" ")}"`], { windowsHide: true, windowsVerbatimArguments: true })
      : spawn(cli, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 60_000);
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
