import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  copyProject,
  isValidProjectName,
  listTemplates,
  loadConfig,
  NAME_PLACEHOLDER,
  readProject,
  recordRun,
  resolveSource,
  saveAsTemplate,
  templatesDir,
} from "@dx/core";
import type { Command } from "../command.js";
import { goCommand } from "./go.js";
import { c, info, ok, tildify, UsageError, warn } from "../ui.js";

export const newCommand: Command = {
  name: "new",
  aliases: ["create"],
  summary: "Start a new project from one of your templates or a copy of a project, then open it",
  usage: [
    "dx new                             list your templates",
    "dx new <template> <name>           new project from ~/.dx/templates/<template>",
    "dx new <project> <name>            new project copied from an existing one",
    "dx new --save <project> <template> save a project as a template",
    "",
    "  --in <folder>    create it there instead of your first projects folder",
    "  --no-install     don't install packages",
    "  --no-git         don't create a git repository",
    "  --no-open        don't open it afterwards (default: dx go, editor + dev server)",
    "  --no-dev         open the editor but don't start the dev server",
    "",
    "A git project is copied as what git tracks plus new files it doesn't ignore.",
    "Copies always leave out .git, node_modules, build output and .env files (.env.example is kept).",
    `In template files, ${NAME_PLACEHOLDER} is replaced with the new name, in file names too.`,
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        save: { type: "boolean" },
        in: { type: "string" },
        install: { type: "boolean", default: true },
        git: { type: "boolean", default: true },
        open: { type: "boolean", default: true },
        dev: { type: "boolean", default: true },
      },
    });
    const config = loadConfig();
    const [sourceInput, name] = positionals;

    if (!sourceInput) {
      const templates = listTemplates(config);
      if (templates.length === 0) {
        console.log(`No templates yet. They live in ${tildify(templatesDir(config))}, one folder each.`);
        console.log(c.dim("Save one from a project: dx new --save todo-app vite-app"));
        console.log(c.dim("Or copy a project directly: dx new todo-app my-new-app"));
        return;
      }
      console.log(c.bold("Templates") + c.dim(`  ${tildify(templatesDir(config))}`));
      for (const t of templates) console.log(`  ${c.cyan(t.name)}`);
      console.log(c.dim("\nUse one: dx new <template> <name>"));
      return;
    }
    if (!name) throw new UsageError(values.save ? "Name the template: dx new --save <project> <template>" : "Name the new project: dx new <template> <name>");
    if (!isValidProjectName(name)) throw new UsageError(`"${name}" isn't a valid name: use lowercase letters, digits, - _ or .`);

    const source = resolveSource(sourceInput, config);
    if ("candidates" in source) {
      throw new UsageError(
        source.candidates.length
          ? `"${sourceInput}" matches several projects: ${source.candidates.join(", ")}. Which one?`
          : `No template or project called "${sourceInput}". See templates with: dx new`,
      );
    }

    if (values.save) {
      const result = saveAsTemplate(source, name, config);
      ok(`Saved ${c.bold(source.name)} as template ${c.cyan(name)} (${result.files} files) in ${tildify(result.dir)}`);
      info(`Tip: put ${NAME_PLACEHOLDER} in its files (README title, page title, …) and new projects get their own name there.`);
      recordRun("new.template", true, `${source.name} → ${name}`);
      return;
    }

    const parent = values.in ? path.resolve(values.in) : config.projectsRoots[0];
    if (!parent) throw new UsageError("No projects folder configured. Add one with: dx config add-root <path>, or pass --in <folder>.");
    const dest = path.join(parent, name);
    const result = copyProject(source, dest, name);
    ok(
      `Created ${c.bold(name)} from ${source.kind} ${c.cyan(source.name)}: ${result.files} files` +
        (result.filled ? `, ${result.filled} with the name filled in` : "") +
        c.dim(`  ${tildify(dest)}`),
    );

    if (values.git) {
      try {
        execFileSync("git", ["init", "-q"], { cwd: dest, stdio: "ignore", windowsHide: true });
        ok("Created a git repository");
      } catch {
        warn("Couldn't create a git repository (is git installed?)");
      }
    }

    const project = readProject(dest);
    if (values.install && project?.kind === "node") {
      const pm = project.packageManager ?? "npm";
      info(`Installing packages with ${pm}…`);
      const code = await runInherit(`${pm} install`, dest);
      if (code === 0) ok("Packages installed");
      else warn(`${pm} install exited with ${code}; run it again in ${tildify(dest)}`);
    }
    recordRun("new", true, `${name} from ${source.kind} ${source.name}`, "cli", { project: name });

    if (!values.open) {
      info(`Open it with: dx go ${name}`);
      return;
    }
    process.chdir(dest);
    return goCommand.run(values.dev ? ["."] : [".", "--no-dev"]);
  },
};

function runInherit(command: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit" });
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
