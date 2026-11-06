import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { cleanAiEffort, cleanAiModel, claudeCli, runClaude, type AiEffort } from "./claude.js";
import { commandExists } from "./doctor.js";

/**
 * The coding agent CLI already on this computer, for the buttons that ask one something: Claude
 * Code (`claude -p`) or Codex (`codex exec`). No API keys: each runs with the user's own sign-in.
 * Only ever on a click. The arguments are fixed, the prompt goes in on stdin and is built by dx
 * from its own records, and Codex runs in a read-only sandbox in an empty folder.
 */

export type AiTool = "claude" | "codex";

export interface AiCli {
  tool: AiTool;
  name: string;
  path: string;
}

let codexFound: { at: number; envPath?: string; path?: string } | undefined;
async function codexCli(): Promise<string | undefined> {
  if (codexFound && Date.now() - codexFound.at < 60_000 && codexFound.envPath === process.env.PATH) return codexFound.path;
  codexFound = { at: Date.now(), envPath: process.env.PATH, path: await commandExists("codex") };
  return codexFound.path;
}

/** The CLIs installed, the configured one (`aiCli` in the config) first, else Claude Code before Codex. */
export async function aiClis(): Promise<AiCli[]> {
  const [claude, codex] = await Promise.all([claudeCli(), codexCli()]);
  const list: AiCli[] = [];
  if (claude) list.push({ tool: "claude", name: "Claude Code", path: claude });
  if (codex) list.push({ tool: "codex", name: "Codex", path: codex });
  let preferred: string | undefined;
  try {
    preferred = loadConfig().aiCli;
  } catch {
    // no config yet
  }
  return list.sort((a, b) => Number(b.tool === preferred) - Number(a.tool === preferred));
}

export async function aiCli(tool?: AiTool): Promise<AiCli | undefined> {
  const list = await aiClis();
  return tool ? list.find((c) => c.tool === tool) : list[0];
}

export interface AiResult {
  tool: AiTool;
  code: number;
  /** The agent's final answer. */
  text: string;
  stderr: string;
  timedOut: boolean;
}

/** Model names to offer for each CLI; any other well-formed name can be typed. */
export const AI_MODELS: Record<AiTool, string[]> = {
  claude: ["opus", "sonnet", "haiku", "fable"],
  codex: ["gpt-5", "gpt-5-codex", "o3"],
};

/** Codex's reasoning effort for dx's level (it has no xhigh or max). */
const CODEX_EFFORT: Record<AiEffort, string> = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

/** Asks the agent once and returns its final answer, with the model and effort when given (checked). Nothing it says is run by dx. */
export async function askAi(cli: AiCli, prompt: string, options: { timeoutMs?: number; model?: string; effort?: AiEffort } = {}): Promise<AiResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const model = cleanAiModel(options.model);
  const effort = cleanAiEffort(options.effort);
  if (cli.tool === "claude") {
    const r = await runClaude(cli.path, prompt, { timeoutMs, model, effort });
    return { tool: "claude", code: r.code, text: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
  }
  // Codex: no tools that write, no git checks, no saved session, the answer in a file of dx's own.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dx-codex-"));
  const out = path.join(work, "answer.txt");
  const args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "-o", out];
  if (model) args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort=${CODEX_EFFORT[effort]}`);
  args.push("-");
  try {
    const r = await run(cli.path, args, prompt, work, timeoutMs);
    let text = "";
    try {
      text = fs.readFileSync(out, "utf8");
    } catch {
      text = r.stdout;
    }
    return { tool: "codex", code: r.code, text, stderr: r.stderr, timedOut: r.timedOut };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function run(file: string, args: string[], input: string, cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
    const child = shim
      ? spawn("cmd.exe", ["/d", "/s", "/c", `""${file}" ${quoted}"`], { cwd, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(file, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
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

/** The agent's own words when it failed, with a hint to sign in when that's what it's about. */
export function aiFailure(r: AiResult, what: string): string {
  const said = (r.stderr || r.text).trim().split(/\r?\n/).slice(-6).join("\n");
  const name = r.tool === "claude" ? "claude" : "codex";
  if (r.timedOut) return `${what}: ${name === "claude" ? "Claude Code" : "Codex"} didn't answer in time.`;
  return `${what}${said ? `: ${said}` : ""}${/log ?in|auth|api key|sign ?in/i.test(said) ? ` (sign in by running ${name} in a terminal)` : ""}`;
}

/** The first JSON value in an answer: a fenced ```json block, or the text itself. */
export function jsonFromAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text.trim(), text.slice(text.search(/[[{]/))].filter((x): x is string => !!x);
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      // next
    }
  }
  throw new Error("The answer wasn't JSON.");
}
