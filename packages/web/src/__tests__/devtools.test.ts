import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Developing dx through an AI tool: finding dx's own repository among the projects, building and
// testing it as jobs, reading and writing files only inside it, and restarting the dashboard. The
// repository here is made up (a package.json named dx-toolkit with quick scripts).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-devtools-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-devtools-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const repo = path.join(root, "dx-toolkit");
const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
async function call(p: string, body?: unknown) {
  const res = await fetch(new URL(p, dashboard.url), { method: body === undefined ? "GET" : "POST", headers: { "X-DX-Token": dashboard.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as any };
}
const api = async (p: string, body?: unknown) => {
  const r = await call(p, body);
  assert.ok(r.status < 400, `${p}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await dashboard.close();
});

test("without dx's own source among the projects, nothing of it is offered", async () => {
  const info = await api("/api/dev-tools");
  assert.equal(info.repository, null);
  assert.match(info.hint, /isn't one of your projects/);
  assert.equal((await call("/api/dev-tools/run", { task: "build" })).status, 404);
  assert.equal((await call("/api/dev-tools/file?file=README.md")).status, 404);
});

test("dx's repository is found by its package.json; its branch and changes are reported", async () => {
  fs.mkdirSync(path.join(repo, "packages", "core", "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "dx-toolkit", scripts: { build: "node -e \"console.log('built ok')\"", test: "node -e \"console.log('1 failing'); process.exit(1)\"" } }));
  fs.writeFileSync(path.join(repo, "packages", "core", "src", "state.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# dx\n");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=never\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=octocat", "-c", "user.email=octocat@example.com", "add", "-A");
  git("-c", "user.name=octocat", "-c", "user.email=octocat@example.com", "commit", "-qm", "start");
  fs.writeFileSync(path.join(repo, "README.md"), "# dx, changed\n");
  const info = await api("/api/dev-tools");
  assert.deepEqual([info.repository.name, info.repository.branch, info.repository.changedFiles], ["dx-toolkit", "main", 1]);
  assert.match(info.version, /^\d+\.\d+\.\d+/);
});

test("files: listed by part of a name, or found by the text they mention; a file is read from a line; .env stays out", async () => {
  const list = await api("/api/dev-tools/files?search=state");
  assert.deepEqual(list.files, ["packages/core/src/state.ts"]);
  const all = await api("/api/dev-tools/files");
  assert.ok(!all.files.some((f: string) => f.includes(".env")), "never an .env file");
  const found = await api("/api/dev-tools/files?text=export const b");
  assert.ok(found.matches.some((m: string) => m.includes("state.ts:2:")), found.matches.join("\n"));
  const part = await api("/api/dev-tools/file?file=packages/core/src/state.ts&from=2&lines=1");
  assert.deepEqual([part.file, part.lines, part.from, part.to, part.text], ["packages/core/src/state.ts", 4, 2, 2, "export const b = 2;"]);
});

test("a path that isn't inside the repository, or is git's, a build's, node_modules or an .env file, is refused for reading and writing", async () => {
  for (const file of ["../outside.ts", "packages/../../x.ts", "/etc/passwd", "C:/Windows/x.ts", ".env", "packages/core/.env.local", ".git/config", ".git/hooks/pre-commit.js", "node_modules/x/index.js", "packages/core/dist/state.js", "release/x.json", "a\u0000b.ts", "ENV~1.YML", "GIT~1/x.json", "NODE_M~1/p/i.js", "packages/core/x.ts:stream"]) {
    assert.ok([400, 403].includes((await call(`/api/dev-tools/file?file=${encodeURIComponent(file)}`)).status), `read ${JSON.stringify(file)}`);
    assert.ok([400, 403].includes((await call("/api/dev-tools/file", { file, content: "x" })).status), `write ${JSON.stringify(file)}`);
  }
  assert.equal((await call("/api/dev-tools/file", { file: "packages/core/tool.exe", content: "x" })).status, 400, "text files only");
  assert.equal((await call("/api/dev-tools/file", { file: "packages/core/big.ts", content: "x".repeat(512 * 1024 + 1) })).status, 413);
  assert.equal((await call("/api/dev-tools/file", { file: "packages/core/x.ts" })).status, 400, "content is needed");
  assert.equal(fs.readFileSync(path.join(repo, ".env"), "utf8"), "SECRET=never\n", ".env untouched");
});

test("writing a file creates or replaces it, folders included, and git sees it", async () => {
  const made = await api("/api/dev-tools/file", { file: "packages/core/src/new/idea.ts", content: "export const idea = true;\n" });
  assert.deepEqual([made.file, made.created, made.bytes], ["packages/core/src/new/idea.ts", true, 26]);
  assert.equal(fs.readFileSync(path.join(repo, "packages", "core", "src", "new", "idea.ts"), "utf8"), "export const idea = true;\n");
  const again = await api("/api/dev-tools/file", { file: "packages/core/src/new/idea.ts", content: "export const idea = false;\n" });
  assert.equal(again.created, false);
  assert.equal((await api("/api/dev-tools/file?file=packages/core/src/new/idea.ts")).text.trim(), "export const idea = false;");
  const status = await api(`/api/git/status?dir=${encodeURIComponent(repo)}`);
  assert.ok(JSON.stringify(status).includes("idea.ts"), "it shows among the changes");
});

test("build and test run as jobs with fixed commands; one at a time; the end of the output is readable", async () => {
  const job = await api("/api/dev-tools/run", { task: "build" });
  assert.equal(job.command, "npm run build");
  assert.equal((await call("/api/dev-tools/run", { task: "test" })).status, 409, "one job at a time");
  assert.equal((await call("/api/dev-tools/run", { task: "rm -rf" })).status, 400, "only build or test");
  let done = job;
  for (let i = 0; i < 200 && done.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    done = await api(`/api/dev-tools/job?id=${job.id}`);
  }
  assert.equal(done.status, "passed");
  assert.ok(done.output.join("\n").includes("built ok"));
  const failing = await api("/api/dev-tools/run", { task: "test" });
  let t = failing;
  for (let i = 0; i < 200 && t.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 100));
    t = await api(`/api/dev-tools/job?id=${failing.id}&tail=5`);
  }
  assert.deepEqual([t.status, t.code], ["failed", 1]);
  assert.ok(t.output.join("\n").includes("1 failing"));
  assert.equal((await call("/api/dev-tools/job?id=nope")).status, 404);
});

test("restart stops the dashboard after answering, so the next call starts the current build", async () => {
  const r = await api("/api/dev-tools/restart", {});
  assert.equal(r.restarting, true);
  await Promise.race([dashboard.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("the dashboard didn't stop")), 5000))]);
});
