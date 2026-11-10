import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The tour for the dashboard asks git for its three answers ahead of time, in parallel; it must say
// the same as the one-go tour, and the prefetched answers must never outlive the call.
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-tourasync-home-"));
const { projectTour, projectTourAsync, gitStdout, withPrefetchedGit } = await import("../index.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-tourasync-proj-"));
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=octocat", "-c", "user.email=octocat@example.com", ...a], { cwd: dir, stdio: "ignore" });
fs.mkdirSync(path.join(dir, "src", "routes"), { recursive: true });
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "shop-website", dependencies: { express: "^4.19.0" }, scripts: { dev: "node src/server.js" } }));
fs.writeFileSync(path.join(dir, "src", "server.js"), 'const app = require("express")();\napp.get("/api/cart", (req, res) => res.json([]));\n');
fs.writeFileSync(path.join(dir, "src", "routes", "orders.js"), 'module.exports = (app) => app.post("/api/orders", () => {});\n');
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-qm", "start");
fs.writeFileSync(path.join(dir, "src", "new.js"), "// not committed yet\n");

test("the async tour says what the one-go tour says", async () => {
  const project = { name: "shop-website", dir };
  const sync = projectTour(project, { events: [] });
  const async_ = await projectTourAsync(project, { events: [] });
  assert.deepEqual({ ...async_, at: "" }, { ...sync, at: "" });
  assert.ok(sync.endpoints.some((e) => e.path === "/api/cart"), JSON.stringify(sync.endpoints));
});

test("prefetched answers are used inside the call and gone after it", async () => {
  const args = ["ls-files", "--cached", "--others", "--exclude-standard"];
  assert.ok(gitStdout(dir, args).includes("src/new.js"), "asked the usual way");
  // A call that changes the files while it runs sees the answer git gave before it started.
  const seen = await withPrefetchedGit(dir, [args], () => {
    fs.writeFileSync(path.join(dir, "src", "later.js"), "// made during the call\n");
    return gitStdout(dir, args);
  });
  assert.ok(!seen.includes("src/later.js"), "the answer asked for ahead of time");
  assert.ok(gitStdout(dir, args).includes("src/later.js"), "after the call it's asked the usual way again");
  assert.ok(gitStdout(dir, ["not-a-command"]) === "", "a git failure is an empty answer, not a throw");
});
