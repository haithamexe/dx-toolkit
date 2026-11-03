import { parseArgs } from "node:util";
import { auditDependencies, describeVulnerabilities, loadConfig, recordRun, type DepsReport } from "@dx/core";
import type { Command } from "../command.js";
import { c, table, tildify, UsageError, warn } from "../ui.js";

export const depsCommand: Command = {
  name: "deps",
  aliases: ["audit"],
  summary: "Outdated packages and known vulnerabilities across all your Node projects",
  usage: [
    "dx deps                 every Node project (npm outdated + npm audit in each)",
    "dx deps todo-app          only projects matching a name",
    "dx deps --active 30     only projects active in the last 30 days",
    "dx deps --details       also list each outdated package",
    "dx deps --json          the raw report",
    "",
    "It asks the npm registry, so it needs the internet and takes a few seconds per project.",
    "Nothing is changed: fix with npm update / npm audit fix in the project.",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        active: { type: "string", short: "a" },
        details: { type: "boolean", short: "d" },
        json: { type: "boolean" },
      },
    });
    const activeDays = values.active === undefined ? undefined : Number(values.active);
    if (activeDays !== undefined && (!Number.isInteger(activeDays) || activeDays < 1)) {
      throw new UsageError("--active must be a whole number of days, 1 or more.");
    }
    const query = positionals.join(" ").trim() || undefined;
    const progress = Boolean(process.stderr.isTTY) && !values.json;
    const started = Date.now();
    const reports = await auditDependencies({
      query,
      activeDays,
      config: loadConfig(),
      onProgress: progress
        ? (done, total, name) => process.stderr.write(`\r\x1b[2K${c.dim(`Checking ${Math.min(done + 1, total)}/${total}  ${name}`)}`)
        : undefined,
    });
    if (progress) process.stderr.write("\r\x1b[2K");

    if (values.json) {
      console.log(JSON.stringify(reports, null, 2));
      return;
    }
    if (reports.length === 0) {
      console.log(query ? `No Node project matches "${query}".` : "No Node projects found.");
      return 1;
    }

    const checked = reports.filter((r) => !r.skipped);
    console.log(
      table(
        ["PROJECT", "OUTDATED", "MAJOR", "VULNERABILITIES", "PATH"],
        reports.map((r) => [
          c.bold(r.project),
          r.skipped ? c.dim("—") : String(r.outdated.length),
          r.skipped ? c.dim("—") : majorCell(r),
          r.skipped ? c.dim(r.skipped) : vulnCell(r),
          c.dim(tildify(r.dir)),
        ]),
      ),
    );

    if (values.details) {
      for (const r of checked) {
        if (!r.outdated.length) continue;
        console.log(`\n${c.bold(r.project)}`);
        console.log(
          table(
            ["PACKAGE", "CURRENT", "WANTED", "LATEST"],
            r.outdated.map((p) => [p.name, p.current ?? c.dim("—"), p.wanted ?? c.dim("—"), p.major ? c.yellow(p.latest) : p.latest]),
          ),
        );
      }
    }

    for (const r of checked) for (const n of r.notes) warn(`${r.project}: ${n}`);

    const vulnerable = checked.filter((r) => (r.vulnerabilities?.total ?? 0) > 0);
    const outdated = checked.reduce((n, r) => n + r.outdated.length, 0);
    console.log(
      `\n${checked.length} project(s) checked in ${Math.round((Date.now() - started) / 1000)}s: ` +
        `${outdated} outdated package(s), ${vulnerable.length} project(s) with known vulnerabilities.`,
    );
    if (vulnerable.length) console.log(c.dim("Fix in a project with: npm audit fix   (details: npm audit)"));
    if (!values.details && outdated) console.log(c.dim("Each package: dx deps --details"));
    recordRun("deps", true, `${checked.length} checked, ${vulnerable.length} vulnerable, ${outdated} outdated`);
  },
};

function majorCell(r: DepsReport): string {
  const n = r.outdated.filter((p) => p.major).length;
  return n ? c.yellow(String(n)) : "0";
}

function vulnCell(r: DepsReport): string {
  const text = describeVulnerabilities(r.vulnerabilities);
  const v = r.vulnerabilities;
  if (!v) return c.dim(text);
  if (v.critical || v.high) return c.red(text);
  if (v.moderate || v.low) return c.yellow(text);
  return c.green(text);
}
