import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { cloneProject, exportState, isValidProjectName, repoName, importState, lastStateImport, loadConfig, planStateImport, readState, recordRun, scanProjects, stateSummary, STATE_MAX, undoStateImport } from "@dx/core";
import type { Command } from "../command.js";
import { c, info, ok, table, UsageError } from "../ui.js";

const tilde = (p: string) => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return home && p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p;
};

export const stateCommand: Command = {
  name: "state",
  summary: "Carry dx to another computer: everything you've set up, in one file",
  usage: [
    "dx state export [file]               one file: settings, journal, saved summaries, templates, and each",
    "                                     project's tools, mocks, rules, API spec, chaos settings, data scenes,",
    "                                     note and alerts (default dx-state-<date>.json here; --force overwrites)",
    "dx state import <file>               what it would change, and where each project goes",
    "dx state import <file> --yes         bring it in (every file is backed up first); --no-settings keeps this",
    "                                     computer's settings",
    "dx state import <file> --yes --clone  also clone the projects that aren't on this computer (from their remote,",
    "                                     without installing anything), then bring it in",
    "dx state undo                        put back every file the last import changed",
    "",
    "Projects are found again by their git repository, else their folder name. Live things stay where",
    "they are: commits, the activity history, snapshots, captures, the dx browser's sign-ins, .env files.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { yes: { type: "boolean", short: "y" }, force: { type: "boolean" }, "no-settings": { type: "boolean" }, clone: { type: "boolean" } } });
    const verb = positionals[0];
    if (verb === "export") {
      const file = path.resolve(positionals[1] ?? `dx-state-${new Date().toISOString().slice(0, 10)}.json`);
      const state = await exportState({ projects: scanProjects(loadConfig()) });
      try {
        fs.writeFileSync(file, JSON.stringify(state, null, 1) + "\n", { mode: 0o600, flag: values.force ? "w" : "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new UsageError(`${file} is already there. Give another name, or add --force to replace it.`);
        throw err;
      }
      recordRun("state", true, `exported ${stateSummary(state)}`, "cli");
      ok(`Saved ${tilde(file)}: ${stateSummary(state)}.`);
      if (state.left?.length) info(`Left out: ${state.left.join("; ")}.`);
      return info("It holds your mocks' answers and saved data scenes, so keep it to yourself. On the other computer: dx state import <file>");
    }
    if (verb === "import") {
      if (!positionals[1]) throw new UsageError("Which file? dx state import <file>");
      const file = path.resolve(positionals[1]);
      if (fs.statSync(file).size > STATE_MAX) throw new Error("A dx state file can be at most 25 MB.");
      const state = readState(fs.readFileSync(file, "utf8"));
      let projects = scanProjects(loadConfig());
      const settings = !values["no-settings"];
      if (!values.yes) {
        const plan = await planStateImport(state, projects);
        console.log(c.bold(`${path.basename(file)}${plan.exportedAt ? c.dim(`  exported ${new Date(plan.exportedAt).toLocaleString()}`) : ""}`));
        if (settings && plan.settings.length) console.log(`Settings: ${plan.settings.map((s) => `${s.name}: ${c.dim(s.from)} → ${s.to}`).join("; ")}`);
        if (settings && plan.roots.length) console.log(`Projects folders added: ${plan.roots.map(tilde).join(", ")}`);
        if (plan.journal.adds) console.log(`Journal: ${plan.journal.adds} entr${plan.journal.adds === 1 ? "y" : "ies"} you don't have here`);
        if (plan.summaries.adds + plan.summaries.changes) console.log(`Saved summaries: ${plan.summaries.adds} new, ${plan.summaries.changes} different`);
        const tpl = plan.templates.filter((t) => t.status !== "same");
        if (tpl.length) console.log(`Templates: ${tpl.map((t) => `${t.name} (${t.status})`).join(", ")}`);
        if (plan.projects.length)
          console.log(
            table(
              ["Project", "Brings", "Goes to"],
              plan.projects.map((p) => [p.name, Object.entries(p.has).map(([k, n]) => `${n} ${k}`).join(", "), p.match ? `${tilde(p.match.dir)} ${c.dim(p.match.by === "remote" ? "(same repository)" : "(same name)")}` : c.yellow(p.cloneUrl ? "not found here: left out (add --clone to clone it)" : "not found here: left out")]),
            ),
          );
        if (plan.left.length) info(`Left out when it was exported: ${plan.left.join("; ")}.`);
        return info("Where both have something, the file's wins; nothing here is deleted; mock mode and Chaos mode stay as they are. Add --yes to bring it in (every file is backed up first).");
      }
      if (values.clone) {
        // Each project that isn't here and has a remote: cloned by its https address, nothing installed (the file isn't code to run installs for).
        const plan = await planStateImport(state, projects);
        for (const p of plan.projects.filter((x) => !x.match && x.cloneUrl)) {
          try {
            // The address comes from the file: it's printed before git is asked to use it.
            info(`Cloning ${p.cloneUrl}…`);
            const r = await cloneProject({ url: p.cloneUrl!, name: isValidProjectName(p.name) ? p.name : repoName(p.cloneUrl!).toLowerCase(), install: false, interactive: true, source: "cli" });
            ok(`Cloned ${p.name} into ${tilde(r.dir)}.`);
          } catch (err) {
            info(`Couldn't clone ${p.name}: ${(err as Error).message.split("\n")[0]}`);
          }
        }
        projects = scanProjects(loadConfig());
      }
      const r = await importState(state, { projects, settings });
      recordRun("state", true, `imported ${r.projects.length} project${r.projects.length === 1 ? "" : "s"}${r.skipped.length ? ` (${r.skipped.length} not on this computer)` : ""}`, "cli");
      const parts = [`${r.projects.length} project${r.projects.length === 1 ? "" : "s"}`, r.settings && `${r.settings} settings`, r.roots && `${r.roots} projects folders`, r.journal && `${r.journal} journal entries`, r.summaries && `${r.summaries} summaries`, r.templates && `${r.templates} templates`, r.sites && `${r.sites} sites`].filter(Boolean);
      ok(`Imported ${parts.join(", ")}.`);
      for (const p of r.projects) console.log(`  ${c.bold(p.name)}  ${Object.entries(p.brought).map(([k, n]) => `${n} ${k}`).join(", ") || c.dim("nothing new")}`);
      if (r.skipped.length) info(`Not on this computer, so left out: ${r.skipped.join(", ")}. Clone them (dx clone) and import again.`);
      for (const n of r.notes) console.log(c.yellow(n));
      if (r.page) info("The dashboard's preferences come along only when you import from its Settings page.");
      return info("Undo with: dx state undo");
    }
    if (verb === "undo") {
      const last = lastStateImport();
      if (!last) return info("There's no import to undo.");
      if (!values.yes) throw new UsageError(`This puts back every file the import of ${new Date(last.at).toLocaleString()} changed, and removes the ones it added; changes you made to them since are lost. Add --yes to go ahead.`);
      const r = undoStateImport();
      recordRun("state", true, `undid the import of ${r.at}`, "cli");
      return ok(`Put back ${r.files} file${r.files === 1 ? "" : "s"}.`);
    }
    throw new UsageError(this.usage);
  },
};
