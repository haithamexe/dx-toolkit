import { parseArgs } from "node:util";
import {
  ACTIVITY_TYPES,
  clearActivity,
  findProjects,
  isProblem,
  loadConfig,
  parseSince,
  readActivity,
  readProject,
  recordRun,
  scanProjects,
  type ActivityEvent,
  type ActivityType,
  type Project,
} from "@dx/core";
import type { Command } from "../command.js";
import { c, info, ok, UsageError } from "../ui.js";

export const activityCommand: Command = {
  name: "activity",
  aliases: ["history"],
  summary: "What happened in your apps, in order: requests and responses, routes, clicks, console, errors",
  usage: [
    "dx activity                     everything today, newest last, every project",
    "dx activity <project>           one project (. for the one you're in)",
    "dx activity <project> -f        keep printing as it happens",
    "dx activity --since 2h          also 30m, 3d, today, yesterday, 14:30, or a date",
    "dx activity --problems          only failed requests, errors, console errors and warnings",
    "dx activity -t request,console  only these: request, page, route, action, console, error, server, server-error",
    "dx activity -q checkout         only events mentioning this (in addresses, bodies and stacks too)",
    "dx activity -b                  with request and response bodies, and stacks",
    "dx activity --site <host>       only what the dx browser recorded on that site (dx sites lists them)",
    "dx activity --env staging       only one environment (local is your own computer)",
    "dx activity --clear [project]   delete the history",
    "",
    "Recorded by the dashboard for apps opened at their .localhost address (dx up prints it), and for",
    "the sites you add with dx sites add when you use them in the dx browser (dx browser), and kept",
    "for 7 days in ~/.dx/activity, with passwords, tokens and cookies masked. Turn it off with",
    `"activity": false in ~/.dx/config.json; change how long it's kept with "activityDays".`,
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        follow: { type: "boolean", short: "f" },
        since: { type: "string", short: "s" },
        type: { type: "string", short: "t" },
        problems: { type: "boolean" },
        errors: { type: "boolean" },
        search: { type: "string", short: "q" },
        bodies: { type: "boolean", short: "b" },
        limit: { type: "string", short: "n" },
        json: { type: "boolean" },
        clear: { type: "boolean" },
        site: { type: "string" },
        env: { type: "string" },
      },
    });
    const query = positionals.join(" ").trim();
    const project = query ? resolve(query) : undefined;

    if (values.clear) {
      clearActivity(project?.dir);
      recordRun("activity", true, project ? `${project.name}: history cleared` : "all history cleared", "cli", project ? { project: project.name } : {});
      ok(project ? `Deleted ${project.name}'s activity history.` : "Deleted the activity history of every project.");
      return;
    }

    const types = values.type
      ? values.type.split(",").map((t) => t.trim()).filter(Boolean)
      : [];
    const unknown = types.filter((t) => !(ACTIVITY_TYPES as string[]).includes(t));
    if (unknown.length) throw new UsageError(`Unknown type ${unknown.join(", ")}. Types: ${ACTIVITY_TYPES.join(", ")}.`);
    const since = parseSince(values.since ?? "today");
    if (!since) throw new UsageError(`Can't read --since ${values.since}: use 30m, 2h, 3d, today, yesterday, 14:30 or a date.`);
    const limit = values.limit ? Number(values.limit) : 200;
    if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit takes a number, e.g. -n 50.");

    const base = { dir: project?.dir, types: types as ActivityType[], problems: values.problems || values.errors, search: values.search, site: values.site, env: values.env };
    const first = readActivity({ ...base, since, limit });
    if (values.json) {
      console.log(JSON.stringify(first, null, 2));
      return;
    }
    const many = !project && new Set(first.map((e) => e.dir)).size > 1;
    if (!first.length && !values.follow) {
      info(
        `Nothing recorded ${values.since ? `since ${values.since}` : "today"}${project ? ` for ${project.name}` : ""}. ` +
          `Run an app with dx up and open it at its .localhost address: what happens there is kept here.`,
      );
    }
    for (const e of first) print(e, { bodies: !!values.bodies, project: many || !project });
    if (!values.follow) return;
    let after = first.length ? Math.max(...first.map((e) => e.id)) : Date.now() * 1000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const next = readActivity({ ...base, after, limit: 1000 });
      for (const e of next) print(e, { bodies: !!values.bodies, project: !project });
      if (next.length) after = Math.max(after, ...next.map((e) => e.id));
    }
  },
};

const LABEL: Record<ActivityType, string> = {
  request: "request",
  page: "page",
  route: "route",
  action: "action",
  console: "console",
  error: "error",
  server: "server",
  "server-error": "srv err",
};

function print(e: ActivityEvent, options: { bodies: boolean; project: boolean }): void {
  const time = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const bad = isProblem(e);
  const warnOnly = e.level === "warn";
  const label = LABEL[e.type].padEnd(7);
  const tag = bad ? (warnOnly ? c.yellow(label) : c.red(label)) : e.type === "action" || e.type === "route" ? c.cyan(label) : c.dim(label);
  const who = [options.project ? e.project : "", e.service ? `[${e.service}]` : "", e.env && e.env !== "local" ? `(${e.env})` : ""].filter(Boolean).join(" ");
  const ms = e.ms !== undefined && (e.type === "request" || e.type === "page") ? c.dim(`  ${e.ms} ms`) : "";
  const level = e.type === "console" && e.level && e.level !== "log" ? c.dim(`${e.level}: `) : "";
  console.log(`${c.dim(time)}  ${tag} ${who ? `${c.cyan(who)} ` : ""}${level}${firstLine(e.text)}${ms}`);
  if (!options.bodies) return;
  const pad = "                    ";
  if (e.source) console.log(c.dim(`${pad}at ${e.source}`));
  if (e.requestBody) console.log(c.dim(`${pad}→ ${e.requestBody.slice(0, 4000)}`));
  if (e.responseBody) console.log(c.dim(`${pad}← ${e.responseBody.slice(0, 4000)}${e.truncated ? " …" : ""}`));
  if (e.stack && e.type !== "console") for (const l of e.stack.split("\n").slice(0, 12)) console.log(c.dim(`${pad}${l}`));
}

function firstLine(text: string): string {
  const i = text.indexOf("\n");
  return i < 0 ? text : `${text.slice(0, i)} …`;
}

function resolve(query: string): Project {
  if (query === ".") {
    const here = readProject(process.cwd());
    if (here) return here;
    throw new UsageError("This folder isn't a project. Give a project's name, or leave it out for every project.");
  }
  const { match, candidates } = findProjects(query, scanProjects(loadConfig()));
  const project = match ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (project) return project;
  throw new UsageError(candidates.length ? `Several projects match "${query}": ${candidates.slice(0, 8).map((p) => p.name).join(", ")}` : `No project matches "${query}".`);
}
