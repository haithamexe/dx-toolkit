import { parseArgs } from "node:util";
import { addMocks, clearMocks, findProjects, loadConfig, loadMocks, MockError, parseSince, readActivity, readProject, recordRun, scanProjects, setMockMode, type Project } from "@dx/core";
import type { Command } from "../command.js";
import { c, info, ok, table, truncate, UsageError } from "../ui.js";

export const mockCommand: Command = {
  name: "mock",
  aliases: ["mocks"],
  summary: "Mock mode: answer a project's API from recorded traffic, so its front end runs without the back end",
  usage: [
    "dx mock make <project> [--since 1h]   make mocks from the API calls recorded (also 30m, 3d, today)",
    "dx mock on <project> [--strict]       answer matching API calls from the mocks",
    "dx mock off <project>                 pass everything to the dev server again",
    "dx mock list <project>                the mocked endpoints",
    "dx mock clear <project>               delete the project's mocks",
    "",
    "Mocks apply to the app at its .localhost address (and the address dx records), while dx runs",
    "its dev server: pages and assets still come from the dev server. Endpoints are matched by method",
    "and path, with ids folded (/orders/42 is /orders/:id). Calls with no mock go to the dev server;",
    "with --strict they get a 404. Bodies are the recorded ones: masked values (•••) stay masked.",
    "Edit status, delay and bodies on the Activity page.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { since: { type: "string", short: "s" }, strict: { type: "boolean" } } });
    const [action, ...rest] = positionals;
    const where = rest.join(" ").trim();
    if (!action || !["make", "on", "off", "list", "clear"].includes(action)) throw new UsageError("dx mock make|on|off|list|clear <project>");
    if (!where) throw new UsageError(`Which project? dx mock ${action} <project> (. for the one you're in)`);
    const project = resolve(where);
    try {
      if (action === "make") {
        const since = parseSince(values.since ?? "1h");
        if (!since) throw new UsageError(`Can't read --since ${values.since}: use 30m, 2h, 3d, today or a date.`);
        const r = addMocks(project.dir, project.name, readActivity({ dir: project.dir, since, types: ["request"], limit: 5000 }));
        if (!r.added && !r.replaced && !r.kept) return info(`No API calls through dx ${values.since ? `since ${values.since}` : "in the last hour"}. Open ${project.name} at its .localhost address and use it first.`);
        recordRun("mock", true, `${project.name}: ${r.added} added, ${r.replaced} updated`, "cli", { project: project.name });
        ok(`${r.set.endpoints.length} mocked endpoint(s) for ${project.name}: ${r.added} new, ${r.replaced} updated${r.kept ? `, ${r.kept} you edited kept` : ""}.${r.set.on ? "" : ` Turn them on with: dx mock on ${where}`}`);
        return;
      }
      if (action === "on" || action === "off") {
        const set = setMockMode(project.dir, project.name, { on: action === "on", strict: action === "on" ? values.strict === true : undefined });
        recordRun("mock", true, `${project.name}: mock mode ${set.on ? "on" : "off"}`, "cli", { project: project.name });
        ok(set.on ? `Mock mode is on for ${project.name}: ${set.endpoints.filter((e) => e.enabled).length} endpoint(s) answered by dx${set.strict ? ", others get a 404" : ""}.` : `Mock mode is off for ${project.name}: everything goes to its dev server.`);
        return;
      }
      if (action === "clear") {
        clearMocks(project.dir);
        recordRun("mock", true, `${project.name}: every mock removed`, "cli", { project: project.name });
        ok(`Deleted ${project.name}'s mocks.`);
        return;
      }
      const set = loadMocks(project.dir, project.name);
      if (!set.endpoints.length) return info(`${project.name} has no mocks. Make them with: dx mock make ${where}`);
      info(`Mock mode is ${set.on ? c.green("on") : "off"} for ${project.name}${set.strict ? " (strict)" : ""}`);
      console.log(
        table(
          ["", "METHOD", "PATH", "STATUS", "DELAY", "BODY"],
          set.endpoints.map((e) => [
            e.enabled ? "●" : c.dim("○"),
            e.method,
            `${e.path}${e.query ?? ""}${e.bodyKey ? c.dim(" (one body)") : ""}`,
            e.offline ? "offline" : String(e.status),
            e.delayMs ? `${e.delayMs} ms` : "",
            truncate(e.body.replace(/\s+/g, " "), 40),
          ]),
        ),
      );
    } catch (err) {
      if (err instanceof MockError) throw new UsageError(err.message);
      throw err;
    }
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
