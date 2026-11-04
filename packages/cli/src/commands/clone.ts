import path from "node:path";
import { parseArgs } from "node:util";
import { addGitignoreRules, auditEnv, checkEnv, cloneProject, findProjects, loadConfig, readProject, recordRun, scanProjects, type EnvReport, type Project, type ProjectEnv } from "@dx/core";
import type { Command } from "../command.js";
import { goCommand } from "./go.js";
import { c, info, ok, tildify, UsageError, warn } from "../ui.js";

export const cloneCommand: Command = {
  name: "clone",
  aliases: ["get"],
  summary: "Set up a repository in one go: clone, install, create .env, then open and run it",
  usage: [
    "dx clone <git URL or owner/repo> [options]",
    "",
    "  --name <folder>   folder name (default: the repository's name)",
    "  --root <folder>   where to put it (default: your first projects folder)",
    "  --no-install      don't install packages",
    "  --no-open         don't open it in the editor or start it afterwards",
    "  --json            print the result as JSON",
    "",
    "Packages are installed with the tool the repository uses (npm, pnpm, yarn, bun, pip, uv, go),",
    "and .env is created from .env.example. Variables that still need a value are listed at the end.",
    "Example: dx clone octocat/todo-app",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        name: { type: "string" },
        root: { type: "string" },
        install: { type: "boolean", default: true },
        open: { type: "boolean", default: true },
        json: { type: "boolean" },
      },
    });
    const url = positionals[0];
    if (!url) throw new UsageError("Give the repository: a git URL, or owner/repo for GitHub.");
    const quiet = Boolean(values.json);
    const result = await cloneProject({
      url,
      name: values.name,
      root: values.root ? path.resolve(values.root) : undefined,
      install: values.install,
      interactive: Boolean(process.stdin.isTTY) && !quiet,
      onStep: quiet ? undefined : (s) => console.log(`\n${c.bold(s)}`),
      onOutput: quiet ? undefined : (l) => console.log(c.dim(`  ${l}`)),
    });
    if (quiet) {
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }

    console.log("");
    for (const s of result.steps) {
      if (s.ok) ok(`${s.name}: ${s.detail ?? "done"}`);
      else warn(`${s.name}: ${s.detail ?? "failed"}${s.fix ? `\n    ${c.dim(s.fix)}` : ""}`);
    }
    if (result.runs) info(`It runs: ${result.runs}`);
    console.log(`\n${c.bold(result.name)} is in ${tildify(result.dir)}`);

    if (!values.open || !result.project) return result.ok ? 0 : 1;
    if (!result.ok) {
      warn(`Not starting it, since a step failed. Fix it, then: dx go ${result.name}`);
      return 1;
    }
    console.log("");
    process.chdir(result.dir);
    return goCommand.run(["."]);
  },
};

export const envCommand: Command = {
  name: "env",
  summary: "Check a project's .env against .env.example, and look for committed keys and tokens",
  usage: [
    "dx env [project]    the project in this folder, or the one named",
    "dx env --all        every project",
    "dx env --json       as JSON",
    "dx env --gitignore  add what .gitignore is missing to keep secrets out of git (with --all, to every project)",
    "",
    "Lists variables .env.example has that your .env files don't set, .env files git would commit,",
    "API keys, tokens and private keys in files git tracks, and the .gitignore rules OWASP recommends",
    "that the project doesn't have (.env files, private keys, certificates, keystores).",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: "boolean" }, json: { type: "boolean" }, gitignore: { type: "boolean" } } });
    const projects = values.all ? scanProjects(loadConfig()) : [resolveOne(positionals.join(" "))];
    if (values.gitignore) {
      for (const p of projects) {
        const missing = auditEnv(p.dir).rules.filter((r) => !r.covered).map((r) => r.pattern);
        if (!missing.length) continue;
        const added = addGitignoreRules(p.dir, missing);
        recordRun("env", true, `${p.name}: .gitignore now ignores ${added.join(", ")}`, "cli", { project: p.name });
        ok(`${p.name}: added ${added.join(", ")} to .gitignore`);
      }
    }
    const reports = projects.map((p) => ({ project: p.name, ...checkEnv(p.dir), gitignore: auditEnv(p.dir) }));
    if (values.json) {
      console.log(JSON.stringify(reports.map(({ gitignore, ...r }) => ({ ...r, hasGitignore: gitignore.gitignore, missingGitignoreRules: gitignore.rules.filter((x) => !x.covered).map((x) => x.pattern) })), null, 2));
      return reports.some((r) => hasProblems(r) || gitignoreProblems(r.gitignore)) ? 1 : 0;
    }
    let shown = 0;
    for (const r of reports) {
      if (values.all && !hasProblems(r) && !gitignoreProblems(r.gitignore)) continue;
      shown++;
      printReport(r.project, r);
      printGitignore(r.gitignore);
    }
    if (values.all) {
      console.log(shown ? "" : `${c.green("✓")} No problems in ${reports.length} project(s).`);
    }
    return reports.some((r) => hasProblems(r) || gitignoreProblems(r.gitignore)) ? 1 : 0;
  },
};

function gitignoreProblems(a: ProjectEnv): boolean {
  return !a.gitignore || a.exampleIgnored || a.rules.some((r) => !r.covered);
}

function printGitignore(a: ProjectEnv): void {
  const missing = a.rules.filter((r) => !r.covered);
  if (!a.gitignore) warn("No .gitignore: git add . would commit everything, .env files and keys included.");
  if (a.exampleIgnored) warn(".env.example is ignored too, so the list of variables isn't shared. Add !.env.example.");
  if (missing.length) {
    warn(`.gitignore is missing what keeps secrets out of git (OWASP):`);
    for (const r of missing) console.log(`    ${r.pattern.padEnd(14)} ${c.dim(r.why)}`);
    console.log(c.dim(`  dx env ${path.basename(a.dir)} --gitignore adds them.`));
  } else if (a.gitignore) ok(".gitignore covers .env files, private keys, certificates and keystores");
}

function resolveOne(query: string): Project {
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

export function hasProblems(r: EnvReport): boolean {
  return r.missing.length > 0 || r.empty.length > 0 || r.tracked.length > 0 || r.notIgnored.length > 0 || r.secrets.length > 0;
}

function printReport(name: string, r: EnvReport): void {
  console.log(`\n${c.bold(name)} ${c.dim(tildify(r.dir))}`);
  if (r.exampleFile) {
    if (!r.envFiles.length) warn(`No .env yet. Create it from ${path.basename(r.exampleFile)}: copy it to .env and fill it in.`);
    if (r.missing.length) warn(`Not set in any .env file: ${r.missing.join(", ")}`);
    if (r.empty.length) warn(`Set but empty: ${r.empty.join(", ")}`);
    if (!r.missing.length && !r.empty.length && r.envFiles.length) ok(`Every variable in ${path.basename(r.exampleFile)} has a value`);
  } else if (r.envFiles.length) {
    info("No .env.example to compare with");
  }
  for (const f of r.tracked) warn(`${f} is committed, so its values are in the repository. git rm --cached ${f}, add it to .gitignore, and change those secrets.`);
  for (const f of r.notIgnored) warn(`${f} isn't in .gitignore, so git add . would commit it.`);
  for (const s of r.secrets) warn(`${s.kind} in ${s.file}:${s.line} (${s.preview})`);
  if (r.secrets.length) console.log(c.dim("  Move them to .env, and revoke them: they're in the git history."));
  else if (r.scanned) ok("No keys or tokens in tracked files");
}
