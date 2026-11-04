#!/usr/bin/env node
// Switches the `dx` command between this repository's build and the npm package, in one step:
//
//   npm run link     dx runs this folder's build (rebuilds go live)
//   npm run unlink   dx is the npm package again (dx-devkit@latest)
//
// The work is switchDx in packages/core (src/tools/selfinstall.ts), the same that `dx update` uses:
// it stops the dashboard, removes the other install and the shims it left (npm's EEXIST), asks
// before stopping processes that still run from it (EPERM / EBUSY on Windows), then installs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (mode !== "local" && mode !== "npm") {
  console.error("Usage: node scripts/use.mjs local | npm");
  process.exit(2);
}
const core = path.join(repo, "packages", "core", "dist", "index.js");
const cli = path.join(repo, "packages", "cli", "dist", "index.js");
if (!fs.existsSync(core)) {
  console.error("Build first: npm run build");
  process.exit(1);
}
const { switchDx } = await import(pathToFileURL(core).href);

console.log(mode === "local" ? `Switching dx to this folder's build (${repo})…` : "Switching dx to the npm package (dx-devkit)…");
const r = await switchDx(mode, {
  repo,
  log: (line) => console.log(line),
  stopDashboard: () => void spawnSync(process.execPath, [cli, "ui", "--stop"], { stdio: "ignore" }),
  confirm: async () => {
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("Stop them now? AI tools start their dx server again when reopened (or /mcp). [y/N] ");
    rl.close();
    return /^y/i.test(answer.trim());
  },
});
if (!r.ok) {
  console.error(`\n${r.message}`);
  process.exit(1);
}
console.log(`\n✓ ${r.message}`);
console.log("  Restart AI tools that were using dx (or run /mcp in Claude Code) so they pick it up.");
if (mode === "local") console.log("  Back to the npm package: npm run unlink");
