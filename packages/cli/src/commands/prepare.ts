import { parseArgs } from "node:util";
import { detectStack, findProjects, forgetPrepared, loadConfig, planPrepare, readProject, recordRun, runPrepare, scanProjects, type PrepareStep, type Project } from "@dx/core";
import type { Command } from "../command.js";
import { c, info, ok, UsageError } from "../ui.js";

export const prepareCommand: Command = {
  name: "prepare",
  aliases: ["setup-project"],
  summary: "What a project needs before it runs (packages, .env, Docker, migrations…), and getting it ready",
  usage: [
    "dx prepare <project>          what Run will do first, and why",
    "dx prepare <project> --run    do it now",
    "dx prepare <project> --again  forget what was done, so every step runs (with --run: now)",
    "",
    "Run (dx go, dx up, the dashboard, AI agents) does this by itself before every start: packages",
    "installed when they're missing or the lock file changed, .env made from its example, Docker",
    "running for a stack's databases, Prisma generated, workspace packages built, migrations applied",
    "(only to a database on this computer), and the usual port free. Add your own steps in",
    '.devrc.json: { "prepare": ["npm run codegen", { "run": "npm run seed", "after": "db" }] },',
    'or turn it off with { "prepare": false }.',
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { run: { type: "boolean" }, again: { type: "boolean" } } });
    const where = positionals.join(" ").trim();
    if (!where) throw new UsageError("Which project? dx prepare <project> (. for the one you're in)");
    const project = resolve(where);
    if (values.again) forgetPrepared(project.dir);
    const stack = detectStack(project);
    const steps = planPrepare(project, {
      force: values.again,
      docker: !!stack?.services.some((s) => s.kind === "docker"),
      extraDirs: stack ? [...new Set(stack.services.filter((s) => s.kind === "process").map((s) => s.dir))] : undefined,
    });
    if (!steps.length) return info(`${project.name} needs nothing before it runs (or .devrc.json turns this off).`);
    if (!values.run) {
      for (const s of steps) console.log(`${mark(s)} ${s.title}${c.dim(` · ${s.why}`)}${s.fix && (s.status === "warn" || s.status === "skip") ? `\n    ${c.dim(s.fix)}` : ""}`);
      // Docker and the port are checks made on every start, not work.
      const todo = steps.filter((s) => s.status === "todo" && s.action !== "docker" && s.action !== "port").length;
      console.log(c.dim(`\n${todo ? `${todo} step(s) to do. dx prepare ${where} --run does them now; Run does them by itself.` : "Nothing to do: it's ready (Docker and the port are checked on every start)."}`));
      return;
    }
    const log = (line: string) => console.log(/^[▸✓✗!]/.test(line) ? line : c.dim(`  ${line}`));
    let r = await runPrepare(steps, project.dir, "before", { log });
    // The database steps need the stack's Docker databases up, which only Run starts.
    if (r.ok && !stack?.services.some((s) => s.kind === "docker")) r = await runPrepare(steps, project.dir, "db", { log });
    recordRun("prepare", r.ok, `${project.name}: ${r.ok ? "ready" : `${r.failed!.title} failed`}`, "cli", { project: project.name });
    if (!r.ok) throw new UsageError(`${r.failed!.title} failed (${r.failed!.why}).${r.failed!.fix ? ` ${r.failed!.fix}.` : ""}`);
    ok(`${project.name} is ready to run.${steps.some((s) => s.phase === "db" && s.status === "todo") ? " Migrations run when Run has started its databases." : ""}`);
  },
};

function mark(s: PrepareStep): string {
  return { ok: c.green("✓"), done: c.green("✓"), todo: c.cyan("○"), warn: c.yellow("!"), skip: c.dim("–"), failed: c.red("✗"), running: c.cyan("…") }[s.status] ?? "·";
}

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
