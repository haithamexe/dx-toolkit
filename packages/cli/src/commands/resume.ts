import { parseArgs } from "node:util";
import {
  findProjects,
  findUnsavedWork,
  leaveNote,
  loadConfig,
  readProject,
  recordRun,
  resumeInfo,
  scanProjects,
  type Project,
  type ResumeInfo,
  type UnsavedWork,
} from "@dx/core";
import type { Command } from "../command.js";
import { c, info, ok, relativeTime, tildify, UsageError } from "../ui.js";

function resolveProject(query: string): Project {
  if (!query || query === ".") {
    const here = readProject(process.cwd());
    if (here) return here;
    const recent = scanProjects(loadConfig())[0];
    if (!query && recent) return recent;
    throw new UsageError("Which project? Give its name, or run this inside its folder.");
  }
  const { match, candidates } = findProjects(query, scanProjects(loadConfig()));
  const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (project) return project;
  throw new UsageError(candidates.length ? `Several projects match "${query}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}` : `No project matches "${query}".`);
}

export const resumeCommand: Command = {
  name: "resume",
  aliases: ["where"],
  summary: "Where you left off in a project: when, which branch, what ran, your last note",
  usage: [
    "dx resume [project]                  where you left off (the project here, or your latest)",
    'dx resume [project] --note "text"    leave a note for next time: what you were doing, the next step',
    "dx resume [project] --clear          remove the note",
    "dx resume --json                     as JSON",
    "",
    "dx go shows this too when you come back to a project after a while.",
    "AI agents read and leave the same notes through the resume_project and leave_note MCP tools.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { note: { type: "string", short: "n" }, clear: { type: "boolean" }, json: { type: "boolean" } },
    });
    const project = resolveProject(positionals.join(" ").trim());
    if (values.note !== undefined || values.clear) {
      leaveNote(project.dir, project.name, values.clear ? "" : values.note ?? "", "you");
      recordRun("resume", true, `${project.name}: note ${values.clear ? "removed" : "left"}`, "cli", { project: project.name });
      ok(values.clear ? `Removed the note on ${project.name}` : `Noted for next time in ${project.name}`);
      return;
    }
    const r = resumeInfo(project);
    if (values.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    console.log(`${c.bold(project.name)} ${c.dim(tildify(project.dir))}`);
    if (!printResume(r, true)) info("dx has no record of working on it yet. dx go starts one.");
  },
};

/** Prints where you left off. Returns false when there's nothing to say. */
export function printResume(r: ResumeInfo, always = false): boolean {
  const s = r.session;
  const lines: string[] = [];
  if (s) {
    const when = relativeTime(Date.parse(s.at));
    lines.push(`Last here ${when}${s.branch ? ` on ${c.cyan(s.branch)}` : ""}${s.ran?.length && s.ran[0] !== "dev" ? `, running ${s.ran.join(" + ")}` : ""}`);
    if (s.note) lines.push(`${c.yellow("Note")}${s.noteBy === "ai" ? c.dim(" (from your AI agent)") : ""}: ${s.note}`);
    if (s.openErrors?.length) lines.push(`Errors when it stopped: ${s.openErrors.slice(0, 3).join("; ")}`);
  }
  if (r.branchThen) lines.push(`${c.yellow("!")} You were on ${c.cyan(r.branchThen)}; now on ${c.cyan(r.branch ?? "?")}. git switch ${r.branchThen} to go back.`);
  if (r.newCommits) lines.push(`${r.newCommits} new commit(s) since then${r.lastCommit ? `, the latest: ${r.lastCommit.subject}` : ""}`);
  else if (always && r.lastCommit) lines.push(`Last commit ${relativeTime(Date.parse(r.lastCommit.at))}: ${r.lastCommit.subject}`);
  if (r.uncommitted.length) lines.push(`${r.uncommitted.length} uncommitted file(s): ${r.uncommitted.slice(0, 5).join(", ")}${r.uncommitted.length > 5 ? ", …" : ""}`);
  for (const e of r.journal) lines.push(`${c.dim(`Journal ${e.date}:`)} ${e.text}`);
  if (!lines.length) return false;
  for (const l of lines) console.log(`  ${l}`);
  return true;
}

export const statusCommand: Command = {
  name: "status",
  aliases: ["unsaved"],
  summary: "Work that exists only on this computer: uncommitted, unpushed, stashed, no remote",
  usage: [
    "dx status          projects with uncommitted changes, unpushed commits, stashes or no remote",
    "dx status --all    every git project, saved or not",
    "dx status --json   as JSON",
    "",
    "What would be lost if this computer died tonight, most at risk first.",
  ].join("\n"),
  async run(argv) {
    const { values } = parseArgs({ args: argv, options: { all: { type: "boolean" }, json: { type: "boolean" } } });
    const progress = Boolean(process.stderr.isTTY) && !values.json;
    const list = await findUnsavedWork({
      all: values.all,
      onProgress: progress ? (d, t) => process.stderr.write(`\r\x1b[2K${c.dim(`Checking ${d}/${t}`)}`) : undefined,
    });
    if (progress) process.stderr.write("\r\x1b[2K");
    if (values.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    if (!list.length) {
      ok("Everything is committed and pushed.");
      return;
    }
    for (const w of list) {
      const parts = describeUnsaved(w);
      console.log(`${parts.length ? c.yellow("!") : c.green("✓")} ${c.bold(w.project)}${w.branch ? c.dim(` (${w.branch})`) : ""}  ${parts.join(c.dim(" · ")) || "saved"}`);
    }
    const risky = list.filter((w) => w.unpushed || w.noRemote).length;
    if (risky) console.log(c.dim(`\n${risky} project(s) have commits no remote has: git push, or add a remote.`));
  },
};

export function describeUnsaved(w: UnsavedWork): string[] {
  const parts: string[] = [];
  if (w.noRemote) parts.push(c.red("no remote"));
  if (w.unpushed) parts.push(c.red(`${w.unpushed} unpushed commit(s)${w.unpushedBranches.length ? ` on ${w.unpushedBranches.slice(0, 3).join(", ")}` : ""}`));
  if (w.changed) parts.push(`${w.changed} changed file(s)`);
  if (w.untracked) parts.push(`${w.untracked} new file(s)`);
  if (w.stashes) parts.push(`${w.stashes} stash(es)${w.oldestStash ? `, oldest ${relativeTime(Date.parse(w.oldestStash))}` : ""}`);
  return parts;
}


