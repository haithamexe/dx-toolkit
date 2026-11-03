import { parseArgs } from "node:util";
import { killPort, listListeningPorts, recordRun, type PortEntry } from "@dx/core";
import type { Command } from "../command.js";
import { c, confirm, ok, table, UsageError, warn } from "../ui.js";

function portTable(entries: PortEntry[]): string {
  return table(
    ["PORT", "PID", "PROCESS", "COMMAND"],
    entries.map((e) => [
      c.bold(String(e.port)),
      String(e.pid),
      e.system ? c.dim(e.processName ?? "System") : (e.processName ?? c.dim("?")),
      c.dim(e.commandLine ?? ""),
    ]),
  );
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.replace(/^:/, ""));
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`Not a valid port: ${value}`);
  return n;
}

async function killFlow(port: number, yes: boolean): Promise<number> {
  const entries = await listListeningPorts(port);
  if (entries.length === 0) {
    console.log(`Nothing is listening on port ${port}.`);
    return 0;
  }
  console.log(portTable(entries));
  const killable = entries.filter((e) => !e.system);
  if (killable.length === 0) {
    warn(`Port ${port} belongs to the operating system; dx won't kill it.`);
    return 1;
  }
  if (!yes && !(await confirm(`\nKill ${killable.length === 1 ? "this process" : `these ${killable.length} processes`}?`))) {
    console.log("Left it running.");
    return 0;
  }
  const { results } = await killPort(port);
  let failed = 0;
  for (const r of results) {
    (r.ok ? ok : warn)(r.message);
    if (!r.ok) failed++;
  }
  recordRun("port.kill", failed === 0, `port ${port}: ${results.map((r) => r.message).join("; ")}`);
  return failed === 0 ? 0 : 1;
}

export const portCommand: Command = {
  name: "port",
  aliases: ["ports"],
  summary: "See what's listening on a port, and kill it",
  usage: [
    "dx port                 list listening ports (1024 and up)",
    "dx port --all           include low ports and system processes",
    "dx port 3000            show what's on port 3000",
    "dx port 3000 --kill     kill it (asks first; add -y to skip the question)",
    "dx port --json",
  ].join("\n"),
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        kill: { type: "boolean", short: "k" },
        yes: { type: "boolean", short: "y" },
        all: { type: "boolean", short: "a" },
        json: { type: "boolean" },
      },
    });
    const port = parsePort(positionals[0]);
    if (values.kill) {
      if (port === undefined) throw new UsageError("Which port? e.g. dx port 3000 --kill");
      return killFlow(port, Boolean(values.yes));
    }
    let entries = await listListeningPorts(port);
    if (port === undefined && !values.all) entries = entries.filter((e) => e.port >= 1024 && !e.system);
    if (values.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log(port === undefined ? "No listening ports found." : `Nothing is listening on port ${port}.`);
      return;
    }
    console.log(portTable(entries));
    if (port !== undefined) console.log(c.dim(`\nKill it with: dx kill ${port}`));
  },
};

export const killCommand: Command = {
  name: "kill",
  summary: "Kill whatever is listening on a port",
  usage: "dx kill <port> [-y]",
  async run(argv) {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { yes: { type: "boolean", short: "y" } },
    });
    const port = parsePort(positionals[0]);
    if (port === undefined) throw new UsageError("Which port? e.g. dx kill 3000");
    return killFlow(port, Boolean(values.yes));
  },
};
