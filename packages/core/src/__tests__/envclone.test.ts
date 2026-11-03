import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-envclone-test-"));
const { defaultConfig } = await import("../config.js");
const { checkEnv, ensureEnvFile, parseDotenv } = await import("../tools/envcheck.js");
const { cloneProject, normalizeGitUrl, repoName } = await import("../tools/clone.js");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" });

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-env-repo-"));
  git(dir, "init", "-q");
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test("parseDotenv reads the forms dotenv accepts", () => {
  const m = parseDotenv(['# comment', "export A=1", 'B="two words"', "C='x # not a comment'", "D=plain # comment", "E=", "not a line"].join("\n"));
  assert.deepEqual([...m.entries()], [
    ["A", "1"],
    ["B", "two words"],
    ["C", "x # not a comment"],
    ["D", "plain"],
    ["E", ""],
  ]);
});

test("lists variables the example has and .env doesn't set", () => {
  const dir = repo({ ".env.example": "DATABASE_URL=\nAPI_KEY=\nPORT=3000\n", ".env": "DATABASE_URL=postgres://localhost/shop\nAPI_KEY=\n", ".gitignore": ".env\n" });
  const r = checkEnv(dir);
  assert.deepEqual(r.missing, ["PORT"]);
  assert.deepEqual(r.empty, ["API_KEY"]);
  assert.deepEqual(r.tracked, []);
  assert.deepEqual(r.notIgnored, []);
});

test("ensureEnvFile copies the example only when there is no .env", () => {
  const dir = repo({ ".env.example": "A=1\n" });
  assert.equal(ensureEnvFile(dir), path.join(dir, ".env"));
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "A=1\n");
  assert.equal(ensureEnvFile(dir), undefined);
});

test("finds committed .env files, unignored ones and keys in tracked files", () => {
  // Built from pieces, so this file itself doesn't look like it holds a key.
  const githubToken = "gh" + "p_" + "A1b2C3d4".repeat(4) + "Z9y8";
  const awsKey = "AK" + "IA" + "ABCDEFGHIJKLMNOP";
  const privateKey = "-----BEGIN " + "RSA PRIVATE KEY-----";
  const dir = repo({
    "src/config.js": `export const token = "${githubToken}";\n`,
    "deploy/aws.json": `{"key": "${awsKey}"}\n`,
    "keys/id_rsa": `${privateKey}\nabc\n`,
    "README.md": "Set API_KEY=your-key-here in .env\n",
    ".env.production": "SECRET=1\n",
  });
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "first");
  fs.writeFileSync(path.join(dir, ".env"), "LOCAL=1\n");
  const r = checkEnv(dir);
  assert.deepEqual(r.tracked, [".env.production"]);
  assert.deepEqual(r.notIgnored, [".env"]);
  const kinds = r.secrets.map((s) => `${s.kind}@${s.file}:${s.line}`).sort();
  assert.deepEqual(kinds, ["AWS access key@deploy/aws.json:1", "GitHub token@src/config.js:1", "Private key@keys/id_rsa:1"]);
  for (const s of r.secrets) assert.ok(!s.preview.includes(githubToken) && !s.preview.includes(awsKey), "the value is masked");
});

test("normalizeGitUrl accepts git addresses and refuses anything else", () => {
  assert.equal(normalizeGitUrl("octocat/todo-app"), "https://github.com/octocat/todo-app.git");
  assert.equal(normalizeGitUrl("https://github.com/octocat/todo-app.git"), "https://github.com/octocat/todo-app.git");
  assert.equal(normalizeGitUrl("git@github.com:octocat/todo-app.git"), "git@github.com:octocat/todo-app.git");
  assert.equal(normalizeGitUrl("--upload-pack=touch x"), undefined);
  assert.equal(normalizeGitUrl("https://example.com/a b"), undefined);
  assert.equal(normalizeGitUrl("../outside"), undefined);
  assert.equal(repoName("https://github.com/octocat/todo-app.git"), "todo-app");
  assert.equal(repoName("git@github.com:octocat/shop-website"), "shop-website");
});

test("clone installs packages and creates .env from the example", async () => {
  const source = repo({
    "package.json": JSON.stringify({ name: "todo-app", version: "1.0.0", private: true, scripts: { dev: "node server.js" } }),
    ".env.example": "PORT=3000\nSTRIPE_KEY=\n",
    ".gitignore": ".env\nnode_modules\n",
  });
  git(source, "add", ".");
  git(source, "commit", "-qm", "first");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-clone-root-"));
  const config = { ...defaultConfig(), projectsRoots: [root] };
  const url = pathToFileURL(source).href;
  const result = await cloneProject({ url, name: "todo-app", config, source: "test" });
  assert.equal(result.dir, path.join(root, "todo-app"));
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.ok(fs.existsSync(path.join(result.dir, "package-lock.json")), "npm install ran");
  // git may check the file out with CRLF line endings on Windows.
  assert.equal(fs.readFileSync(path.join(result.dir, ".env"), "utf8").replace(/\r\n/g, "\n"), "PORT=3000\nSTRIPE_KEY=\n");
  assert.deepEqual(result.env?.empty, ["STRIPE_KEY"]);
  assert.equal(result.runs, "npm run dev");
  await assert.rejects(cloneProject({ url, name: "todo-app", config }), /already exists/);
});
