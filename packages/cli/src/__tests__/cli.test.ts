import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// The dx command as a user runs it, against a dx home and projects folder of its own.
// autoConnectAi: false keeps the first-run setup away from this computer's AI tools.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-cli-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-cli-projects-"));
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));
const bin = fileURLToPath(new URL("../index.js", import.meta.url));
const env = { ...process.env, DX_HOME: home, NO_COLOR: "1" };

function dx(...args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [bin, ...args], { env, encoding: "utf8", cwd: root, timeout: 120_000 });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" });

function project(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { dev: "vite" } }));
  for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), content);
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "first");
  return dir;
}

const todo = project("todo-app", { ".env.example": "API_URL=\nPORT=5173\n", ".gitignore": ".env\n" });
project("shop-website");

test("--version and help", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(dx("--version").out.trim(), pkg.version);
  const help = dx("help");
  assert.equal(help.code, 0);
  for (const name of ["go", "clone", "resume", "status", "env", "https", "deps", "doctor", "test", "traffic", "db"]) assert.match(help.out, new RegExp(`^  ${name} `, "m"), name);
  assert.match(dx("help", "clone").out, /dx clone <git URL or owner\/repo>/);
});

test("an unknown command and a bad option exit with an error", () => {
  const unknown = dx("nope");
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /Unknown command: nope/);
  const bad = dx("clean", "--days", "soon");
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--days must be a whole number/);
});

test("projects lists what's in the projects folder", () => {
  const r = dx("projects", "--json");
  assert.equal(r.code, 0, r.err);
  const names = (JSON.parse(r.out) as { name: string }[]).map((p) => p.name).sort();
  assert.deepEqual(names, ["shop-website", "todo-app"]);
});

test("the journal: log writes a line, and reads it back", () => {
  assert.equal(dx("log", "Fixed the cart total in todo-app").code, 0);
  assert.match(dx("log").out, /Fixed the cart total in todo-app/);
});

test("resume keeps a note for next time", () => {
  assert.equal(dx("resume", "todo-app", "--note", "Next: validate the form").code, 0);
  const r = dx("resume", "todo-app");
  assert.match(r.out, /Note: Next: validate the form/);
  assert.match(r.out, /Journal .*Fixed the cart total in todo-app/);
  const json = JSON.parse(dx("resume", "todo-app", "--json").out) as { session: { note: string; noteBy: string } };
  assert.equal(json.session.noteBy, "you");
  dx("resume", "todo-app", "--clear");
  assert.equal((JSON.parse(dx("resume", "todo-app", "--json").out) as { session: { note?: string } }).session.note, undefined);
});

test("env lists what .env is missing, and exits 1 while something is", () => {
  const before = dx("env", "todo-app");
  assert.equal(before.code, 1);
  assert.match(before.out, /No \.env yet/);
  fs.writeFileSync(path.join(todo, ".env"), "API_URL=http://localhost:4000\nPORT=5173\n");
  const filled = dx("env", "todo-app");
  assert.match(filled.out, /Every variable in \.env\.example has a value/);
  assert.match(filled.out, /No keys or tokens in tracked files/);
  // The .gitignore rules that keep secrets out of git: listed, then added with --gitignore.
  assert.equal(filled.code, 1, "still missing .gitignore rules");
  assert.match(filled.out, /\.gitignore is missing what keeps secrets out of git/);
  assert.match(filled.out, /\*\.pem\s+Private keys and certificates/);
  const fixed = dx("env", "todo-app", "--gitignore");
  assert.equal(fixed.code, 0, fixed.out);
  assert.match(fixed.out, /todo-app: added .*\*\.pem.* to \.gitignore/);
  assert.match(fixed.out, /\.gitignore covers \.env files, private keys, certificates and keystores/);
});

test("status lists repositories with no remote and uncommitted work", () => {
  fs.writeFileSync(path.join(todo, "draft.js"), "x");
  const list = JSON.parse(dx("status", "--json").out) as { project: string; noRemote: boolean; untracked: number }[];
  const t = list.find((w) => w.project === "todo-app");
  assert.ok(t?.noRemote);
  assert.equal(t?.untracked, 1);
  // The .gitignore that dx env --gitignore changed above counts as a changed file.
  assert.match(dx("status").out, /todo-app \(main\)\s+no remote · 1 changed file\(s\) · 1 new file/);
});

test("clone sets up a repository without opening it", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "dx-cli-source-"));
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "api-gateway", private: true, scripts: { dev: "node server.js" } }));
  fs.writeFileSync(path.join(source, ".env.example"), "SECRET=\n");
  git(source, "init", "-q");
  git(source, "add", ".");
  git(source, "commit", "-qm", "first");
  const r = dx("clone", pathToFileURL(source).href, "--name", "api-gateway", "--no-open", "--json");
  assert.equal(r.code, 0, r.out + r.err);
  const result = JSON.parse(r.out) as { dir: string; env: { empty: string[] } };
  assert.equal(result.dir, path.join(root, "api-gateway"));
  assert.deepEqual(result.env.empty, ["SECRET"]);
  assert.ok(fs.existsSync(path.join(root, "api-gateway", ".env")));
  assert.equal(dx("clone", "not a url").code, 1);
});
