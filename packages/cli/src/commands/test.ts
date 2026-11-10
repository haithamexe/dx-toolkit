import { parseArgs } from "node:util";
import { findProjects, loadConfig, readProject, runTests, scanProjects, type Project, type TestRun } from "@dx/core";
import type { Command } from "../command.js";
import { c, info, UsageError } from "../ui.js";

export const testCommand: Command = {
  name: "test",
  summary: "Run a project's tests and list each failure with its file, line, expected and actual",
  usage: [
    "dx test [project]            the project here, or the one named",
    "dx test todo-app -m cart     only tests whose name matches",
    "dx test todo-app --changed   only tests related to uncommitted changes (vitest, jest)",
    "dx test todo-app --coverage  also how much of the code the tests run, and the files with the least",
    "dx test todo-app --json      the result as JSON",
    "",
    "vitest, jest, node:test, pytest and go test are read from their own reports; any other",
    "test script runs as is and is judged by its exit code.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { match: { type: "string", short: "m" }, changed: { type: "boolean" }, coverage: { type: "boolean" }, json: { type: "boolean" } },
    });
    const project = resolve(positionals.join(" ").trim());
    if (!values.json) console.log(c.dim(`Running ${project.name}'s tests…`));
    const r = await runTests(project, { match: values.match, changed: values.changed, coverage: values.coverage });
    if (values.json) {
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    printRun(r);
    return r.ok ? 0 : 1;
  },
};

export function printRun(r: TestRun): void {
  if (r.failures.length) console.log("");
  for (const f of r.failures) {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "";
    console.log(`${c.red("✗")} ${c.bold(f.name)}${where ? c.dim(`  ${where}`) : ""}`);
    for (const l of f.message.split("\n").slice(0, 6)) console.log(`    ${l}`);
    if (f.expected !== undefined || f.actual !== undefined) console.log(`    ${c.green(`expected: ${f.expected ?? "?"}`)}  ${c.red(`actual: ${f.actual ?? "?"}`)}`);
  }
  if (r.error) {
    console.log(`\n${c.yellow("!")} ${r.error}`);
    if (r.outputTail.length) console.log(c.dim(r.outputTail.slice(-15).map((l) => `    ${l}`).join("\n")));
  }
  const parts = [`${r.passed} passed`, r.failed ? c.red(`${r.failed} failed`) : "0 failed", ...(r.skipped ? [`${r.skipped} skipped`] : [])];
  console.log(`\n${r.ok ? c.green("✓") : c.red("✗")} ${parts.join(", ")} ${c.dim(`in ${(r.ms / 1000).toFixed(1)}s (${r.framework}: ${r.command})`)}`);
  if (r.coverage) {
    const k = r.coverage;
    const bits = [`lines ${k.lines}%`, k.statements !== undefined && `statements ${k.statements}%`, k.functions !== undefined && `functions ${k.functions}%`, k.branches !== undefined && `branches ${k.branches}%`].filter(Boolean);
    console.log(`\n${c.bold("Coverage")} ${bits.join(", ")} ${c.dim(`across ${k.fileCount} file${k.fileCount === 1 ? "" : "s"}`)}`);
    for (const f of k.files.filter((x) => x.lines < 100).slice(0, 8)) console.log(`  ${String(f.lines).padStart(5)}%  ${f.file}`);
    if (k.note) console.log(c.dim(`  ${k.note}`));
  } else if (r.coverageNote) console.log(`\n${c.yellow("!")} No coverage: ${r.coverageNote}`);
  if (r.framework === "script" && !r.failures.length) info("This test script's output isn't one dx can read in detail; the result is its exit code.");
}

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
