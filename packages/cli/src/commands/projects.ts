import { parseArgs } from "node:util";
import { findProjects, loadConfig, scanProjects, type Project } from "@dx/core";
import type { Command } from "../command.js";
import { c, relativeTime, table, tildify } from "../ui.js";

export function projectLabel(p: Project): string {
  const kind = p.packageManager ? `${p.kind}/${p.packageManager}` : p.kind;
  return `${c.bold(p.name)}  ${c.dim(kind)}  ${c.dim(relativeTime(p.lastActive))}`;
}

export const projectsCommand: Command = {
  name: "projects",
  aliases: ["ls"],
  summary: "List your projects, most recently active first",
  usage: "dx projects [search] [--json]",
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { json: { type: "boolean" } },
    });
    const config = loadConfig();
    const all = scanProjects(config);
    const query = positionals.join(" ");
    const list = query ? findProjects(query, all).candidates : all;

    if (values.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    if (all.length === 0) {
      console.log(`No projects found in ${config.projectsRoots.map(tildify).join(", ")}.`);
      console.log(c.dim("Add a folder with: dx config add-root <path>"));
      return 1;
    }
    if (list.length === 0) {
      console.log(`No project matches "${query}".`);
      return 1;
    }
    console.log(
      table(
        ["NAME", "TYPE", "ACTIVE", "DEV", "PATH"],
        list.map((p) => [
          c.bold(p.name),
          p.packageManager ? `${p.kind}/${p.packageManager}` : p.kind,
          relativeTime(p.lastActive),
          p.devCommand ? c.cyan(p.devCommand) : c.dim("—"),
          c.dim(tildify(p.dir)),
        ]),
      ),
    );
    console.log(c.dim(`\n${list.length} project(s). Open one with: dx go <name>`));
  },
};
