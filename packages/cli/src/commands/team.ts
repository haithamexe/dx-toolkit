import { parseArgs } from "node:util";
import { addProofToPr, findProjects, loadConfig, prProof, projectTour, readActivity, readProject, recordRun, scanProjects, setQueryLog, queryLogState, queryReport, tourMarkdown, type Project, type UpgradeReport } from "@dx/core";
import { ensureDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, info, ok, UsageError } from "../ui.js";

function resolve(query: string): Project {
  if (!query || query === ".") {
    const here = readProject(process.cwd());
    if (here) return here;
    throw new UsageError("Which project? Give its name, or run this inside its folder.");
  }
  const { match, candidates } = findProjects(query, scanProjects(loadConfig()));
  const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (project) return project;
  throw new UsageError(candidates.length ? `Several projects match "${query}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}` : `No project matches "${query}".`);
}

export const tourCommand: Command = {
  name: "tour",
  summary: "A map of a project for someone new to it: how to run it, its pages and calls, files, data, settings",
  usage: ["dx tour [project]            the tour as Markdown (dx tour shop-website > TOUR.md to keep it)", "dx tour [project] --json"].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" }, days: { type: "string" } } });
    const project = resolve(positionals.join(" "));
    const tour = projectTour(project, { days: values.days ? Number(values.days) : undefined });
    if (values.json) return console.log(JSON.stringify(tour, null, 2));
    console.log(tourMarkdown(tour));
  },
};

export const proofCommand: Command = {
  name: "proof",
  summary: "How this branch was tested, for its pull request: tests, pages tried, errors, visual, speed and dx's checks",
  usage: ["dx proof [project]           the Markdown section, to paste into the pull request", "dx proof [project] --pr      put it into the branch's open pull request (GitHub CLI)"].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { pr: { type: "boolean" }, json: { type: "boolean" } } });
    const project = resolve(positionals.join(" "));
    const proof = await prProof(project);
    if (values.json) return console.log(JSON.stringify(proof, null, 2));
    if (!values.pr) {
      console.log(proof.markdown);
      return info("dx proof --pr puts it into the branch's pull request.");
    }
    const pr = await addProofToPr(project.dir, proof.markdown);
    recordRun("proof", true, `${project.name}: added to pull request #${pr.number}`, "cli", { project: project.name });
    ok(`Added to pull request #${pr.number}: ${pr.url}`);
  },
};

export const tryCommand: Command = {
  name: "try",
  summary: "Try a package upgrade in a copy of the project: type check, build, tests and pages, before and after",
  usage: [
    "dx try <project> <package>[@version]   e.g. dx try shop-website react@19, or next (the latest)",
    "",
    "The copy is the project as it is now (uncommitted changes included) under ~/.dx/snapshots: your",
    "own folder and node_modules aren't touched. Its pages are compared with your running app, so",
    "the dashboard starts in the background and the dev server is started when needed.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { path: { type: "string", short: "p" }, json: { type: "boolean" } } });
    const spec = positionals.at(-1) ?? "";
    if (positionals.length < 2 || !spec) throw new UsageError("dx try <project> <package>[@version]");
    const at = spec.lastIndexOf("@");
    const name = at > 0 ? spec.slice(0, at) : spec;
    const version = at > 0 ? spec.slice(at + 1) : "latest";
    const project = resolve(positionals.slice(0, -1).join(" "));
    const client = await ensureDashboard();
    let job = await client.post<{ id: string; step: string; finishedAt?: string; error?: string; result?: UpgradeReport }>("/api/upgrade", { dir: project.dir, name, version, paths: values.path ? values.path.split(",").map((s) => s.trim()) : undefined });
    let said = "";
    while (!job.finishedAt) {
      if (job.step !== said) process.stderr.write(c.dim(`  ${job.step}\n`));
      said = job.step;
      await new Promise((r) => setTimeout(r, 1500));
      job = await client.get(`/api/chaos/job?id=${job.id}`);
    }
    if (job.error || !job.result) throw new Error(job.error ?? "The trial didn't finish.");
    const r = job.result;
    if (values.json) return console.log(JSON.stringify(r, null, 2));
    const mark = r.verdict === "breaks" ? c.red("breaks something") : r.verdict === "changes" ? c.yellow("changes things") : c.green("nothing changed that dx can see");
    console.log(`${c.bold(`${r.target.name} ${r.target.from ?? "?"} → ${r.target.to}`)}: ${mark}`);
    for (const s of r.summary) console.log(`  • ${s}`);
    for (const ch of r.checks) {
      const after = ch.after?.errors.filter((e) => !(ch.before?.errors ?? []).includes(e)) ?? [];
      for (const e of after.slice(0, 5)) console.log(c.dim(`    ${e}`));
    }
    info(`The copy is ${r.copy}; dx run lists it, and the Git page's Run any commit can remove it.`);
  },
};

export const queriesCommand: Command = {
  name: "queries",
  summary: "Database queries per request (N+1, slow queries), from the compose Postgres or MySQL's own log",
  usage: ["dx queries <project> on|off    switch the database's statement logging on or off", "dx queries <project>           what each request ran since it was switched on"].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { service: { type: "string" }, json: { type: "boolean" } } });
    const last = positionals.at(-1);
    if (last === "on" || last === "off") {
      const project = resolve(positionals.slice(0, -1).join(" "));
      const state = await setQueryLog(project, last === "on", { service: values.service });
      recordRun("queries", true, `${project.name}: query log ${last}`, "cli", { project: project.name });
      return last === "on" ? ok(`Logging ${state?.service}'s queries. Use the app through dx, then dx queries ${project.name}.`) : ok("Query logging is off: the database's setting is back to how it was.");
    }
    const project = resolve(positionals.join(" "));
    const state = queryLogState(project.dir);
    if (!state) return info(`Not logging queries for ${project.name}: dx queries ${project.name} on`);
    const r = await queryReport(project, readActivity({ dir: project.dir, since: new Date(Date.parse(state.since) - 60_000), limit: 50_000 }));
    if (values.json) return console.log(JSON.stringify(r, null, 2));
    console.log(c.dim(`${r.queries} queries in ${r.service} since ${new Date(r.since!).toLocaleTimeString()}, ${r.requests.length} requests ran some.`));
    if (r.note) info(r.note);
    for (const f of r.findings) console.log(`${f.kind === "n+1" ? c.red("● N+1") : c.yellow(f.kind === "slow" ? "● slow" : "● many")}  ${f.text}${f.shape ? c.dim(`\n    ${f.shape.slice(0, 200)}`) : ""}`);
    if (!r.findings.length && r.queries) ok("No N+1, slow queries or very busy requests.");
  },
};
