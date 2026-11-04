import { spawn } from "node:child_process";
import { commandExists } from "./doctor.js";
import { GitError, gitFailure, gitRoot, gitRun } from "./git.js";

/**
 * A commit message written by Claude Code (`claude -p`) from what's staged, for the Git page's
 * "Write message" button. Only ever on that click: it sends the staged diff to the user's own
 * Claude account. The prompt and the diff are built here, never taken from a request, and the
 * result only fills the message box; nothing is committed.
 */

const DIFF_MAX = 60 * 1024;
const TIMEOUT_MS = 60_000;

/** Where `claude` is, if Claude Code is installed (looked up again at most once a minute). */
let found: { at: number; path?: string } | undefined;
export async function claudeCli(): Promise<string | undefined> {
  if (found && Date.now() - found.at < 60_000) return found.path;
  found = { at: Date.now(), path: await commandExists("claude") };
  return found.path;
}

const PROMPT = `Write a git commit message for the staged changes below.

Rules:
- Match the style of this repository's recent commit subjects, listed below (length, tense, capitalisation, prefixes like "feat:" only if they use them).
- A subject line under 72 characters. Then, only if the change needs explaining, a blank line and a short body saying why, wrapped at 72 characters.
- Describe what changed for someone reading the history, not the file list.
- No Co-Authored-By lines, no "Generated with" lines, no sign-off, no emoji unless the recent subjects use them.
- Reply with the commit message only: no preamble, no quotes, no code fences.`;

/** Builds what claude reads on stdin: the instructions, the recent subjects, and the staged diff (cut to 60 KB, with the full stat). */
export async function commitMessagePrompt(root: string): Promise<string> {
  const [stat, diff, log] = await Promise.all([
    gitRun(root, ["diff", "--cached", "--stat=200", "--no-color"]),
    gitRun(root, ["diff", "--cached", "--no-color", "--no-ext-diff", "-M"], { max: DIFF_MAX }),
    gitRun(root, ["log", "-10", "--format=%s"]),
  ]);
  if (stat.code !== 0) throw gitFailure(stat, "Couldn't read the staged changes");
  if (!stat.stdout.trim()) throw new GitError("Nothing is staged yet: stage the changes the message should describe.");
  const subjects = log.code === 0 ? log.stdout.trim() : "";
  return [
    PROMPT,
    "",
    "Recent commit subjects, newest first:",
    subjects || "(none yet: this is the first commit)",
    "",
    "Files changed:",
    stat.stdout.trim(),
    "",
    diff.truncated ? `The staged diff (cut at ${DIFF_MAX / 1024} KB; the file list above is complete):` : "The staged diff:",
    diff.stdout,
  ].join("\n");
}

/** What claude printed, as a message: fences, quotes and any attribution lines taken off. */
export function cleanCommitMessage(text: string): string {
  let t = text.replace(/\r\n/g, "\n").trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1].trim();
  if (/^".*"$/s.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
  return t
    .split("\n")
    .filter((line) => !/^\s*(co-authored-by:|signed-off-by:|🤖|generated with\b)/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Runs `claude -p` with the prompt on stdin. A .cmd shim (npm on Windows) needs cmd.exe; the arguments are fixed either way. */
function runClaude(cli: string, input: string): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const args = ["-p", "--max-turns", "1"];
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
    }, TIMEOUT_MS);
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

export async function gitSuggestMessage(dir: string, options: { claude?: string } = {}): Promise<{ message: string }> {
  const root = await gitRoot(dir);
  const cli = options.claude ?? (await claudeCli());
  if (!cli) throw new GitError("Claude Code isn't installed here (no claude command), so it can't write the message.");
  const prompt = await commitMessagePrompt(root);
  const r = await runClaude(cli, prompt);
  if (r.timedOut) throw new GitError("Claude Code took longer than a minute, so it was stopped. Try again, or write the message yourself.", 504);
  if (r.code !== 0) {
    const said = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-6).join("\n");
    throw new GitError(`Claude Code couldn't write it${said ? `: ${said}` : ""}${/log ?in|auth|api key/i.test(said) ? " (sign in by running claude in a terminal)" : ""}`, 502);
  }
  const message = cleanCommitMessage(r.stdout);
  if (!message) throw new GitError("Claude Code answered with nothing. Try again, or write the message yourself.", 502);
  return { message };
}
