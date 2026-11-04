import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-fixer-test-"));
const { applyFix, gitUndo, gitUndoList, parseFixAnswer, proposeFix, stackLocations } = await import("../index.js");

/**
 * A fake `claude` that never reaches the real one: it saves what it was given and prints
 * answer.txt from its folder (or fails, when fail.txt is there).
 */
function fakeClaude(): { cli: string; dir: string; answer: (text: string) => void; input: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-fake-claude-"));
  fs.writeFileSync(
    path.join(dir, "fake.cjs"),
    `const fs = require("fs"); const path = require("path");
     let input = ""; process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () => {
       fs.writeFileSync(path.join(__dirname, "input.txt"), input);
       fs.writeFileSync(path.join(__dirname, "args.txt"), process.argv.slice(2).join(" "));
       if (fs.existsSync(path.join(__dirname, "fail.txt"))) { process.stderr.write("Invalid API key · Please run /login\\n"); process.exit(1); }
       process.stdout.write(fs.readFileSync(path.join(__dirname, "answer.txt"), "utf8"));
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
  return {
    cli,
    dir,
    answer: (text) => fs.writeFileSync(path.join(dir, "answer.txt"), text),
    input: () => fs.readFileSync(path.join(dir, "input.txt"), "utf8"),
  };
}

const CART = "export function total(cart) {\n  return cart.items.reduce((n, i) => n + i.price, 0);\n}\n";
const read = (file: string) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/** A shop project in a git repository, at its top or (`sub`) in a folder of a bigger one. */
function shop(sub = "") {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dx-fixer-"));
  const dir = sub ? path.join(repo, sub) : repo;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "cart.js"), CART);
  fs.writeFileSync(path.join(dir, "src", "main.js"), 'import { total } from "./cart.js";\n\nconsole.log(total());\n');
  fs.writeFileSync(path.join(dir, ".env"), "SHOP_SECRET=first\n");
  git("add", ".");
  git("commit", "-q", "-m", "Start the shop");
  return { repo, dir, git };
}

function errorIn(dir: string) {
  const cart = path.join(dir, "src", "cart.js");
  return {
    kind: "runtime",
    message: "TypeError: Cannot read properties of undefined (reading 'items')",
    file: cart,
    line: 2,
    column: 15,
    stack: [
      "TypeError: Cannot read properties of undefined (reading 'items')",
      `    at total (${cart}:2:15)`,
      `    at ${pathToFileURL(path.join(dir, "src", "main.js")).href}:3:13`,
      `    at ${path.join(dir, "node_modules", "lib", "index.js")}:1:1`,
      "    at node:internal/modules/run_main:123:5",
    ].join("\n"),
  };
}

const GOOD = [
  "```diff",
  "--- a/src/cart.js",
  "+++ b/src/cart.js",
  "@@ -1,9 +1,9 @@", // wrong counts, as Claude often writes them
  " export function total(cart) {",
  "-  return cart.items.reduce((n, i) => n + i.price, 0);",
  "+  return (cart?.items ?? []).reduce((n, i) => n + i.price, 0);",
  " }",
  "```",
  "",
  "**EXPLANATION:** total() was called without a cart. It now treats a missing cart as empty.",
].join("\n");

test("reads the diff and the explanation from what Claude says, fenced or bare", () => {
  const fencedAnswer = parseFixAnswer(GOOD);
  assert.ok(fencedAnswer.diff.startsWith("--- a/src/cart.js"));
  assert.ok(!fencedAnswer.diff.includes("```"));
  assert.equal(fencedAnswer.explanation, "total() was called without a cart. It now treats a missing cart as empty.");
  const bare = parseFixAnswer("diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\nEXPLANATION: Swapped a for b.");
  assert.ok(bare.diff.startsWith("diff --git"));
  assert.equal(bare.explanation, "Swapped a for b.");
  assert.deepEqual(parseFixAnswer("EXPLANATION: I'd need to see the router."), { diff: "", explanation: "I'd need to see the router." });
  assert.deepEqual(
    stackLocations("Error\n    at f (C:\\shop\\a.js:3:4)\n    at http://localhost:5173/src/App.tsx?t=1:12:5\n  File \"app.py\", line 9, in main\n    at node:internal/x:1:1").map((l) => l.line),
    [3, 12, 9],
  );
});

test("proposes a checked patch from the error and the code around it, and changes nothing", async () => {
  const { dir, git } = shop();
  const fake = fakeClaude();
  fake.answer(GOOD);
  // Uncommitted work is part of what Claude sees; the .env file never is, even when it's tracked.
  fs.writeFileSync(path.join(dir, "src", "main.js"), 'import { total } from "./cart.js";\n\nconsole.log(total(undefined));\n');
  fs.writeFileSync(path.join(dir, ".env"), "SHOP_SECRET=second-value\n");
  const r = await proposeFix(dir, errorIn(dir), { claude: fake.cli });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.ok(r.patch.startsWith("diff --git a/src/cart.js b/src/cart.js"), r.patch);
  assert.ok(r.patch.includes("+  return (cart?.items ?? []).reduce"));
  assert.match(r.patch, /@@ -1,3 \+1,3 @@/, "git's own counts");
  assert.deepEqual(r.files, ["src/cart.js"]);
  assert.equal(r.explanation, "total() was called without a cart. It now treats a missing cart as empty.");
  assert.equal(read(path.join(dir, "src", "cart.js")), CART, "nothing changed on disk");

  const input = fake.input();
  assert.equal(fs.readFileSync(path.join(fake.dir, "args.txt"), "utf8"), "-p --max-turns 1", "fixed arguments only");
  assert.ok(input.includes("TypeError: Cannot read properties of undefined"), "the error");
  assert.ok(input.includes("The file src/cart.js (all 3 lines)"), "the file it happened in");
  assert.ok(input.includes("return cart.items.reduce"), "its code");
  assert.ok(input.includes("Other project files in the stack:") && input.includes("src/main.js"), "the stack's own files");
  assert.ok(input.includes("+console.log(total(undefined));"), "the uncommitted changes");
  assert.ok(!input.includes("second-value") && !input.includes("SHOP_SECRET"), ".env is never sent");
  assert.ok(!input.includes("node_modules/lib/index.js (all"), "library files aren't read");
  assert.match(input, /smallest change/);
  assert.equal(git("status", "--porcelain").trim().split("\n").length, 2, "only the two edits made above");
});

test("applies the fix as unstaged changes, with Undo on the Git page bringing the old file back", async () => {
  const { dir, git } = shop();
  const fake = fakeClaude();
  fake.answer(GOOD);
  const r = await proposeFix(dir, errorIn(dir), { claude: fake.cli });
  assert.ok(r.ok);
  if (!r.ok) return;
  const applied = await applyFix(dir, r);
  assert.deepEqual(applied.files, ["src/cart.js"]);
  assert.ok(read(path.join(dir, "src", "cart.js")).includes("(cart?.items ?? [])"));
  assert.equal(git("status", "--porcelain").trim(), "M src/cart.js", "changed in the working tree, not staged");

  const undo = await gitUndoList(dir);
  assert.equal(undo.entries[0].id, applied.undoId);
  assert.match(undo.entries[0].label, /Claude's fix to src\/cart\.js/);
  await gitUndo(dir, applied.undoId);
  assert.equal(read(path.join(dir, "src", "cart.js")), CART, "the file as it was");
  assert.equal(git("status", "--porcelain").trim(), "");
});

test("refuses to apply when a file changed since Claude looked at it", async () => {
  const { dir } = shop();
  const fake = fakeClaude();
  fake.answer(GOOD);
  const r = await proposeFix(dir, errorIn(dir), { claude: fake.cli });
  assert.ok(r.ok);
  if (!r.ok) return;
  fs.appendFileSync(path.join(dir, "src", "cart.js"), "// edited meanwhile\n");
  await assert.rejects(applyFix(dir, r), (e: any) => e.status === 409 && /changed since Claude looked/.test(e.message));
  assert.ok(read(path.join(dir, "src", "cart.js")).endsWith("// edited meanwhile\n"), "left alone");
});

test("creates a new file when the fix needs one, and Undo removes it", async () => {
  const { dir } = shop();
  const fake = fakeClaude();
  fake.answer(["--- /dev/null", "+++ b/src/empty.js", "@@ -0,0 +1 @@", "+export const EMPTY_CART = { items: [] };", "EXPLANATION: Adds an empty cart."].join("\n"));
  const r = await proposeFix(dir, errorIn(dir), { claude: fake.cli });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.match(r.patch, /new file mode/);
  const applied = await applyFix(dir, r);
  assert.ok(fs.existsSync(path.join(dir, "src", "empty.js")));
  await gitUndo(dir, applied.undoId);
  assert.ok(!fs.existsSync(path.join(dir, "src", "empty.js")));
});

test("a project in a folder of a bigger repository: paths are the project's, the patch is the repository's", async () => {
  const { dir } = shop("packages/shop");
  const fake = fakeClaude();
  fake.answer(GOOD);
  const r = await proposeFix(dir, errorIn(dir), { claude: fake.cli });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.files, ["packages/shop/src/cart.js"]);
  await applyFix(dir, r);
  assert.ok(read(path.join(dir, "src", "cart.js")).includes("(cart?.items ?? [])"));
});

test("an answer without a usable patch is shown with why, and nothing is applied", async () => {
  const { dir } = shop();
  const fake = fakeClaude();
  const cases: [string, RegExp][] = [
    ["I think the cart is undefined somewhere.", /didn't propose a change/],
    [GOOD.replace(/src\/cart\.js/g, "../outside.js"), /isn't a path inside the project/],
    [GOOD.replace(/src\/cart\.js/g, "node_modules/lib/index.js"), /under node_modules/],
    [GOOD.replace(/src\/cart\.js/g, ".env"), /secrets, key or lock file/],
    [GOOD.replace("return cart.items", "return cart.things"), /doesn't fit the files as they are now/],
    [GOOD.replace("+++ b/src/cart.js", "+++ b/src/basket.js"), /renames/],
  ];
  for (const [answer, why] of cases) {
    fake.answer(answer);
    const r = await proposeFix(dir, errorIn(dir), { claude: fake.cli });
    assert.equal(r.ok, false, answer);
    if (r.ok) continue;
    assert.match(r.reason, why);
    assert.equal(r.answer, answer.trim(), "Claude's own words, to show");
  }
  assert.equal(read(path.join(dir, "src", "cart.js")), CART);
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), "outside.js")));
});

test("says why when claude fails, isn't there, or the project has no git", async () => {
  const { dir } = shop();
  const fake = fakeClaude();
  fake.answer(GOOD);
  fs.writeFileSync(path.join(fake.dir, "fail.txt"), "");
  await assert.rejects(proposeFix(dir, errorIn(dir), { claude: fake.cli }), (e: any) => e.status === 502 && /Please run \/login/.test(e.message) && /sign in/.test(e.message));
  await assert.rejects(proposeFix(dir, errorIn(dir), { claude: path.join(fake.dir, "no-such-claude") }), (e: any) => e.status === 502);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "dx-fixer-plain-"));
  await assert.rejects(proposeFix(plain, errorIn(plain), { claude: fake.cli }), /works in git projects/);
});
