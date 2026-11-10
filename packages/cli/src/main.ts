import fs from "node:fs";
import { recordRun } from "@dx/core";
import type { Command } from "./command.js";
import { errorsCommand, firstRunSetup, fixCommand, logsCommand, setupCommand } from "./commands/ai.js";
import { claudeCommand, hookCommand } from "./commands/claude.js";
import { cleanCommand } from "./commands/clean.js";
import { dbCommand } from "./commands/db.js";
import { cloneCommand, envCommand } from "./commands/clone.js";
import { depsCommand } from "./commands/deps.js";
import { goCommand } from "./commands/go.js";
import { logCommand } from "./commands/log.js";
import { newCommand } from "./commands/new.js";
import { killCommand, portCommand } from "./commands/port.js";
import { projectsCommand } from "./commands/projects.js";
import { resumeCommand, statusCommand } from "./commands/resume.js";
import { downCommand, upCommand } from "./commands/stack.js";
import { httpsCommand } from "./commands/https.js";
import { summaryCommand } from "./commands/summary.js";
import { testCommand } from "./commands/test.js";
import { trafficCommand } from "./commands/traffic.js";
import { activityCommand } from "./commands/activity.js";
import { browserCommand, sitesCommand } from "./commands/browser.js";
import { terminalCommand } from "./commands/terminal.js";
import { gitCommand } from "./commands/git.js";
import { machineCommand } from "./commands/machine.js";
import { updateCommand } from "./commands/update.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { prepareCommand } from "./commands/prepare.js";
import { chaosCommand } from "./commands/chaos.js";
import { attackCommand, dataCommand, phoneCommand } from "./commands/data.js";
import { proofCommand, queriesCommand, tourCommand, tryCommand } from "./commands/team.js";
import { runCommand } from "./commands/run.js";
import { bugCommand } from "./commands/bug.js";
import { mockCommand } from "./commands/mock.js";
import { visualCommand } from "./commands/visual.js";
import { configCommand, doctorCommand, runsCommand } from "./commands/system.js";
import { uiCommand } from "./commands/ui.js";
import { floppyCommand } from "./commands/floppy.js";
import { stateCommand } from "./commands/state.js";
import { toolsCommand } from "./commands/tools.js";
import { c, UsageError } from "./ui.js";

// To add a tool: write packages/cli/src/commands/<tool>.ts and add it to this list.
const commands: Command[] = [
  uiCommand,
  floppyCommand,
  goCommand,
  runCommand,
  resumeCommand,
  upCommand,
  downCommand,
  newCommand,
  cloneCommand,
  projectsCommand,
  statusCommand,
  portCommand,
  killCommand,
  logCommand,
  summaryCommand,
  cleanCommand,
  depsCommand,
  testCommand,
  envCommand,
  dbCommand,
  logsCommand,
  errorsCommand,
  fixCommand,
  trafficCommand,
  activityCommand,
  bugCommand,
  mockCommand,
  toolsCommand,
  browserCommand,
  sitesCommand,
  terminalCommand,
  gitCommand,
  visualCommand,
  chaosCommand,
  attackCommand,
  dataCommand,
  queriesCommand,
  phoneCommand,
  tourCommand,
  proofCommand,
  tryCommand,
  machineCommand,
  updateCommand,
  uninstallCommand,
  prepareCommand,
  setupCommand,
  claudeCommand,
  hookCommand,
  httpsCommand,
  configCommand,
  stateCommand,
  runsCommand,
  doctorCommand,
];

function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

function help(): void {
  console.log(`${c.bold("dx")} ${c.dim(version())}  your developer toolkit\n`);
  const width = Math.max(...commands.map((cmd) => cmd.name.length));
  for (const cmd of commands) console.log(`  ${c.cyan(cmd.name.padEnd(width))}  ${cmd.summary}`);
  console.log(`\n${c.dim("Details for one command: dx help <command>")}`);
}

function find(name: string): Command | undefined {
  return commands.find((cmd) => cmd.name === name || cmd.aliases?.includes(name));
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const target = rest[0] && find(rest[0]);
    if (target) {
      console.log(`${c.bold(target.summary)}\n\n${target.usage}`);
      return 0;
    }
    help();
    return 0;
  }
  if (name === "--version" || name === "-v") {
    console.log(version());
    return 0;
  }
  const command = find(name);
  if (!command) {
    console.error(`${c.red("Unknown command:")} ${name}\n`);
    help();
    return 1;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`${c.bold(command.summary)}\n\n${command.usage}`);
    return 0;
  }
  try {
    // The hook's output goes to Claude Code as JSON: nothing else may be printed there.
    if (command !== setupCommand && command !== hookCommand) await firstRunSetup();
    return (await command.run(rest)) ?? 0;
  } catch (err) {
    const e = err as Error & { code?: string };
    if (err instanceof UsageError || e.code?.startsWith("ERR_PARSE_ARGS")) {
      console.error(`${c.red("✗")} ${e.message}\n\n${c.dim("Usage:")}\n${command.usage}`);
      return 2;
    }
    recordRun(command.name, false, e.message);
    console.error(`${c.red("✗")} ${e.message}`);
    if (process.env.DX_DEBUG) console.error(e.stack);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
