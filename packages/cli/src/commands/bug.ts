import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ensureDashboard } from "@dx/web/link";
import { BUG_MAX_BYTES, bugBundleFileName, exportBugBundle, findProjects, loadConfig, readBugBundle, readProject, recordRun, scanProjects, type Project } from "@dx/core";
import type { Command } from "../command.js";
import { c, info, ok, UsageError, warn } from "../ui.js";

interface ReplayJob {
  id: string;
  phase: string;
  step: string;
  target: string;
  url?: string;
  error?: string;
  verdict?: { reproduced: boolean; summary: string; now: string[] };
}

export const bugCommand: Command = {
  name: "bug",
  summary: "Bug bundles: one file with an error's steps, requests and commit, for a teammate to replay",
  usage: [
    "dx bug export <project> <event-id> [file]   write the error's bundle (.dxbug.json)",
    "dx bug replay <file> [project]              run its commit as a snapshot and replay its steps",
    "",
    "  --working     replay on your working copy instead of the bundle's commit",
    "",
    "The event id is in dx activity --json, or use Download bug bundle on the Activity page.",
    "A bundle has no host, no cookies or tokens, no .env values and no paths from your computer:",
    "bodies are masked, and file paths in stacks are relative to the project. Replaying runs the",
    "steps only on the project's own dev server here.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { working: { type: "boolean" } } });
    const [action, ...rest] = positionals;
    if (action === "export") {
      const [where, rawId, file] = rest;
      if (!where || !rawId) throw new UsageError("dx bug export <project> <event-id> [file]");
      const project = resolve(where);
      const bundle = await exportBugBundle(project, Number(rawId)).catch((err: Error) => {
        throw new UsageError(err.message);
      });
      const out = path.resolve(file ?? bugBundleFileName(bundle));
      fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n", "utf8");
      recordRun("bug-bundle", true, `${project.name}: exported ${bundle.error.text.split(/\r?\n/)[0].slice(0, 80)}`, "cli", { project: project.name });
      ok(`Wrote ${path.basename(out)}: ${bundle.steps.length} step(s), ${bundle.events.length} event(s)${bundle.git ? `, at ${bundle.git.commit.slice(0, 7)}${bundle.git.dirty ? " (with uncommitted changes)" : ""}` : ""}.`);
      return;
    }
    if (action === "replay") {
      const [file, where] = rest;
      if (!file) throw new UsageError("dx bug replay <file> [project]");
      const size = fs.statSync(file).size;
      if (size > BUG_MAX_BYTES) throw new UsageError(`That bundle is too large (over ${BUG_MAX_BYTES / 1024 / 1024} MB).`);
      const bundle = (() => {
        try {
          return readBugBundle(fs.readFileSync(file, "utf8"));
        } catch (err) {
          throw new UsageError((err as Error).message);
        }
      })();
      const project = where ? resolve(where) : byName(bundle.project.name);
      const use = values.working || !bundle.git ? "working" : "commit";
      info(`${c.bold(bundle.error.text.split(/\r?\n/)[0])}`);
      info(`Replaying on ${project.name} at ${use === "commit" ? bundle.git!.commit.slice(0, 7) : "your working copy"}`);
      const client = await ensureDashboard();
      let job = await client.post<ReplayJob>("/api/activity/bundle/replay", { dir: project.dir, bundle, use });
      let step = "";
      for (;;) {
        job = await client.get<ReplayJob>(`/api/activity/bundle/replay?id=${job.id}`);
        if (job.step !== step && job.phase !== "done") info((step = job.step));
        if (job.phase === "failed") {
          warn(job.error ?? "The replay failed.");
          return 1;
        }
        if (job.phase === "done") break;
        await new Promise((r) => setTimeout(r, 700));
      }
      const v = job.verdict!;
      (v.reproduced ? ok : info)(v.summary);
      for (const line of v.now.slice(0, 10)) console.log(c.dim(`  ${line}`));
      return;
    }
    throw new UsageError("dx bug export <project> <event-id> [file], or dx bug replay <file> [project]");
  },
};

function resolve(query: string): Project {
  if (query === ".") {
    const here = readProject(process.cwd());
    if (here) return here;
    throw new UsageError("This folder isn't a project. Give a project's name.");
  }
  const { match, candidates } = findProjects(query, scanProjects(loadConfig()));
  const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (project) return project;
  throw new UsageError(candidates.length ? `Several projects match "${query}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}` : `No project matches "${query}".`);
}

function byName(name: string): Project {
  const found = scanProjects(loadConfig()).filter((p) => p.name.toLowerCase() === name.toLowerCase());
  if (found.length === 1) return found[0];
  throw new UsageError(found.length ? `Several projects are called ${name}: say which, dx bug replay <file> <project>.` : `The bundle is from ${name}, which isn't in your projects folders. Say which project: dx bug replay <file> <project>.`);
}
