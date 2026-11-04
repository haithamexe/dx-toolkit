import { parseArgs } from "node:util";
import { findDatabases, findProjects, loadConfig, queryDatabase, readProject, scanProjects, type Project } from "@dx/core";
import type { Command } from "../command.js";
import { c, info, table, UsageError } from "../ui.js";

export const dbCommand: Command = {
  name: "db",
  summary: "Read-only queries against a project's development database (Postgres, MySQL, Redis in docker-compose)",
  usage: [
    'dx db <project>                         its tables (Redis: some keys)',
    'dx db <project> "select * from orders"  run a reading query',
    'dx db <project> --service cache "GET session:42"',
    "dx db <project> --json",
    "",
    "Runs inside the container, as the user it was set up with: nothing to install, no password to give.",
    "Only SELECT, WITH, SHOW, EXPLAIN and DESCRIBE (and Redis commands that read); the session is read-only too.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { service: { type: "string", short: "s" }, json: { type: "boolean" } } });
    const [name, ...rest] = positionals;
    const project = resolve(name ?? "");
    const query = rest.join(" ").trim() || undefined;
    const r = await queryDatabase(project, { service: values.service, query });
    if (values.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    const others = findDatabases(project).filter((d) => d.service !== r.service);
    console.log(c.dim(`${project.name} / ${r.service} (${r.kind}), ${r.ms} ms${others.length ? `; also: ${others.map((d) => d.service).join(", ")} (--service)` : ""}`));
    if (r.text !== undefined) console.log(r.text);
    else if (!r.rows.length) info("No rows.");
    else console.log(table(r.columns, r.rows));
    if (r.truncated) info("Only the first 200 rows are shown.");
  },
};

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
