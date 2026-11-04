import { parseArgs } from "node:util";
import { findProjects, listTerminals, loadConfig, openTerminal, readProject, recordRun, saveConfig, scanProjects, terminalIds, type Project } from "@dx/core";
import type { Command } from "../command.js";
import { c, ok, UsageError } from "../ui.js";

export const terminalCommand: Command = {
  name: "terminal",
  aliases: ["term"],
  summary: "Open a project in a new terminal window, in the terminal you pick",
  usage: [
    "dx terminal <project>            a new terminal window in the project's folder",
    "dx terminal <project> --in pwsh  in another terminal, this once",
    "dx terminal --list               the terminals on this computer, and which one is used",
    "dx terminal --use git-bash       the terminal projects open in from now on (also the dashboard's)",
    "dx terminal --use default        back to the first one found",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        list: { type: "boolean", short: "l" },
        use: { type: "string" },
        in: { type: "string" },
      },
    });

    if (values.list || (!values.use && !positionals.length)) {
      const list = await listTerminals();
      for (const t of list) {
        const mark = t.selected ? c.green("●") : t.installed ? c.dim("○") : " ";
        console.log(`${mark} ${t.id.padEnd(18)} ${t.installed ? t.name : c.dim(`${t.name} (not installed)`)}${t.selected ? c.dim("  ← projects open here") : ""}`);
      }
      if (!positionals.length) console.log(c.dim(`\nChange it with dx terminal --use <id>. Open a project with dx terminal <project>.`));
      return;
    }

    if (values.use) {
      const config = loadConfig();
      if (values.use === "default") {
        delete config.terminal;
        saveConfig(config);
        const first = (await listTerminals(undefined)).find((t) => t.selected);
        ok(`Projects open in the first terminal found${first ? `: ${first.name}` : ""}.`);
        return;
      }
      const t = (await listTerminals(values.use)).find((x) => x.id === values.use);
      if (!t) throw new UsageError(`Unknown terminal "${values.use}". On this computer: ${terminalIds().join(", ")}.`);
      if (!t.installed) throw new UsageError(`${t.name} isn't installed here. dx terminal --list shows the ones that are.`);
      config.terminal = t.id;
      saveConfig(config);
      ok(`Projects open in ${t.name} from now on.`);
      if (!positionals.length) return;
    }

    if (values.in && !terminalIds().includes(values.in)) throw new UsageError(`Unknown terminal "${values.in}". On this computer: ${terminalIds().join(", ")}.`);
    const project = resolve(positionals.join(" ").trim());
    const used = await openTerminal(project.dir, undefined, project.name, values.in);
    recordRun("terminal", true, `${project.name} in ${used}`, "cli", { project: project.name });
    ok(`Opened ${project.name} in ${used}.`);
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
