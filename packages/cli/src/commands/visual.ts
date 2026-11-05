import { parseArgs } from "node:util";
import { describeCapture, describeHealth, findProjects, formatRatio, listVisual, loadConfig, readProject, scanProjects, visualFolder, type Project, type VisualCommit } from "@dx/core";
import { findDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, info, table, UsageError } from "../ui.js";

export const visualCommand: Command = {
  name: "visual",
  summary: "Which commits changed how the app looks: screenshots per commit, compared with the one before",
  usage: [
    "dx visual <project>              recent commits: changed or the same, and by how much",
    "dx visual <project> --capture    capture now (the dev server dx runs must be up)",
    "dx visual <project> --pages      every page of each commit, with where it changed",
    "dx visual <project> --json",
    "",
    "After each commit made from the dashboard's Git page, or when HEAD moves while dx runs the",
    "project's dev server, dx screenshots the pages you used most in the last day and compares them",
    'with the commit before\'s. Turn it off with "visualDiff": false in ~/.dx/config.json.',
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        capture: { type: "boolean", short: "c" },
        pages: { type: "boolean", short: "p" },
        json: { type: "boolean" },
        limit: { type: "string", short: "n" },
      },
    });
    const project = resolve(positionals.join(" ").trim());
    if (values.capture) {
      const client = await findDashboard();
      if (!client) throw new UsageError(`The dashboard isn't running. Start ${project.name} with dx up ${project.name}, then capture.`);
      await client.post("/api/visual/capture", { dir: project.dir });
      info(`Capturing ${project.name}…`);
      let state: { capturing: boolean; last?: { ok: boolean; message: string } };
      const end = Date.now() + 5 * 60_000;
      do {
        await new Promise((r) => setTimeout(r, 1000));
        state = await client.get(`/api/visual?dir=${encodeURIComponent(project.dir)}`);
      } while (state.capturing && Date.now() < end);
      if (state.last && !state.last.ok) throw new Error(state.last.message);
    }
    const limit = Math.max(1, Math.min(100, Number(values.limit ?? 15) || 15));
    const commits = listVisual(project.dir, limit);
    if (values.json) {
      console.log(JSON.stringify(commits.map((e) => ({ ...e, captures: e.captures.map((x) => ({ ...x, text: describeCapture(x) })) })), null, 2));
      return;
    }
    if (!commits.length) {
      info(`No captures of ${project.name} yet. They're taken after a commit while dx runs its dev server (dx up ${project.name}), or with dx visual ${project.name} --capture.`);
      return;
    }
    console.log(
      table(
        ["Commit", "Look", "Changed", "Pages", "Message"],
        commits.map((e) => [c.dim(e.commit.slice(0, 7)), look(e) + (e.slower ? c.yellow(" slower") : "") + (e.a11yNew ? c.yellow(` +${e.a11yNew} a11y`) : ""), e.ratio !== undefined ? formatRatio(e.ratio) : "", String(e.captures.filter((x) => !x.error).length), e.subject ?? ""]),
      ),
    );
    if (values.pages) {
      for (const e of commits) {
        console.log(`\n${c.bold(e.commit.slice(0, 7))} ${e.subject ?? ""}${e.against ? c.dim(`  against ${e.against.slice(0, 7)}`) : ""}`);
        for (const x of e.captures) console.log(`  ${x.changed ? c.yellow("●") : x.error ? c.red("✗") : c.dim("○")} ${x.path}${x.viewport === "mobile" ? c.dim(" (phone)") : ""}  ${describeCapture(x)}`);
        for (const line of describeHealth(e)) console.log(`  ${c.yellow("▲")} ${line}`);
      }
    }
    console.log(c.dim(`\nScreenshots in ${visualFolder(project.dir)}. Before and after side by side: the Git page in dx ui.`));
  },
};

function look(e: VisualCommit): string {
  if (!e.captures.some((x) => !x.error)) return c.red("not captured");
  if (e.changed === undefined) return c.dim("first capture");
  return e.changed ? c.yellow("changed") : c.green("same");
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
