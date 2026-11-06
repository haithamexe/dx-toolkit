// Checks, at release time, that the Electron the dx app installs (core's ELECTRON_VERSION) is the
// newest release of its line and that its line still gets security fixes (Electron supports its
// newest three major versions). Fails with the version to pin otherwise. It reads npm's registry,
// so it runs before a release (release.yml, and by hand), not on every push.
//
//   node scripts/check-electron.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "packages", "core", "src", "tools", "appshell.ts"), "utf8");
const pinned = /ELECTRON_VERSION = "(\d+\.\d+\.\d+)"/.exec(source)?.[1];
if (!pinned) {
  console.error("Couldn't find ELECTRON_VERSION in packages/core/src/tools/appshell.ts.");
  process.exit(1);
}

const res = await fetch("https://registry.npmjs.org/electron", { headers: { accept: "application/vnd.npm.install-v1+json" } });
if (!res.ok) {
  console.error(`npm's registry answered ${res.status}.`);
  process.exit(1);
}
const tags = (await res.json())["dist-tags"] ?? {};
const latest = tags.latest;
const major = Number(pinned.split(".")[0]);
const newestOfLine = tags[`${major}-x-y`];
const oldestSupported = Number(String(latest).split(".")[0]) - 2;

const problems = [];
if (major < oldestSupported) problems.push(`Electron ${major} no longer gets security fixes (supported: ${oldestSupported} to ${latest.split(".")[0]}). Pin ${latest}.`);
else if (newestOfLine && newestOfLine !== pinned) problems.push(`Electron ${major}'s newest release is ${newestOfLine}, not ${pinned}. Pin ${newestOfLine} (or ${latest}).`);

if (problems.length) {
  for (const p of problems) console.error(p);
  console.error("Set ELECTRON_VERSION in packages/core/src/tools/appshell.ts, then try the app (dx ui) before releasing.");
  process.exit(1);
}
console.log(`Electron ${pinned} is the newest of its line (latest: ${latest}).`);
