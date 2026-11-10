import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-agentsetup-test-"));
const { DX_ALLOWED_TOOLS, DX_HOOK_COMMAND, applyClaudeSetup, classifyCommand, claudeSetupState, preBashHook, undoClaudeSetup } = await import("../index.js");

function project(name: string, files: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dx-agentsetup-${name}-`));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, scripts: { test: "vitest run", dev: "vite" }, devDependencies: { vitest: "1" } }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  return { name, dir, devCommand: "npm run dev" };
}
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

test("a project is set up for Claude: a note, allowed tools, a hint hook, none of it showing in git; again changes nothing", () => {
  const p = project("todo-app");
  assert.equal(claudeSetupState(p.dir).on, false);
  const did = applyClaudeSetup(p);
  assert.equal(did.length, 3);
  assert.equal(claudeSetupState(p.dir).on, true);

  const note = fs.readFileSync(path.join(p.dir, "CLAUDE.local.md"), "utf8");
  assert.ok(note.includes("run_tests") && note.includes("`todo-app`") && note.includes("vitest run") && note.includes("npm run dev"), "it names this project's own commands");
  const settings = JSON.parse(fs.readFileSync(path.join(p.dir, ".claude", "settings.local.json"), "utf8"));
  for (const t of DX_ALLOWED_TOOLS) assert.ok(settings.permissions.allow.includes(`mcp__dx__${t}`), t);
  assert.ok(!settings.permissions.allow.some((r: string) => /commit|do_risky|delete/.test(r)), "nothing risky is allowed");
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks[0].command, DX_HOOK_COMMAND);

  assert.equal(git(p.dir, "status", "--porcelain", "-uall").trim(), "?? package.json", "git sees only the project's own file: both of dx's are excluded locally");
  assert.ok(!fs.existsSync(path.join(p.dir, ".gitignore")), "the project's own .gitignore isn't touched");

  const before = fs.readFileSync(path.join(p.dir, ".claude", "settings.local.json"), "utf8");
  assert.deepEqual(applyClaudeSetup(p), [], "already in place");
  assert.equal(fs.readFileSync(path.join(p.dir, ".claude", "settings.local.json"), "utf8"), before);
});

test("what the person already had stays, and undo takes out only what dx added", () => {
  const mine = { permissions: { allow: ["Bash(git status)"], deny: ["Read(./.env)"] }, hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo hi" }] }] }, model: "sonnet" };
  const p = project("shop-website", { ".claude/settings.local.json": JSON.stringify(mine), "CLAUDE.local.md": "# My own notes\n\nKeep it short.\n" });
  applyClaudeSetup(p);
  const merged = JSON.parse(fs.readFileSync(path.join(p.dir, ".claude", "settings.local.json"), "utf8"));
  assert.ok(merged.permissions.allow.includes("Bash(git status)"));
  assert.deepEqual(merged.permissions.deny, ["Read(./.env)"]);
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.ok(fs.readFileSync(path.join(p.dir, "CLAUDE.local.md"), "utf8").startsWith("# My own notes"));

  const removed = undoClaudeSetup(p);
  assert.equal(removed.length, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.dir, ".claude", "settings.local.json"), "utf8")), mine, "the file is as it was");
  assert.equal(fs.readFileSync(path.join(p.dir, "CLAUDE.local.md"), "utf8").trim(), "# My own notes\n\nKeep it short.", "the person's own text is left, nothing else");
  assert.equal(claudeSetupState(p.dir).note, false);

  // A project that had nothing is left with nothing.
  const bare = project("api-gateway");
  applyClaudeSetup(bare);
  undoClaudeSetup(bare);
  assert.ok(!fs.existsSync(path.join(bare.dir, "CLAUDE.local.md")));
  assert.ok(!fs.existsSync(path.join(bare.dir, ".claude", "settings.local.json")));
});

test("a settings file that isn't valid JSON is left exactly as it is, and nothing is half done", () => {
  const p = project("docs-site", { ".claude/settings.local.json": "{ // my comments\n}" });
  assert.throws(() => applyClaudeSetup(p), /isn't valid JSON, so dx left it alone/);
  assert.equal(fs.readFileSync(path.join(p.dir, ".claude", "settings.local.json"), "utf8"), "{ // my comments\n}");
  assert.ok(!fs.existsSync(path.join(p.dir, "CLAUDE.local.md")), "no note either");
});

test("shell commands dx has a tool for are told from the rest", () => {
  for (const c of ["npm test", "npm run test:unit", "pnpm test", "yarn test --watch", "bun test", "npx vitest run", "vitest", "npx jest src", "pytest -x", "python -m pytest", "go test ./...", "node --test dist/*.test.js", "cd app && npm test", "CI=1 npm test", "npm run build && npm test"]) assert.equal(classifyCommand(c), "test", c);
  for (const c of ["npm run dev", "npm start", "pnpm dev", "yarn serve", "npx vite", "vite --port 3000", "next dev", "npx astro dev"]) assert.equal(classifyCommand(c), "dev", c);
  for (const c of ["npm run build", "vite build", "vite preview", "git status", "ls -la", "echo npm test", "cat package.json", "npm install", "node server.js"]) assert.equal(classifyCommand(c), undefined, c);
});

test("the hook nudges for a test or dev command in a dx project, and says nothing else; it never decides", () => {
  const p = project("todo-app");
  const call = (command: string, cwd: string, tool = "Bash") => preBashHook(JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }), [{ ...p, root: path.dirname(p.dir), kind: "node", scripts: [], hasGit: true, lastActive: 0 }]);

  const out = JSON.parse(call("npm test", p.dir));
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /run_tests tool \(project "todo-app"\)/);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, "no decision: the command still asks as it would have");
  assert.match(JSON.parse(call("npm run dev", path.join(p.dir, "src"))).hookSpecificOutput.additionalContext, /start_dev_server/);

  assert.equal(call("git status", p.dir), "", "not a test or dev command");
  assert.equal(call("npm test", os.tmpdir()), "", "not inside a dx project");
  assert.equal(call("npm test", p.dir, "Read"), "", "not a shell command");
  assert.equal(preBashHook("not json", []), "");
});

test("a file the repository tracks is never written, and a settings file's line endings are kept", () => {
  const p = project("shop-website", { ".claude/settings.local.json": JSON.stringify({ model: "sonnet" }) });
  git(p.dir, "add", "-f", ".claude/settings.local.json");
  git(p.dir, "-c", "user.email=octocat@example.com", "-c", "user.name=octocat", "commit", "-q", "-m", "settings");
  const before = fs.readFileSync(path.join(p.dir, ".claude", "settings.local.json"), "utf8");
  assert.throws(() => applyClaudeSetup(p), /is committed in this repository, so dx left it alone/);
  assert.equal(fs.readFileSync(path.join(p.dir, ".claude", "settings.local.json"), "utf8"), before, "untouched");
  assert.ok(!fs.existsSync(path.join(p.dir, "CLAUDE.local.md")), "no note either: nothing half done");

  const crlf = project("docs-site", { ".claude/settings.local.json": '{\r\n  "model": "sonnet"\r\n}\r\n' });
  applyClaudeSetup(crlf);
  const written = fs.readFileSync(path.join(crlf.dir, ".claude", "settings.local.json"), "utf8");
  assert.ok(written.includes("\r\n") && !/[^\r]\n/.test(written), "CRLF stays CRLF");
});
