import { parseArgs } from "node:util";
import { deleteCleanup, findCleanup, formatBytes, loadConfig, recordRun } from "@dx/core";
import type { Command } from "../command.js";
import { c, confirm, info, ok, relativeTime, table, tildify, UsageError, warn } from "../ui.js";

export const cleanCommand: Command = {
  name: "clean",
  summary: "Free disk space: delete node_modules and build folders in projects you haven't touched lately",
  usage: [
    "dx clean              projects idle for 30+ days: show what can go, then ask before deleting",
    "dx clean --days 90    only projects idle for 90+ days",
    "dx clean --list       only show them",
    "dx clean -y           delete without asking",
    "dx clean --json       the list as JSON",
    "",
    "Only folders an install or build recreates. In a git repo, only folders git ignores,",
    "so a committed build/ folder is never touched. Run npm install to get node_modules back.",
  ].join("\n"),
  async run(argv) {
    const { values } = parseArgs({
      args: argv,
      options: {
        days: { type: "string", short: "d" },
        list: { type: "boolean", short: "l" },
        yes: { type: "boolean", short: "y" },
        json: { type: "boolean" },
      },
    });
    const days = values.days === undefined ? 30 : Number(values.days);
    if (!Number.isInteger(days) || days < 0) throw new UsageError("--days must be a whole number, 0 or more.");

    const progress = Boolean(process.stderr.isTTY) && !values.json;
    const scan = await findCleanup({
      days,
      config: loadConfig(),
      onProgress: progress
        ? (done, total, name) => process.stderr.write(`\r\x1b[2K${c.dim(`Measuring ${done + 1}/${total}  ${name}`)}`)
        : undefined,
    });
    if (progress) process.stderr.write("\r\x1b[2K");

    if (values.json) {
      console.log(JSON.stringify(scan, null, 2));
      return;
    }
    if (scan.items.length === 0) {
      console.log(
        scan.projectsScanned
          ? `Nothing to clean in the ${scan.projectsScanned} project(s) idle for ${days}+ days.`
          : `No project has been idle for ${days}+ days.`,
      );
      return;
    }

    console.log(
      table(
        ["PROJECT", "FOLDER", "SIZE", "IDLE"],
        scan.items.map((i) => [c.bold(i.project), i.relative, formatBytes(i.bytes), c.dim(relativeTime(i.lastActive))]),
      ),
    );
    const projects = new Set(scan.items.map((i) => i.project)).size;
    console.log(
      `\n${c.bold(formatBytes(scan.totalBytes))} in ${scan.items.length} folder(s) across ${projects} project(s) idle for ${days}+ days.`,
    );
    if (values.list) return;

    if (!values.yes && !(await confirm(`Delete them?`))) {
      info(process.stdin.isTTY ? "Nothing deleted." : "Nothing deleted. Run it in a terminal to be asked, or add -y.");
      return;
    }
    const results = await deleteCleanup(scan.items);
    const freed = results.reduce((n, r) => n + r.bytes, 0);
    const failed = results.filter((r) => !r.ok);
    for (const r of failed) warn(`${tildify(r.dir)}: ${r.message}`);
    ok(`Freed ${formatBytes(freed)} (${results.length - failed.length} folder(s) deleted)`);
    if (scan.items.some((i) => i.relative.endsWith("node_modules"))) {
      info(`Run ${c.cyan("npm install")} in a project to get its node_modules back.`);
    }
    recordRun("clean", failed.length === 0, `${formatBytes(freed)} freed, ${failed.length} failed`);
    return failed.length ? 1 : 0;
  },
};
