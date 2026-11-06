import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { exportTools, findProjects, importTools, loadConfig, loadTools, readProject, readToolBundle, recordRun, scanProjects, TOOL_BUNDLE_MAX, type Project } from "@dx/core";
import type { Command } from "../command.js";
import { c, info, ok, table, UsageError } from "../ui.js";

function resolve(query: string | undefined): Project {
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

const KINDS: Record<string, string> = { view: "view", watch: "watch", operation: "operation", answer: "changes API answers", page: "changes the app's page", column: "Activity column" };

export const toolsCommand: Command = {
  name: "tools",
  summary: "A project's own tools (made on its Tools page): list them, or carry them to another project in a file",
  usage: [
    "dx tools [project]                          the project's tools",
    "dx tools export [project] [file]            every tool in one file (default <project>.dxtools.json here)",
    "dx tools import <file> [project] [--replace]  add a file's tools; --replace swaps a tool with the same name",
    "",
    "Tools are made and run on the project's Tools page in the dashboard (dx ui).",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { replace: { type: "boolean" }, force: { type: "boolean" } } });
    const verb = positionals[0];
    if (verb === "export") {
      const project = resolve(positionals[1]);
      const bundle = exportTools(project.dir, project.name);
      if (!bundle.tools.length) return info(`${project.name} has no tools yet. Make one on its Tools page: dx ui`);
      const file = path.resolve(positionals[2] ?? `${project.name.replace(/[^\w.-]+/g, "-")}.dxtools.json`);
      try {
        fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600, flag: values.force ? "w" : "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new UsageError(`${file} is already there. Give another name, or add --force to replace it.`);
        throw err;
      }
      ok(`Saved ${bundle.tools.length} tool${bundle.tools.length === 1 ? "" : "s"} of ${project.name} to ${file}.`);
      return info("Their requests' headers and bodies are in it as written (a token included), so share it with care.");
    }
    if (verb === "import") {
      if (!positionals[1]) throw new UsageError("Which file? dx tools import <file> [project]");
      const file = path.resolve(positionals[1]);
      if (fs.statSync(file).size > TOOL_BUNDLE_MAX) throw new Error("A tools file can be at most 2 MB.");
      const bundle = readToolBundle(fs.readFileSync(file, "utf8"));
      const project = resolve(positionals[2]);
      const r = importTools(project.dir, bundle.tools, { replace: values.replace === true });
      recordRun("tool", true, `${project.name}: imported ${r.added + r.replaced} tool${r.added + r.replaced === 1 ? "" : "s"}${r.replaced ? ` (${r.replaced} replaced)` : ""}`, "cli", { project: project.name });
      return ok(`Imported ${r.added + r.replaced} tool${r.added + r.replaced === 1 ? "" : "s"} into ${project.name}${r.replaced ? `, ${r.replaced} replaced` : ""}.`);
    }
    const project = resolve(verb === "list" ? positionals[1] : verb);
    const tools = loadTools(project.dir);
    if (!tools.length) return info(`${project.name} has no tools yet. Make one on its Tools page: dx ui`);
    console.log(table(["Tool", "Kind", ""], tools.map((t) => [t.name, KINDS[t.kind] ?? t.kind, t.off ? c.yellow("off") : t.pin?.includes("overview") ? c.dim("on Overview") : ""])));
  },
};
