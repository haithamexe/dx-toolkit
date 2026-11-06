import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Warnings about .env files: changed, staged, committed (not a branch switch), and the system's
// notification, given its words as data. A temp repository; no real notification is shown.
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-envwatch-test-"));
const { EnvWatcher, isEnvFileName, alertSettings, notifyOs, envAlertWords } = await import("../index.js");

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shop-website-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "app.js"), "1\n");
  fs.writeFileSync(path.join(dir, ".env.example"), "KEY=\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Start");
  return { dir, git };
}

test(".env files by name, not their examples", () => {
  for (const f of [".env", ".env.local", "config/.env.production", "apps\\web\\.env"]) assert.equal(isEnvFileName(f), true, f);
  for (const f of [".env.example", ".env.sample", "env.js", ".envrc", "my.env.txt"]) assert.equal(isEnvFileName(f), false, f);
});

test("changed, staged and committed are each said once; the first look and a branch switch say nothing", async () => {
  const r = repo();
  fs.writeFileSync(path.join(r.dir, ".env"), "SECRET=1\n");
  const said: string[] = [];
  const w = new EnvWatcher((a) => said.push(`${a.kind}:${a.files.join(",")}`));
  const p = { name: "shop-website", dir: r.dir };
  assert.deepEqual(await w.check([p]), [], "the first look only remembers");

  await new Promise((res) => setTimeout(res, 30));
  fs.writeFileSync(path.join(r.dir, ".env"), "SECRET=22\n");
  await w.check([p]);
  assert.deepEqual(said, ["changed:.env"]);

  r.git("add", "-f", ".env");
  await w.check([p]);
  assert.deepEqual(said.slice(1), ["staged:.env"]);
  await w.check([p]);
  assert.equal(said.length, 2, "still staged: not said again");

  r.git("commit", "-q", "-m", "Oops");
  const [committed] = await w.check([p]);
  assert.equal(committed.kind, "committed");
  assert.equal(committed.commit, r.git("rev-parse", "HEAD").trim());
  assert.match(committed.text, /git rm --cached/);

  // Moving HEAD without a commit (a branch switch) isn't a commit.
  r.git("switch", "-q", "-c", "other", "HEAD~1");
  assert.deepEqual(await w.check([p]), []);

  // Forgotten (alerts turned off), the next look only remembers again.
  w.forget(r.dir);
  fs.writeFileSync(path.join(r.dir, ".env.local"), "X=1\n");
  assert.deepEqual(await w.check([p]), []);
  assert.equal(w.alerts.length, 3);
});

test("alerts are on unless turned off everywhere or for the project; system notifications can be off alone", () => {
  const dir = path.join(os.tmpdir(), "todo-app");
  const key = path.resolve(dir).toLowerCase();
  assert.deepEqual(alertSettings(dir, {}), { on: true, os: true });
  assert.deepEqual(alertSettings(dir, { projectAlerts: { [key]: { osOff: true } } }), { on: true, os: false });
  assert.deepEqual(alertSettings(dir, { projectAlerts: { [key]: { off: true } } }), { on: false, os: false });
  assert.deepEqual(alertSettings(dir, { envAlerts: false }), { on: false, os: false });
});

test("the system's notification gets its words as data, never as part of a command", () => {
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv; input?: string }[] = [];
  const run = (file: string, args: string[], env: NodeJS.ProcessEnv, input?: string) => void calls.push({ file, args, env, input });
  const words = envAlertWords("shop-website", "staged", [".env"]);
  const title = `${words.title} "; Remove-Item -Recurse C:\\ #`;
  notifyOs(title, words.text, { platform: "win32", run });
  assert.equal(calls[0].file, "powershell.exe");
  assert.deepEqual(calls[0].args, ["-NoProfile", "-NonInteractive", "-Command", "-"]);
  assert.equal(calls[0].env.DX_NOTE_TITLE, title);
  assert.ok(!calls[0].input!.includes("Remove-Item"), "the script is dx's own; the words come from the environment");
  assert.match(calls[0].input!, /SecurityElement]::Escape\(\$env:DX_NOTE_TITLE\)/);
  notifyOs(title, words.text, { platform: "darwin", run });
  assert.equal(calls[1].file, "/usr/bin/osascript");
  assert.deepEqual(calls[1].args.slice(-2), [title, words.text]);
  notifyOs(title, words.text, { platform: "linux", run });
  assert.deepEqual(calls[2], { file: "notify-send", args: ["--urgency=critical", "--app-name=dx", "--", title, words.text], env: process.env, input: undefined });
  assert.equal(notifyOs("t", "b"), false, "not while DX_HOME is set (tests, demo homes)");
});
