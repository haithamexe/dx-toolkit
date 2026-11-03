import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { configPath, loadConfig, openInEditor, readRuns, runDoctor, saveConfig } from "@dx/core";
import type { Command } from "../command.js";
import { c, ok, table, tildify, UsageError } from "../ui.js";

export const configCommand: Command = {
  name: "config",
  summary: "Show or change dx settings",
  usage: [
    "dx config                   show the settings file",
    "dx config edit              open it in your editor",
    "dx config add-root <path>   scan another folder for projects",
    "dx config editor <command>  set the editor command, e.g. cursor",
    "dx config github <username> your GitHub username, for pull requests in dx summary",
  ].join("\n"),
  async run(argv) {
    const [action, ...rest] = argv;
    const config = loadConfig();
    if (!action) {
      console.log(c.dim(configPath()));
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    if (action === "edit") {
      await openInEditor(configPath(), config.editor);
      ok(`Opened ${tildify(configPath())}`);
      return;
    }
    if (action === "add-root") {
      const target = rest.join(" ").trim();
      if (!target) throw new UsageError("Which folder? e.g. dx config add-root C:\\code");
      const abs = path.resolve(target);
      if (!fs.existsSync(abs)) throw new UsageError(`Folder not found: ${abs}`);
      if (!config.projectsRoots.some((r) => r.toLowerCase() === abs.toLowerCase())) config.projectsRoots.push(abs);
      saveConfig(config);
      ok(`Projects roots: ${config.projectsRoots.map(tildify).join(", ")}`);
      return;
    }
    if (action === "editor") {
      const editor = rest.join(" ").trim();
      if (!editor) throw new UsageError("Which command? e.g. dx config editor cursor");
      config.editor = editor;
      saveConfig(config);
      ok(`Editor set to ${editor}`);
      return;
    }
    if (action === "github") {
      const user = rest.join(" ").trim().replace(/^@/, "");
      if (!/^[A-Za-z0-9-]{1,39}$/.test(user)) throw new UsageError("Which GitHub username? e.g. dx config github octocat");
      config.githubUser = user;
      saveConfig(config);
      ok(`GitHub username set to ${user}`);
      return;
    }
    throw new UsageError(`Unknown config action: ${action}`);
  },
};

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Check that dx works on this machine",
  usage: "dx doctor",
  async run() {
    const checks = await runDoctor();
    const icon = { ok: c.green("✓"), warn: c.yellow("!"), fail: c.red("✗") } as const;
    for (const check of checks) console.log(`${icon[check.status]} ${c.bold(check.name.padEnd(17))} ${check.detail}`);
    return checks.some((x) => x.status === "fail") ? 1 : 0;
  },
};

export const runsCommand: Command = {
  name: "runs",
  summary: "Recent tool runs, so failures are never silent",
  usage: "dx runs [--limit 30] [--failed]",
  async run(argv) {
    const { values } = parseArgs({
      args: argv,
      options: { limit: { type: "string", short: "n" }, failed: { type: "boolean", short: "f" } },
    });
    let runs = readRuns(Math.max(1, Number(values.limit) || 30));
    if (values.failed) runs = runs.filter((r) => !r.ok);
    if (runs.length === 0) {
      console.log(values.failed ? "No failed runs." : "No runs recorded yet.");
      return;
    }
    console.log(
      table(
        ["WHEN", "TOOL", "FROM", "RESULT"],
        runs.map((r) => [
          new Date(r.at).toLocaleString(),
          r.tool,
          c.dim(r.source ?? ""),
          r.ok ? c.green("ok") + (r.detail ? c.dim(`  ${r.detail}`) : "") : c.red("failed") + `  ${r.detail ?? ""}`,
        ]),
      ),
    );
  },
};
