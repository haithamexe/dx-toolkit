import { claudeCli, claudeFailure, runClaude } from "./claude.js";
import { GitError, gitFailure, gitRoot, gitRun } from "./git.js";

/**
 * A commit message written by Claude Code (`claude -p`) from what's staged, for the Git page's
 * "Write message" button. Only ever on that click: it sends the staged diff to the user's own
 * Claude account. The prompt and the diff are built here, never taken from a request, and the
 * result only fills the message box; nothing is committed.
 */

const DIFF_MAX = 60 * 1024;
const TIMEOUT_MS = 60_000;

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

export async function gitSuggestMessage(dir: string, options: { claude?: string } = {}): Promise<{ message: string }> {
  const root = await gitRoot(dir);
  const cli = options.claude ?? (await claudeCli());
  if (!cli) throw new GitError("Claude Code isn't installed here (no claude command), so it can't write the message.");
  const prompt = await commitMessagePrompt(root);
  const r = await runClaude(cli, prompt, { timeoutMs: TIMEOUT_MS });
  if (r.timedOut) throw new GitError("Claude Code took longer than a minute, so it was stopped. Try again, or write the message yourself.", 504);
  if (r.code !== 0) throw new GitError(claudeFailure(r, "Claude Code couldn't write it"), 502);
  const message = cleanCommitMessage(r.stdout);
  if (!message) throw new GitError("Claude Code answered with nothing. Try again, or write the message yourself.", 502);
  return { message };
}
