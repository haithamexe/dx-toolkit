import { parseArgs } from "node:util";
import { planUninstall, startUninstall, type UninstallPlan } from "@dx/core";
import { findDashboard } from "@dx/web/link";
import type { Command } from "../command.js";
import { c, confirm, info, ok, UsageError, warn } from "../ui.js";

export const uninstallCommand: Command = {
  name: "uninstall",
  aliases: ["remove-dx"],
  summary: "Remove dx from this computer: every install, the app, its shortcuts and its place in AI tools",
  usage: [
    "dx uninstall              remove dx, keeping what it stores in ~/.dx (settings, journal, history)",
    "dx uninstall --everything remove ~/.dx too (snapshot worktrees are removed through git first)",
    "dx uninstall --yes        don't ask",
    "",
    "Goes: the npm package (dx-devkit) and a linked build's link (never the repository itself), the",
    "dx and dx-mcp shims, the dx app with every Electron version, its Start menu, Startup and sign-in",
    "entries, Floppy, dx in Claude Code, Claude Desktop, Cursor, Windsurf and VS Code, and everything",
    "still running from dx (the dashboard and the dev servers it runs, AI tools' dx servers).",
    "Your projects aren't touched. The Settings page has the same as a button.",
  ].join("\n"),
  async run(argv) {
    const { values } = parseArgs({ args: argv, options: { everything: { type: "boolean" }, yes: { type: "boolean", short: "y" } } });
    const plan = await planUninstall();
    if (plan.blocked) throw new UsageError(plan.blocked);
    for (const line of planLines(plan, !!values.everything)) console.log(line);
    if (!values.yes) {
      if (!process.stdin.isTTY) throw new UsageError("Add --yes to remove dx without being asked.");
      if (!(await confirm(values.everything ? "Remove dx and everything it keeps?" : "Remove dx?"))) {
        info("Nothing was removed.");
        return;
      }
    }
    const running = await findDashboard();
    if (running) {
      info("Stopping the dashboard and the dev servers it runs…");
      await running.post("/api/shutdown").catch(() => undefined);
    }
    const r = startUninstall({ data: !!values.everything, foreground: true });
    if (r.status === 0) ok("dx is removed. Open a new terminal: this one may still remember the dx command.");
    else warn(`Some of dx couldn't be removed; what's left is listed above (and in ${r.log}).`);
  },
};

function planLines(plan: UninstallPlan, everything: boolean): string[] {
  const out = [c.bold("dx uninstall removes:")];
  const item = (s: string) => out.push(`  ${s}`);
  for (const i of plan.installs) item(i.kind === "npm" ? `dx-devkit ${i.version ?? ""} from npm (${i.dir})`.replace("  ", " ") : `the link to your build in ${i.dir} (the folder stays)`);
  if (plan.shims.length) item(`${plan.shims.length} dx command shim(s)`);
  if (plan.app) item(`the dx app, ${plan.app.versions.length ? `Electron ${plan.app.versions.join(", ")}` : "its folder"} (${plan.app.dir})`);
  if (plan.entries.length) item(`${plan.entries.length} shortcut(s) and sign-in entries`);
  if (plan.aiTools.length) item(`dx in ${plan.aiTools.join(", ")}`);
  if (plan.processes.length) item(`${plan.processes.length} running dx process(es): ${[...new Set(plan.processes.map((p) => p.what))].join(", ")}`);
  if (everything) item(`${plan.data.dir} (${mb(plan.data.bytes)}${plan.data.snapshots ? `, ${plan.data.snapshots} snapshot(s)` : ""})`);
  else out.push(c.dim(`  Kept: ${plan.data.dir} (${mb(plan.data.bytes)}). Add --everything to remove it too.`));
  if (out.length === 1) out.push(c.dim("  Nothing of dx's install was found; only what's running and dx's folder."));
  return out;
}

function mb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
