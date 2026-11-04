import { parseArgs } from "node:util";
import { findProjects, gitGraph, gitStatus, GitError, loadConfig, openUrl, readProject, scanProjects, type GitFileStatus, type GraphRow, type Project } from "@dx/core";
import { ensureDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, ok, relativeTime, truncate, UsageError } from "../ui.js";

export const gitCommand: Command = {
  name: "git",
  summary: "A project's branch, what's staged and changed, and its recent history as a graph",
  usage: [
    "dx git                 the project you're in",
    "dx git <project>       another project, by name",
    "dx git <project> -n 50 more of the history (default 20)",
    "dx git <project> --ui  the dashboard's Git page: drag changes to stage them, commit, browse the graph",
    "dx git --json          the status and the graph as JSON",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        limit: { type: "string", short: "n" },
        ui: { type: "boolean" },
        json: { type: "boolean" },
      },
    });
    const project = resolve(positionals.join(" ").trim() || ".");
    const limit = values.limit === undefined ? 20 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new UsageError("-n takes a number of commits from 1 to 2000.");

    if (values.ui) {
      const client = await ensureDashboard();
      const url = `${client.url.replace(/\/$/, "")}/#/git?dir=${encodeURIComponent(project.dir)}`;
      await openUrl(url);
      ok(`Opened ${project.name} on the dashboard's Git page.`);
      return;
    }

    let status, graph;
    try {
      [status, graph] = await Promise.all([gitStatus(project.dir), gitGraph(project.dir, { limit })]);
    } catch (err) {
      if (err instanceof GitError) throw new UsageError(`${project.name}: ${err.message}`);
      throw err;
    }
    if (values.json) {
      console.log(JSON.stringify({ project: project.name, status, graph }, null, 2));
      return;
    }

    const sync = !status.upstream
      ? c.dim(status.hasCommits ? "no upstream" : "no commits yet")
      : status.ahead || status.behind
        ? [status.ahead ? c.yellow(`${status.ahead} to push`) : "", status.behind ? c.cyan(`${status.behind} to pull`) : ""].filter(Boolean).join(", ") + c.dim(` (${status.upstream})`)
        : c.dim(`up to date with ${status.upstream}`);
    console.log(`${c.bold(project.name)}  ${c.cyan(status.detached ? "detached HEAD" : (status.branch ?? "no branch"))}  ${sync}`);

    const staged = status.files.filter((f) => f.staged);
    const changed = status.files.filter((f) => f.unstaged);
    const list = (title: string, files: GitFileStatus[], side: "index" | "worktree") => {
      if (!files.length) return;
      console.log(`\n${c.bold(title)} ${c.dim(`(${files.length})`)}`);
      for (const f of files.slice(0, 30)) console.log(`  ${code(f, side)} ${f.path}${f.from ? c.dim(` ← ${f.from}`) : ""}`);
      if (files.length > 30) console.log(c.dim(`  … and ${files.length - 30} more`));
    };
    list("Staged", staged, "index");
    list("Changes", changed, "worktree");
    if (!staged.length && !changed.length) console.log(c.dim("\nNothing changed since the last commit."));

    if (graph.commits.length) {
      console.log(`\n${c.bold("History")}`);
      const width = Math.min(8, graph.width);
      for (const commit of graph.commits) {
        const refs = commit.refs.map((r) => (r.current ? c.cyan(r.name) : r.kind === "tag" ? c.yellow(`tag ${r.name}`) : r.kind === "remote" ? c.dim(r.name) : r.name));
        console.log(
          `  ${lanes(commit.row, width, commit.parents.length > 1)} ${c.dim(commit.short)} ${truncate(commit.subject, 72)}${refs.length ? ` ${c.dim("(")}${refs.join(c.dim(", "))}${c.dim(")")}` : ""} ${c.dim(`${commit.author}, ${relativeTime(commit.at)}`)}`,
        );
      }
      if (graph.more) console.log(c.dim(`  … older commits: dx git ${project.name} -n ${limit * 2}`));
    }
    console.log(c.dim(`\nStage, commit and browse by dragging: dx git ${project.name} --ui`));
  },
};

/** One row of the graph as characters: ● the commit (○ a merge), │ a lane going past, ╮ a branch opening below, ╯ one ending here. */
function lanes(row: GraphRow, width: number, merge: boolean): string {
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    if (i === row.lane) out.push(c.cyan(merge ? "○" : "●"));
    else if (row.through.includes(i)) out.push(c.dim("│"));
    else if (row.down.includes(i)) out.push(c.dim("╮"));
    else if (row.up.includes(i) || row.moves.some(([from]) => from === i)) out.push(c.dim("╯"));
    else out.push(" ");
  }
  return out.join(" ");
}

function code(f: GitFileStatus, side: "index" | "worktree"): string {
  if (f.conflicted) return c.red("U");
  if (f.untracked) return c.green("N");
  const letter = f[side];
  return letter === "D" ? c.red(letter) : letter === "A" ? c.green(letter) : letter === "M" ? c.yellow(letter) : c.cyan(letter);
}

function resolve(query: string): Project {
  if (query === ".") {
    const here = readProject(process.cwd());
    if (here) return here;
    throw new UsageError("This folder isn't a project. Give a project's name: dx git <project>.");
  }
  const { match, candidates } = findProjects(query, scanProjects(loadConfig()));
  const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (project) return project;
  throw new UsageError(candidates.length ? `Several projects match "${query}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}` : `No project matches "${query}".`);
}
