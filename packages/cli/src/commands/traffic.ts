import { parseArgs } from "node:util";
import { findProjects, loadConfig, readProject, scanProjects, type Project } from "@dx/core";
import { findDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, info, UsageError } from "../ui.js";

interface Entry {
  id: number;
  at: string;
  service?: string;
  method: string;
  path: string;
  status?: number;
  ms?: number;
  error?: string;
  requestBody?: string;
  responseBody?: string;
}

export const trafficCommand: Command = {
  name: "traffic",
  aliases: ["requests"],
  summary: "Requests a running app made through its .localhost address, with bodies (secrets masked)",
  usage: [
    "dx traffic <project>             API calls through shop.localhost and its services",
    "dx traffic <project> -f          keep printing new ones",
    "dx traffic <project> --bodies    with request and response bodies",
    "dx traffic <project> --failed    only 4xx, 5xx and failed ones",
    "dx traffic <project> --all       pages, scripts and images too",
    "dx traffic <project> --path /api/cart",
    "",
    "Recorded while the dashboard runs, for requests to the app's .localhost address (not localhost:<port>).",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        follow: { type: "boolean", short: "f" },
        bodies: { type: "boolean", short: "b" },
        failed: { type: "boolean" },
        all: { type: "boolean" },
        path: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const project = resolve(positionals.join(" ").trim());
    const client = await findDashboard();
    if (!client) throw new UsageError(`The dashboard isn't running, so nothing is recorded. Start ${project.name} with dx up ${project.name}.`);
    let after = 0;
    const fetchNew = async () => {
      const q = new URLSearchParams({ dir: project.dir, after: String(after), ...(values.failed ? { failed: "1" } : {}), ...(values.all ? { all: "1" } : {}), ...(values.path ? { path: values.path } : {}) });
      const list = await client.get<Entry[]>(`/api/traffic?${q}`);
      if (list.length) after = list[list.length - 1].id;
      return list;
    };
    const first = await fetchNew();
    if (values.json) {
      console.log(JSON.stringify(first, null, 2));
      return;
    }
    if (!first.length && !values.follow) info(`No requests yet. Open ${project.name} at its .localhost address (dx up ${project.name} prints it).`);
    for (const e of first) print(e, !!values.bodies);
    if (!values.follow) return;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      for (const e of await fetchNew()) print(e, !!values.bodies);
    }
  },
};

function print(e: Entry, bodies: boolean): void {
  const status = e.error ? c.red(e.error) : (e.status ?? 0) >= 500 ? c.red(String(e.status)) : (e.status ?? 0) >= 400 ? c.yellow(String(e.status)) : c.green(String(e.status ?? "…"));
  const time = new Date(e.at).toLocaleTimeString();
  console.log(`${c.dim(time)}  ${e.method.padEnd(6)} ${status}  ${e.service ? c.cyan(`[${e.service}] `) : ""}${e.path}${e.ms !== undefined ? c.dim(`  ${e.ms} ms`) : ""}`);
  if (!bodies) return;
  if (e.requestBody) console.log(c.dim(`         → ${e.requestBody}`));
  if (e.responseBody) console.log(c.dim(`         ← ${e.responseBody.slice(0, 2000)}`));
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
