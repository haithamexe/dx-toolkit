import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-autosetup-test-"));
const { autoFixConfig, autoSetupTick, defaultConfig, loadConfig, saveConfig } = await import("../index.js");

function project(name: string, files: Record<string, string>): { dir: string; name: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dx-autosetup-${name}-`));
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-q");
  run("config", "user.email", "octocat@example.com");
  run("config", "user.name", "octocat");
  return { dir, name };
}

test("a project dx already knew is remembered, never touched; a new one with an exposed .env gets its rules, once", async () => {
  const old = project("todo-app", { ".env": "SECRET=1\n" });
  // The first look ever only remembers.
  assert.deepEqual(await autoSetupTick([old]), []);
  assert.equal(fs.existsSync(path.join(old.dir, ".gitignore")), false, "an existing project is left alone");

  const fresh = project("shop-website", { ".env": "SECRET=1\n", ".env.example": "SECRET=\n" });
  const notices = await autoSetupTick([old, fresh]);
  assert.equal(notices.length, 2, "its .gitignore, and its Claude Code sessions pointed at dx");
  assert.ok(notices.some((n) => /shop-website: added .*\.env/.test(n.text)));
  assert.ok(notices.some((n) => /Claude Code sessions here now run and test through dx/.test(n.text)));
  assert.ok(fs.existsSync(path.join(fresh.dir, "CLAUDE.local.md")), "the Claude note is there for a new project");
  assert.ok(!fs.existsSync(path.join(old.dir, "CLAUDE.local.md")), "and not for one dx already knew");
  const ignore = fs.readFileSync(path.join(fresh.dir, ".gitignore"), "utf8");
  assert.ok(ignore.includes(".env"));
  assert.ok(ignore.includes("!.env.example"), "the example file stays shared");

  // Handled once: the same project later isn't looked at again (and its file isn't appended twice).
  const before = fs.readFileSync(path.join(fresh.dir, ".gitignore"), "utf8");
  assert.deepEqual(await autoSetupTick([old, fresh]), []);
  assert.equal(fs.readFileSync(path.join(fresh.dir, ".gitignore"), "utf8"), before);
});

test("a new project with no .env file, or with its rules already there, is left as it is", async () => {
  const quiet = project("api-gateway", { "README.md": "# api\n" });
  const covered = project("docs-site", { ".env": "A=1\n", ".gitignore": ".env\n.env.*\n!.env.example\n*.pem\n*.key\n*.p12\n*.pfx\n*.jks\n*.keystore\nid_rsa*\nid_ed25519*\n" });
  const notices = await autoSetupTick([quiet, covered]);
  assert.ok(!notices.some((n) => /\.gitignore/.test(n.text)), "no .gitignore change was needed or made");
  assert.equal(fs.existsSync(path.join(quiet.dir, ".gitignore")), false);
});

test("a doctor finding dx can fix is fixed without asking: a missing editor, and no projects folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-autofix-root-"));
  fs.mkdirSync(path.join(root, "todo-app"));
  fs.writeFileSync(path.join(root, "todo-app", "package.json"), "{}");
  saveConfig({ ...defaultConfig(), projectsRoots: [root], editor: "no-such-editor-xyz" });
  // node is on PATH wherever these tests run.
  const did = await autoFixConfig({ editor: () => "node" });
  assert.equal(did.length, 1);
  assert.match(did[0], /Editor: "no-such-editor-xyz" isn't on this computer, so dx now opens projects with node/);
  assert.equal(loadConfig().editor, "node");
  assert.deepEqual(await autoFixConfig({ editor: () => "node" }), [], "nothing left to fix");

  // No project in the list's folder, but the usual code folder holds one.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-autofix-home-"));
  fs.mkdirSync(path.join(home, "projects", "shop-website"), { recursive: true });
  fs.writeFileSync(path.join(home, "projects", "shop-website", "package.json"), "{}");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dx-autofix-empty-"));
  saveConfig({ ...defaultConfig(), projectsRoots: [empty], editor: "node" });
  const added = await autoFixConfig({ home });
  assert.equal(added.length, 1);
  assert.ok(loadConfig().projectsRoots.some((r) => r.toLowerCase() === path.join(home, "projects").toLowerCase()));
});
