import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { buildSummary, buildYearReview, formatSummary, formatYearReview, loadConfig, openInEditor, recordRun, saveSummary, saveYearReview } from "@dx/core";
import type { Command } from "../command.js";
import { c, ok, tildify, UsageError, warn } from "../ui.js";

export const summaryCommand: Command = {
  name: "summary",
  aliases: ["week"],
  summary: "Your commits across all projects plus your journal, as a ready-to-send update",
  usage: [
    "dx summary                 the last 7 days, printed as markdown",
    "dx summary --days 1        just today (handy for a standup)",
    "dx summary --copy          also copy it to the clipboard",
    "dx summary --save          also save it to ~/.dx/summaries/<date>.md",
    "dx summary --save --open   save it and open the file in your editor",
    "dx summary --all-authors   count everyone's commits, not only yours",
    "dx summary --no-github     skip pull requests from GitHub (works offline)",
    "dx summary --json          the raw data",
    "dx summary --year          this year in review: month by month, projects, pull requests, journal",
    "dx summary --year 2025     another year (--copy and --save work here too)",
  ].join("\n"),
  async run(argv) {
    // --year on its own means this year.
    const i = argv.indexOf("--year");
    if (i >= 0 && !/^\d{4}$/.test(argv[i + 1] ?? "")) argv = [...argv.slice(0, i + 1), String(new Date().getFullYear()), ...argv.slice(i + 1)];
    const { values } = parseArgs({
      args: argv,
      allowNegative: true,
      options: {
        days: { type: "string", short: "d" },
        copy: { type: "boolean", short: "c" },
        save: { type: "boolean", short: "s" },
        open: { type: "boolean", short: "o" },
        "all-authors": { type: "boolean", short: "a" },
        json: { type: "boolean" },
        github: { type: "boolean", default: true },
        year: { type: "string", short: "y" },
      },
    });
    if (values.year !== undefined) return year(Number(values.year), values);
    const days = values.days === undefined ? 7 : Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new UsageError("--days must be a whole number from 1 to 366.");

    const config = loadConfig();
    const summary = await buildSummary({ days, config, allAuthors: values["all-authors"], github: values.github });
    if (values.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    const markdown = formatSummary(summary);
    console.log(markdown);

    for (const s of summary.skipped) warn(`Skipped ${s.project}: ${s.reason}`);
    if (summary.github && "error" in summary.github) warn(`No pull requests: ${summary.github.error}`);
    if (!summary.projects.length && !summary.journal.length) {
      console.log(c.dim('Log what you do with: dx log "what you did"'));
    } else {
      console.log(c.dim(`Commits by ${summary.author}. Everyone's: dx summary --all-authors`));
    }

    if (values.copy) {
      try {
        await copyToClipboard(markdown);
        ok("Copied to the clipboard");
      } catch (err) {
        warn(`Couldn't copy to the clipboard: ${(err as Error).message}`);
      }
    }
    if (values.save || values.open) {
      const file = saveSummary(markdown, summary);
      ok(`Saved ${tildify(file)}`);
      if (values.open) await openInEditor(file, config.editor);
    }
    const commits = summary.projects.reduce((n, p) => n + p.commits.length, 0);
    recordRun("summary", true, `${days}d: ${commits} commit(s), ${summary.journal.length} journal entr${summary.journal.length === 1 ? "y" : "ies"}`);
  },
};

/** Copies text to the system clipboard, keeping accents and symbols intact. */
function copyToClipboard(text: string): Promise<void> {
  // clip.exe garbles non-ASCII text sent as UTF-8; UTF-16 works. No byte order mark: clip.exe would paste it.
  const [command, args, input] =
    process.platform === "win32"
      ? ["clip.exe", [], Buffer.from(text, "utf16le")]
      : process.platform === "darwin"
        ? ["pbcopy", [], Buffer.from(text, "utf8")]
        : ["sh", ["-c", "wl-copy 2>/dev/null || xclip -selection clipboard"], Buffer.from(text, "utf8")];
  return new Promise((resolve, reject) => {
    const child = spawn(command as string, args as string[], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
    child.stdin.end(input);
  });
}

async function year(y: number, values: { copy?: boolean; save?: boolean; open?: boolean; json?: boolean; github?: boolean; "all-authors"?: boolean }): Promise<void> {
  if (!Number.isInteger(y) || y < 1990) throw new UsageError("--year takes a year, e.g. --year 2025.");
  if (!values.json) process.stderr.write(c.dim(`Reading a year of commits${values.github ? " and pull requests" : ""}…\n`));
  const config = loadConfig();
  const review = await buildYearReview(y, { config, allAuthors: values["all-authors"], github: values.github });
  if (values.json) {
    const { summary, ...rest } = review;
    console.log(JSON.stringify({ ...rest, journal: summary.journal.length, github: summary.github }, null, 2));
    return;
  }
  const markdown = formatYearReview(review);
  console.log(markdown);
  if (review.summary.github && "error" in review.summary.github) warn(`No pull requests: ${review.summary.github.error}`);
  if (values.copy) {
    try {
      await copyToClipboard(markdown);
      ok("Copied to the clipboard");
    } catch (err) {
      warn(`Couldn't copy to the clipboard: ${(err as Error).message}`);
    }
  }
  if (values.save || values.open) {
    const file = saveYearReview(markdown, y);
    ok(`Saved ${tildify(file)}`);
    if (values.open) await openInEditor(file, config.editor);
  }
  recordRun("summary", true, `${y} in review: ${review.commits} commit(s)`);
}
