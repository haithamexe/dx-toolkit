import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-gitmessage-test-"));
const { cleanCommitMessage, gitSuggestMessage } = await import("../index.js");

/**
 * A fake `claude` that never reaches the real one: it saves what it was given and answers the
 * way FAKE_CLAUDE_MODE says. A .cmd on Windows (like npm's shim), a shell script elsewhere.
 */
export function fakeClaude(): { cli: string; dir: string; input: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-fake-claude-"));
  fs.writeFileSync(
    path.join(dir, "fake.cjs"),
    `const fs = require("fs"); const path = require("path");
     let input = ""; process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () => {
       fs.writeFileSync(path.join(__dirname, "input.txt"), input);
       fs.writeFileSync(path.join(__dirname, "args.txt"), process.argv.slice(2).join(" "));
       const mode = process.env.FAKE_CLAUDE_MODE || "ok";
       if (mode === "fail") { process.stderr.write("Invalid API key · Please run /login\\n"); process.exit(1); }
       if (mode === "empty") process.exit(0);
       process.stdout.write("\`\`\`\\nAdd the todo list\\n\\nKeeps track of what to buy.\\n\\nCo-Authored-By: Someone <someone@example.com>\\n\`\`\`\\n");
     });`,
  );
  let cli: string;
  if (process.platform === "win32") {
    cli = path.join(dir, "claude.cmd");
    fs.writeFileSync(cli, `@"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
  } else {
    cli = path.join(dir, "claude");
    fs.writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.cjs" "$@"\n`);
    fs.chmodSync(cli, 0o755);
  }
  return { cli, dir, input: () => fs.readFileSync(path.join(dir, "input.txt"), "utf8") };
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-gitmessage-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-q", "-m", "fix: start the shop");
  return { dir, git };
}

test("cleans what claude says into a message", () => {
  assert.equal(cleanCommitMessage("```\nAdd a cart\n```"), "Add a cart");
  assert.equal(cleanCommitMessage('"Add a cart"'), "Add a cart");
  assert.equal(cleanCommitMessage("Add a cart\n\nWhy it matters.\n\nCo-Authored-By: A <a@b>\n🤖 Generated with Claude Code"), "Add a cart\n\nWhy it matters.");
  assert.equal(cleanCommitMessage("Add a cart\r\n\r\n\r\n\r\nBody"), "Add a cart\n\nBody");
});

test("writes a message from the staged diff and the repository's own style, never committing", async () => {
  const { dir, git } = repo();
  const fake = fakeClaude();
  fs.writeFileSync(path.join(dir, "todo.txt"), "buy milk\n");
  await assert.rejects(gitSuggestMessage(dir, { claude: fake.cli }), /Nothing is staged/);
  git("add", "todo.txt");
  const { message } = await gitSuggestMessage(dir, { claude: fake.cli });
  assert.equal(message, "Add the todo list\n\nKeeps track of what to buy.", "fences and the attribution line are gone");
  const input = fake.input();
  assert.ok(input.includes("fix: start the shop"), "the recent subjects, for the style");
  assert.ok(input.includes("+buy milk"), "the staged diff");
  assert.match(input, /No Co-Authored-By lines/);
  assert.equal(fs.readFileSync(path.join(fake.dir, "args.txt"), "utf8"), "-p --max-turns 1 --tools  --strict-mcp-config", "fixed arguments only");
  assert.equal(git("log", "--format=%s").trim(), "fix: start the shop", "nothing was committed");

  // A big diff is cut, with the whole list of files kept.
  fs.writeFileSync(path.join(dir, "big.txt"), `${"x".repeat(100)}\n`.repeat(1200));
  git("add", "big.txt");
  await gitSuggestMessage(dir, { claude: fake.cli });
  const big = fake.input();
  assert.match(big, /cut at 60 KB/);
  assert.ok(big.includes("big.txt") && big.includes("todo.txt"));
  assert.ok(big.length < 70 * 1024);
});

test("says why when claude fails or isn't there", async () => {
  const { dir, git } = repo();
  const fake = fakeClaude();
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  git("add", "b.txt");
  process.env.FAKE_CLAUDE_MODE = "fail";
  try {
    await assert.rejects(gitSuggestMessage(dir, { claude: fake.cli }), (e: any) => e.status === 502 && /Please run \/login/.test(e.message) && /sign in/.test(e.message));
    process.env.FAKE_CLAUDE_MODE = "empty";
    await assert.rejects(gitSuggestMessage(dir, { claude: fake.cli }), /answered with nothing/);
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
  await assert.rejects(gitSuggestMessage(dir, { claude: path.join(fake.dir, "no-such-claude") }), (e: any) => e.status === 502);
});
