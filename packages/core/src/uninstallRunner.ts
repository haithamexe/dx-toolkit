/**
 * Removes dx, run by `startUninstall` from a copy of core in a temp folder (never from the install
 * it removes). Arguments: --log <file>, --data (also ~/.dx), --wait <pid> (the dashboard that asked,
 * which closes first). Prints what it does and writes the same to the log.
 */
import fs from "node:fs";
import { recordRun } from "./runs.js";
import { notifyOs } from "./tools/envwatch.js";
import { runUninstall, uninstallBlocked } from "./tools/uninstall.js";

const args = process.argv.slice(2);
const valueOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const logFile = valueOf("--log");
const wait = Number(valueOf("--wait"));

function log(line: string): void {
  console.log(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${line}\n`);
    } catch {
      // the console has it
    }
  }
}

const blocked = uninstallBlocked();
if (blocked) {
  log(blocked);
  process.exit(1);
}

log(`Removing dx${args.includes("--data") ? " and everything it keeps" : ""}…`);
const r = await runUninstall({ data: args.includes("--data"), waitFor: Number.isInteger(wait) && wait > 0 ? wait : undefined, log });
log(r.ok ? "dx is removed." : `dx is removed, except: ${r.left.join("; ")}`);
// Into dx runs when ~/.dx is kept, with how it went (it's gone otherwise).
if (!args.includes("--data")) recordRun("uninstall", r.ok, r.ok ? "dx removed, ~/.dx kept" : `left: ${r.left.join("; ").slice(0, 300)}`, valueOf("--from") === "web" ? "web" : "cli");
notifyOs(r.ok ? "dx is removed" : "dx is mostly removed", r.ok ? "Every install, the app, its shortcuts and dx's place in your AI tools are gone." : `Left: ${r.left.join("; ").slice(0, 200)}`);
process.exit(r.ok ? 0 : 1);
