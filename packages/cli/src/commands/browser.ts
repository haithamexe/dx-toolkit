import { parseArgs } from "node:util";
import { ensureDashboard, findDashboard } from "@dx/web/link";
import { addSite, checkOpenUrl, findProjects, listSites, loadConfig, readProject, recordRun, removeSite, scanProjects, type Project } from "@dx/core";
import type { Command } from "../command.js";
import { c, info, ok, table, tildify, UsageError } from "../ui.js";

interface BrowserStatus {
  open: boolean;
  browser?: string;
  found: boolean;
  pages?: number;
  recording: boolean;
}

export const browserCommand: Command = {
  name: "browser",
  summary: "Open the dx browser: it records the sites you chose (staging, production) like your local apps",
  usage: [
    "dx browser                      open the dx browser",
    "dx browser <url>                open it at an address (http or https)",
    "dx browser --close              close it",
    "",
    "A Chrome, Edge, Chromium or Brave window with a profile of its own (~/.dx/browser-profile), so",
    "your sign-ins there stay there. It records the sites you added with dx sites add, and apps on",
    "this computer, into the Activity page: requests and responses, routes, clicks, console, errors.",
    "Anything else you browse in it isn't recorded. It runs with the dashboard and closes with it.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { close: { type: "boolean" } } });
    if (values.close) {
      const dashboard = await findDashboard();
      if (!dashboard) return info("The dx browser isn't open (the dashboard isn't running).");
      await dashboard.post("/api/browser/close");
      ok("Closed the dx browser.");
      return;
    }
    let url: string | undefined;
    if (positionals[0]) {
      const given = positionals[0];
      const local = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|[^:/]+\.localhost)(:\d+)?(\/|$)/i.test(given);
      const raw = /^[a-z][\w+.-]*:\/\//i.test(given) ? given : `${local ? "http" : "https"}://${given}`;
      try {
        url = checkOpenUrl(raw);
      } catch (err) {
        throw new UsageError((err as Error).message);
      }
    }
    const client = await ensureDashboard();
    const status = await client.post<BrowserStatus>("/api/browser/open", url ? { url } : {}, 90_000);
    ok(`The dx browser (${status.browser ?? "browser"}) is open${url ? ` at ${new URL(url).host}` : ""}.`);
    const sites = listSites();
    if (!status.recording) info(`The activity history is off ("activity": false), so nothing is recorded.`);
    else if (!sites.length) info(`It records apps on this computer. Add a deployed site with ${c.bold("dx sites add <host> --project <name>")}.`);
    else info(`Recording ${sites.map((s) => `${s.host}${s.env ? ` (${s.env})` : ""}`).join(", ")} and apps on this computer. See them with dx activity or on the Activity page.`);
  },
};

export const sitesCommand: Command = {
  name: "sites",
  summary: "The deployed sites the dx browser records: add, list, remove",
  usage: [
    "dx sites                                     the recorded sites",
    "dx sites add <host> [--project <name>] [--env staging] [--label <name>]",
    "dx sites add staging.shop-website.dev --project shop-website --env staging",
    "dx sites add *.preview.shop-website.dev      every subdomain",
    "dx sites remove <host>",
    "",
    "A host is a name or name:port, no path. The environment is guessed from the name when not given",
    "(staging, preview, dev, production…). A site linked to a project shows its activity under it.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { project: { type: "string", short: "p" }, env: { type: "string", short: "e" }, label: { type: "string" }, json: { type: "boolean" } },
    });
    const [action = "list", host, ...rest] = positionals;
    if (rest.length) throw new UsageError("One host at a time.");
    if (action === "list" || action === "ls") {
      const sites = listSites();
      if (values.json) return void console.log(JSON.stringify(sites, null, 2));
      if (!sites.length) return info("No sites recorded yet. Add one with dx sites add <host> --project <name>.");
      console.log(table(["HOST", "ENV", "PROJECT", "LABEL"], sites.map((s) => [s.host, s.env ?? "", s.project ? tildify(s.project) : c.dim("(none)"), s.label ?? ""])));
      return;
    }
    if (action === "add") {
      if (!host) throw new UsageError("Which host? dx sites add staging.shop-website.dev");
      const project = values.project ? resolveProject(values.project) : undefined;
      let site;
      try {
        site = addSite({ host, project: project?.dir, env: values.env, label: values.label }, loadConfig());
      } catch (err) {
        throw new UsageError((err as Error).message);
      }
      recordRun("sites", true, `recording ${site.host} (${site.env})${project ? ` for ${project.name}` : ""}`, "cli", project ? { project: project.name } : {});
      const local = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|[^:]+\.localhost)(:\d+)?$/i.test(site.host);
      ok(
        `The dx browser records ${site.host} (${site.env})${project ? ` under ${project.name}` : ""}. ` +
          (site.host.startsWith("*.") ? "Open any of its subdomains with dx browser <address>." : `Open it with dx browser ${local ? "http" : "https"}://${site.host}`),
      );
      return;
    }
    if (action === "remove" || action === "rm") {
      if (!host) throw new UsageError("Which host? dx sites remove staging.shop-website.dev");
      let removed;
      try {
        removed = removeSite(host);
      } catch (err) {
        throw new UsageError((err as Error).message);
      }
      if (!removed) throw new UsageError(`${host} isn't recorded. dx sites lists the ones that are.`);
      recordRun("sites", true, `stopped recording ${removed.host}`, "cli");
      ok(`Stopped recording ${removed.host}. What was recorded stays in the history until it's cleared or gets old.`);
      return;
    }
    throw new UsageError(`Unknown action "${action}". Use add, list or remove.`);
  },
};

function resolveProject(query: string): Project {
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
