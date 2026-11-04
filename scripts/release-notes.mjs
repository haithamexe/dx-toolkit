// Prints one version's section of CHANGELOG.md, for the GitHub release's notes.
// Usage: node scripts/release-notes.mjs 1.4.0
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("Which version? node scripts/release-notes.mjs 1.4.0");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lines = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n").split("\n");
const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`);
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section. Move the Unreleased changes under it first.`);
  process.exit(1);
}
const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
const body = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
if (!body) {
  console.error(`The ${version} section of CHANGELOG.md is empty.`);
  process.exit(1);
}
console.log(body);
