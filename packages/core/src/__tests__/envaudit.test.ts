import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-envaudit-test-"));
const { addGitignoreRules, auditEnv, findEnvFiles, matchesGitignore, moveDevPort, readEnvFile, toolOf, writeEnvFile, GITIGNORE_RULES } = await import("../index.js");

function project(files: Record<string, string>, git = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-envaudit-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  if (git) {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    run("init", "-q");
    run("config", "user.email", "octocat@example.com");
    run("config", "user.name", "octocat");
  }
  return dir;
}

test(".gitignore lines read the way git reads them", () => {
  const lines = [".env", ".env.*", "!.env.example", "*.pem", "secrets/", "/root-only.key", "docs/**/*.p12"];
  assert.ok(matchesGitignore(lines, ".env"));
  assert.ok(matchesGitignore(lines, "apps/web/.env"), "a name without a slash matches at any depth");
  assert.ok(matchesGitignore(lines, ".env.local"));
  assert.ok(!matchesGitignore(lines, ".env.example"), "! un-ignores");
  assert.ok(matchesGitignore(lines, "certs/server.pem"));
  assert.ok(matchesGitignore(lines, "secrets/token.txt"), "a folder rule ignores what's in it");
  assert.ok(!matchesGitignore(lines, "secrets"), "a folder rule doesn't match a file of that name");
  assert.ok(matchesGitignore(lines, "root-only.key"));
  assert.ok(!matchesGitignore(lines, "nested/root-only.key"), "a leading slash anchors to the root");
  assert.ok(matchesGitignore(lines, "docs/a/b/c.p12"));
  assert.ok(!matchesGitignore(["# .env", ""], ".env"), "comments and blank lines don't count");
});

test("finds .env files in the project and its folders, not in node_modules or build output", () => {
  const dir = project(
    {
      ".env": "A=1\n",
      ".env.example": "A=\nB=\n",
      "apps/web/.env.local": "X=1\n",
      "apps/api/config.env": "Y=1\n",
      "node_modules/pkg/.env": "NO=1\n",
      "dist/.env": "NO=1\n",
      "src/environment.ts": "",
    },
    false,
  );
  assert.deepEqual(findEnvFiles(dir), [".env", ".env.example", "apps/api/config.env", "apps/web/.env.local"]);
});

test("audit: what git would commit, what it tracks, and what .gitignore is missing", () => {
  const dir = project({ ".gitignore": "node_modules\n", ".env": "SECRET=s\nEMPTY=\n", ".env.example": "SECRET=\nEMPTY=\nMISSING=\n", ".env.production": "SECRET=prod\n", "server.js": "" });
  execFileSync("git", ["add", ".gitignore", ".env.production", ".env.example", "server.js"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  const a = auditEnv(dir);
  assert.equal(a.git, true);
  assert.equal(a.gitignore, true);
  const byName = Object.fromEntries(a.files.map((f) => [f.name, f]));
  assert.equal(byName[".env"].notIgnored, true, "git add . would commit it");
  assert.equal(byName[".env"].keys, 2);
  assert.equal(byName[".env.production"].tracked, true, "committed already");
  assert.equal(byName[".env.example"].example, true);
  assert.equal(byName[".env.example"].notIgnored, false, "the example is meant to be shared");
  assert.deepEqual(a.missingVars, ["MISSING"]);
  assert.deepEqual(a.emptyVars, ["EMPTY"]);
  assert.equal(a.rules.length, GITIGNORE_RULES.length);
  assert.ok(a.rules.every((r) => !r.covered));
  assert.equal(a.problems, 3, ".env not ignored, .env.production committed, and the missing rules count once");

  const added = addGitignoreRules(dir, a.rules.map((r) => r.pattern));
  assert.deepEqual(added, [...GITIGNORE_RULES.map((r) => r.pattern), "!.env.example"]);
  const text = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.ok(text.startsWith("node_modules\n\n# Secrets"), text);
  const after = auditEnv(dir);
  assert.ok(after.rules.every((r) => r.covered));
  assert.equal(after.files.find((f) => f.name === ".env")?.notIgnored, false, "git ignores it now");
  assert.equal(after.exampleIgnored, false);
  assert.deepEqual(addGitignoreRules(dir, [".env"]), [], "nothing twice");
  assert.deepEqual(addGitignoreRules(dir, ["node_modules", "../evil"]), [], "only the rules dx knows");
});

test("no .gitignore at all, and an example that's ignored by mistake", () => {
  const none = project({ ".env": "A=1\n" }, false);
  const a = auditEnv(none);
  assert.equal(a.gitignore, false);
  assert.equal(a.files[0].notIgnored, true);
  assert.equal(a.problems, 2);
  const added = addGitignoreRules(none, [".env"]);
  assert.deepEqual(added, [".env"]);
  assert.equal(fs.readFileSync(path.join(none, ".gitignore"), "utf8"), "# Secrets: keys, certificates and local settings stay out of git (OWASP)\n.env\n");

  const ignoredExample = project({ ".gitignore": ".env*\n", ".env.example": "A=\n" }, false);
  assert.equal(auditEnv(ignoredExample).exampleIgnored, true);
});

test("reading and saving .env files: only .env files, only inside the project", () => {
  const dir = project({ ".env": "A=1\n", "apps/web/.env.local": "B=2\n", "notes.txt": "x", "node_modules/x/.env": "N=1\n" }, false);
  assert.equal(readEnvFile(dir, ".env"), "A=1\n");
  assert.equal(readEnvFile(dir, "apps/web/.env.local"), "B=2\n");
  writeEnvFile(dir, ".env", "A=2\r\nC=3\r\n");
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "A=2\r\nC=3\r\n", "saved exactly, line endings included");
  writeEnvFile(dir, ".env.local", "NEW=1\n");
  assert.equal(fs.readFileSync(path.join(dir, ".env.local"), "utf8"), "NEW=1\n", "a new .env file next to the others");
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes(".tmp")),
    [],
    "no temp file left",
  );
  for (const bad of ["notes.txt", "../.env", "..\\.env", "/etc/.env", "apps/../../.env", "node_modules/x/.env", "", "apps//.env"]) {
    assert.throws(() => readEnvFile(dir, bad), /Not a \.env file|Not inside|doesn't exist|isn't a plain file/, bad);
    assert.throws(() => writeEnvFile(dir, bad, "X=1"), /Not a \.env file|Not inside|isn't a plain file|ENOENT/, bad);
  }
  assert.throws(() => readEnvFile(dir, ".env.missing"), /doesn't exist/);
  assert.throws(() => writeEnvFile(dir, ".env", "x".repeat(300 * 1024)), /256 KB/);
  assert.throws(() => writeEnvFile(dir, ".env", "A=\0"), /NUL/);
});

test("a dev server is moved only when dx knows how to tell its tool the port", () => {
  const p = (script: string, pm = "npm") => {
    const dir = project({ "package.json": JSON.stringify({ name: "app", scripts: { dev: script } }) }, false);
    return { name: "app", dir, devCommand: `${pm} run dev` } as Parameters<typeof moveDevPort>[0];
  };
  assert.deepEqual(moveDevPort(p("vite"), 51234), { command: "npm run dev -- --port 51234 --strictPort", env: { PORT: "51234" }, tool: "vite" });
  assert.equal(moveDevPort(p("vite --host", "pnpm"), 51234)?.command, "pnpm run dev --port 51234 --strictPort");
  assert.equal(moveDevPort(p("next dev"), 4000)?.command, "npm run dev -- -p 4000");
  assert.equal(moveDevPort(p("astro dev"), 4000)?.command, "npm run dev -- --port 4000");
  assert.equal(moveDevPort(p("react-scripts start"), 4000)?.command, "npm run dev", "react-scripts takes PORT only");
  assert.equal(moveDevPort(p("cross-env NODE_ENV=development vite"), 4000)?.tool, "vite");
  assert.equal(moveDevPort(p("vite --port 3000"), 4000), undefined, "a port of its own");
  assert.equal(moveDevPort(p("PORT=3000 next dev"), 4000), undefined);
  assert.equal(moveDevPort(p("concurrently \"vite\" \"node api.js\""), 4000), undefined, "a tool dx doesn't know");
  assert.equal(moveDevPort(p("vite & node api.js"), 4000), undefined, "several commands");
  assert.equal(moveDevPort(p("node server.js"), 4000), undefined);
  assert.equal(moveDevPort({ name: "x", dir: "/nowhere", devCommand: "go run ." } as Parameters<typeof moveDevPort>[0], 4000), undefined);
  assert.equal(toolOf("next start"), undefined, "not a dev server");
  assert.equal(toolOf("npx vite"), "vite");
  assert.equal(toolOf("vite build"), undefined);
});
