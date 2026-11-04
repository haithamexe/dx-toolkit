import { parseArgs } from "node:util";
import {
  addMocks,
  clearMocks,
  findProjects,
  findSpecFiles,
  loadConfig,
  loadMocks,
  MockError,
  mocksFromSpec,
  parseSince,
  purgeMocks,
  putMocks,
  readActivity,
  readProject,
  readProjectSpec,
  readSpec,
  recordRun,
  saveSpec,
  scanProjects,
  setMockMode,
  SpecError,
  type MockSource,
  type Project,
} from "@dx/core";
import { ensureDashboard, findDashboard } from "@dx/web/link";
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
    "dx mock spec <project> [file]         mocks from the project's OpenAPI/Swagger spec (examples, or data made up from its schemas)",
    "dx mock server <project> [on|off]     the project's mock server: its own address, answering from the first call",
    "dx mock cache <project> on|off        keep the real answers that pass through as mocks, until purged",
    "dx mock purge <project> [source]      delete mocks: cache, spec, generated, ai, recorded (all without a source)",
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
    const ACTIONS = ["make", "on", "off", "list", "clear", "spec", "server", "cache", "purge"];
    if (!action || !ACTIONS.includes(action)) throw new UsageError(`dx mock ${ACTIONS.join("|")} <project>`);
    // The last word may be an argument: on/off, a source, or a spec file.
    let arg: string | undefined;
    if (["server", "cache", "purge", "spec"].includes(action) && rest.length > 1) arg = rest.pop();
    const where = rest.join(" ").trim();
    if (!where) throw new UsageError(`Which project? dx mock ${action} <project> (. for the one you're in)`);
    const project = resolve(where);
    try {
      if (action === "spec") {
        const file = arg ?? findSpecFiles(project.dir)[0];
        if (!file) throw new UsageError(`No openapi or swagger file in ${project.name}. Give its path: dx mock spec ${where} docs/api.yaml (or use the Requests page to read it from the running app).`);
        const doc = readProjectSpec(project.dir, file);
        saveSpec(project.dir, `file:${file.replace(/\\/g, "/")}`, doc);
        const spec = readSpec(doc);
        const r = putMocks(project.dir, project.name, mocksFromSpec(spec));
        recordRun("mock", true, `${project.name}: mocks from ${file}, ${r.added} new, ${r.replaced} updated`, "cli", { project: project.name });
        ok(`${spec.title} ${spec.version}: ${spec.endpoints.length} endpoint(s), ${r.set.endpoints.length} mock(s) (${r.added} new, ${r.replaced} updated${r.kept ? `, ${r.kept} you edited kept` : ""}).`);
        info(c.dim(`Serve them with: dx mock server ${where} on`));
        return;
      }
      if (action === "server") {
        const on = arg !== "off";
        const dash = on ? await ensureDashboard() : await findDashboard();
        if (!dash) return info("The dashboard isn't running, so no mock server is either.");
        const r = (await dash.post("/api/mocks/server", { dir: project.dir, on })) as { url?: string; host?: string };
        if (!on) return ok(`${project.name}'s mock server stopped.`);
        ok(`${project.name}'s mock server: ${c.cyan(r.url ?? "")}  (or http://${r.host})`);
        info(c.dim("It answers from the mocks with or without the dev server. Pick an answer with the header x-mock-response-code: 404."));
        return;
      }
      if (action === "cache") {
        if (arg !== "on" && arg !== "off") throw new UsageError(`dx mock cache ${where} on|off`);
        setMockMode(project.dir, project.name, { cache: arg === "on" });
        recordRun("mock", true, `${project.name}: cache ${arg}`, "cli", { project: project.name });
        ok(arg === "on" ? `Real answers to ${project.name}'s API calls through dx are kept as mocks from now on, until you purge them (dx mock purge ${where} cache).` : `The cache stopped; what it kept stays.`);
        return;
      }
      if (action === "purge") {
        const sources = ["recorded", "cache", "spec", "generated", "ai"];
        if (arg && !sources.includes(arg)) throw new UsageError(`Sources: ${sources.join(", ")}.`);
        const r = purgeMocks(project.dir, arg as MockSource | undefined);
        recordRun("mock", true, `${project.name}: purged ${r.removed} mock(s)${arg ? ` from ${arg}` : ""}`, "cli", { project: project.name });
        ok(`Purged ${r.removed} mock(s)${arg ? ` (${arg})` : ""}; ${r.set.endpoints.length} left.`);
        return;
      }
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
      if (err instanceof MockError || err instanceof SpecError) throw new UsageError(err.message);
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
