import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareVersions, recordRun, switchDx } from "@dx/core";
import { findDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, confirm, info, ok, UsageError, warn } from "../ui.js";

export const updateCommand: Command = {
  name: "update",
  aliases: ["upgrade"],
  summary: "Update dx to the newest version, cleaning up an old or broken install first",
  usage: [
    "dx update               the newest dx-devkit from npm",
    "dx update --force       install it again, also when it's up to date",
    "dx update --npm         switch from a linked repository build to the npm package",
    "",
    "Use it instead of npm install -g when npm says EEXIST or EPERM: it stops the dashboard,",
    "removes the old install and the dx shims it left, and asks before stopping dx processes",
    "(AI tools' dx servers) that still run from it. When dx itself won't start:",
    "  npx -y dx-devkit@latest update",
  ].join("\n"),
  async run(argv) {
    const { values } = parseArgs({ args: argv, options: { force: { type: "boolean" }, npm: { type: "boolean" } } });
    const current = ownVersion();
    const repo = linkedRepository();
    if (repo && !values.npm) {
      info(`dx runs your build in ${repo}: rebuild there with ${c.cyan("npm run build")}.`);
      info(`To use the npm package instead: ${c.cyan("dx update --npm")} (or ${c.cyan("npm run unlink")} in that folder).`);
      return;
    }

    const latest = await latestOnNpm();
    if (!latest) warn("Couldn't reach the npm registry to see the newest version; installing anyway.");
    else if (!repo && !values.force && compareVersions(current, latest) >= 0) {
      ok(`dx ${current} is the newest version.`);
      return;
    } else info(`dx ${current} → ${latest}`);

    const result = await switchDx("npm", {
      log: (line) => console.log(c.dim(line)),
      stopDashboard: async () => {
        const running = await findDashboard();
        if (running) await running.post("/api/shutdown").catch(() => undefined);
      },
      confirm: async () => process.stdin.isTTY && (await confirm("Stop them now? AI tools start their dx server again when reopened (or /mcp).")),
    });
    recordRun("update", result.ok, result.message, "cli");
    if (!result.ok) throw new UsageError(result.message);
    ok(result.message);
    info(c.dim("Restart AI tools that were using dx (or run /mcp in Claude Code) so they pick up the new version."));
  },
};

function ownVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

/** The repository this dx runs from when it's a link to a clone (npm run link), not an npm install. */
function linkedRepository(): string | undefined {
  const here = fs.realpathSync(fileURLToPath(import.meta.url)).replace(/\\/g, "/");
  if (/\/node_modules\/dx-devkit\//.test(here) || /\/_npx\//.test(here)) return undefined;
  const m = /^(.*)\/packages\/cli\/dist\//.exec(here);
  return m && fs.existsSync(path.join(m[1], "packages", "core")) ? path.normalize(m[1]) : undefined;
}

async function latestOnNpm(): Promise<string | undefined> {
  try {
    const res = await fetch("https://registry.npmjs.org/dx-devkit/latest", { headers: { "User-Agent": "dx-devkit" }, signal: AbortSignal.timeout(8000) });
    return res.ok ? ((await res.json()) as { version?: string }).version : undefined;
  } catch {
    return undefined;
  }
}
