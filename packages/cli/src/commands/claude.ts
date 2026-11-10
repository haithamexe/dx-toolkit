import { parseArgs } from "node:util";
import { applyClaudeSetup, claudeSetupState, findProjects, loadConfig, readProject, scanProjects, undoClaudeSetup, type Project } from "@dx/core";
import type { Command } from "../command.js";
import { runHook } from "../hook.js";
import { c, info, ok, UsageError, warn } from "../ui.js";

export const claudeCommand: Command = {
  name: "claude",
  summary: "Make a project's Claude Code sessions use dx to run, test and check the app",
  usage: [
    "dx claude [project]          set up the project here, or the one named",
    "dx claude --all              every project dx knows",
    "dx claude [project] --undo   take it all back out",
    "dx claude [project] --status say what's set up",
    "",
    "Three local things, none of them committed (both files are in the repository's own",
    ".git/info/exclude, never its .gitignore):",
    "  CLAUDE.local.md              a note naming the dx tools to use here, with this project's own commands",
    "  .claude/settings.local.json  the dx tools that read or run the project's own tests and dev server allowed",
    "                               without asking (commits, deletes and .env values still ask), and a hint hook:",
    "                               when Claude is about to run a test or dev command in a shell, it's told to use",
    "                               dx's tool instead. It only nudges: the command still runs and still asks.",
    "What was already in those files is kept, and --undo removes only what dx added.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: "boolean" }, undo: { type: "boolean" }, status: { type: "boolean" } } });
    const projects = pick(positionals.join(" ").trim(), !!values.all);
    let failed = 0;
    for (const p of projects) {
      try {
        if (values.status) {
          const s = claudeSetupState(p.dir);
          console.log(`${p.name.padEnd(28)} ${s.on ? c.green("set up") : s.note || s.permissions || s.hook ? c.yellow("partly") : c.dim("not set up")}`);
        } else if (values.undo) {
          const gone = undoClaudeSetup(p);
          (gone.length ? ok : info)(gone.length ? `${p.name}: removed ${gone.join(", ")}` : `${p.name}: nothing of dx's to remove`);
        } else {
          const did = applyClaudeSetup(p);
          (did.length ? ok : info)(did.length ? `${p.name}: ${did.join("; ")}` : `${p.name}: already set up`);
        }
      } catch (err) {
        failed++;
        warn(`${p.name}: ${(err as Error).message}`);
      }
    }
    if (!values.status && !values.undo && projects.length && !failed) info(c.dim("Start a new Claude Code session in the project to pick it up. Undo: dx claude --undo"));
    return failed ? 1 : 0;
  },
};

function pick(query: string, all: boolean): Project[] {
  if (all) return scanProjects(loadConfig());
  if (!query || query === ".") {
    const here = readProject(process.cwd());
    if (here) return [here];
    throw new UsageError("Which project? Give its name, run this inside its folder, or use --all.");
  }
  const { match, candidates } = findProjects(query, scanProjects(loadConfig()));
  const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (project) return [project];
  throw new UsageError(candidates.length ? `Several projects match "${query}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}` : `No project matches "${query}".`);
}

/** The command in a project's .claude/settings.local.json, run by Claude Code: see ../hook.ts, which index.ts runs without loading the rest of the CLI. */
export const hookCommand: Command = {
  name: "hook",
  summary: "For Claude Code's settings: a hint before a shell test or dev command (not run by hand)",
  usage: ["dx hook pre-bash   reads Claude Code's JSON on stdin, prints guidance or nothing", "Set up for a project by `dx claude`."].join("\n"),
  run: (argv) => runHook(argv),
};
