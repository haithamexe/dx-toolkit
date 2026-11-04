import { parseArgs } from "node:util";
import { ensureDashboard, findDashboard } from "@dx/web/link";
import { findProjects, listSnapshots, loadConfig, readProject, recordRun, removeSnapshot, scanProjects, searchCommits, type Project } from "@dx/core";
import type { Command } from "../command.js";
import { projectLabel } from "./projects.js";
import { follow } from "./stack.js";
import { c, info, ok, pick, relativeTime, table, tildify, truncate, UsageError, warn } from "../ui.js";

interface SnapshotView {
  id: string;
  name: string;
  dir: string;
  subject: string;
  job?: { phase: string; step: string; lines: string[]; count: number; error?: string };
  dev?: { status: string; url?: string };
}

export const runCommand: Command = {
  name: "run",
  summary: "Run a project as it was at any commit, next to your own dev server",
  usage: [
    "dx run <project> <commit>     check out that commit under ~/.dx/snapshots and run its dev server here",
    "dx run . abc1234              the project in this folder",
    'dx run shop "cart page"       a commit found by its message, author or a file it changed',
    "dx run --list                 the snapshots on this computer",
    "dx run --remove <id>          stop one and delete its folder (your working copy isn't touched)",
    "",
    "  --no-browser     don't open the browser when it's ready",
    "",
    "Packages are linked from the project when the lock file is the same, installed otherwise.",
    "It runs on a port of its own, so the project's usual dev server keeps running. Ctrl+C stops it.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: { list: { type: "boolean" }, remove: { type: "string" }, browser: { type: "boolean", default: true } },
    });

    if (values.list) {
      const list = listSnapshots();
      if (!list.length) return info("No snapshots. Run one with: dx run <project> <commit>");
      console.log(table(["ID", "COMMIT", "MADE", "FOLDER"], list.map((s) => [s.id, truncate(s.subject, 40), relativeTime(Date.parse(s.createdAt)), tildify(s.path)])));
      return;
    }

    if (values.remove !== undefined) {
      const id = values.remove;
      const dashboard = await findDashboard();
      // Through the dashboard when it runs, so a snapshot's server there is stopped first.
      if (dashboard) {
        const r = await dashboard.post<{ message: string }>("/api/snapshots/remove", { id });
        ok(r.message);
      } else {
        const s = await removeSnapshot(id);
        recordRun("snapshot", true, `${s.name} removed`, "cli", { project: s.project });
        ok(`Removed ${s.name}. Your working copy wasn't touched.`);
      }
      return;
    }

    const [where, ...words] = positionals;
    const query = words.join(" ").trim();
    if (!where || !query) throw new UsageError("Which project and which commit? dx run <project> <commit>");
    const project = where === "." ? readProject(process.cwd()) : await chooseProject(where);
    if (!project) return 1;
    if (!project.hasGit) throw new UsageError(`${project.name} isn't a git repository.`);

    const hash = /^[0-9a-f]{4,40}$/i.test(query) ? query : await chooseCommit(project, query);
    if (!hash) return 1;

    const client = await ensureDashboard();
    let view = await client.post<SnapshotView>("/api/snapshots/run", { dir: project.dir, hash, by: "terminal" });
    info(`${c.bold(view.name)}  ${view.subject}`);
    let step = "";
    let printed = 0;
    for (;;) {
      const list = await client.get<SnapshotView[]>(`/api/snapshots?dir=${encodeURIComponent(project.dir)}`);
      view = list.find((s) => s.id === view.id) ?? view;
      if (view.job && view.job.step !== step) {
        step = view.job.step;
        info(step);
      }
      if (view.job && view.job.count > printed) {
        for (const l of view.job.lines.slice(-Math.min(view.job.lines.length, view.job.count - printed))) console.log(c.dim(`  ${l}`));
        printed = view.job.count;
      }
      if (view.job?.phase === "failed") {
        warn(view.job.error ?? "It couldn't be set up.");
        return 1;
      }
      if (!view.job && view.dev && view.dir) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    info(`From ${tildify(view.dir)}  ${c.dim("(Ctrl+C stops it; dx run --remove " + view.id + " deletes it)")}\n`);
    return follow(client, { name: view.name, dir: view.dir } as Project, values.browser);
  },
};

async function chooseProject(query: string): Promise<Project | undefined> {
  const projects = scanProjects(loadConfig());
  const { match, candidates } = findProjects(query, projects);
  if (match) return match;
  if (!candidates.length) {
    console.log(`No project matches "${query}". See them all with: dx projects`);
    return undefined;
  }
  if (candidates.length === 1) return candidates[0];
  console.log(`Several projects match "${query}":`);
  return pick(candidates.slice(0, 12), projectLabel);
}

async function chooseCommit(project: Project, query: string): Promise<string | undefined> {
  const found = await searchCommits(project.dir, query, { limit: 12 });
  if (!found.length) {
    console.log(`No commit in ${project.name} matches "${query}".`);
    return undefined;
  }
  if (found.length === 1) return found[0].hash;
  console.log(`Commits matching "${query}":`);
  const picked = await pick(found, (m) => `${c.cyan(m.short)}  ${truncate(m.subject, 60)}  ${c.dim(`${m.author}, ${relativeTime(m.at)}`)}`);
  return picked?.hash;
}
