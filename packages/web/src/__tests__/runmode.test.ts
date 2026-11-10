import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Run as: a project's own mode from .devrc.json (a build, then its server) with a .env.<name> file
// laid over it. The build must run first, the values must reach the process and never the log,
// Restart must run it the same way, and a mode or file the project doesn't have is refused.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-runmode-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-runmode-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0, activity: false }));

const dir = path.join(root, "todo-app");
fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
fs.writeFileSync(path.join(dir, ".devrc.json"), JSON.stringify({ dev: "node server.cjs", modes: { qa: { label: "QA build", build: "node build.cjs", run: "node server.cjs", env: ".env.qa" } } }));
fs.writeFileSync(path.join(dir, ".env.qa"), "GREETING=hello-from-qa\n");
fs.writeFileSync(path.join(dir, "build.cjs"), `require("fs").writeFileSync(require("path").join(__dirname, "built.txt"), "yes"); console.log("built");`);
fs.writeFileSync(
  path.join(dir, "server.cjs"),
  `const http = require("http");
   const s = http.createServer((q, r) => r.end(String(process.env.GREETING || "none") + "|" + require("fs").existsSync(require("path").join(__dirname, "built.txt"))));
   s.listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port));`,
);

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
const call = async (p: string, body?: unknown) => {
  const res = await fetch(new URL(p, dashboard.url), { method: body === undefined ? "GET" : "POST", headers: { "X-DX-Token": dashboard.token, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const ready = async () => {
  for (let i = 0; i < 120; i++) {
    const list = (await call("/api/dev")).body as { dir: string; status: string; url?: string; run?: { mode: string; envFile?: string } }[];
    const s = list.find((x) => x.dir === dir);
    if (s?.status === "ready" && s.url) return s;
    if (s?.status === "failed") throw new Error("failed");
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("never ready");
};

before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  await call("/api/dev/stop", { dir }).catch(() => undefined);
  await dashboard.close();
});

test("the projects list offers the project's own modes and env files, by name and count only", async () => {
  const p = ((await call("/api/projects")).body as any[]).find((x) => x.dir === dir);
  assert.deepEqual(p.runModes.map((m: any) => m.id), ["devrc:qa"]);
  assert.deepEqual(p.envFiles, [{ file: ".env.qa", name: "qa", count: 1 }]);
  assert.ok(!JSON.stringify(p).includes("hello-from-qa"), "no values in the list");
});

test("a mode or env file the project doesn't have is refused", async () => {
  assert.equal((await call("/api/dev/start", { dir, mode: "devrc:nope" })).status, 400);
  assert.equal((await call("/api/dev/start", { dir, env: "../secrets" })).status, 400);
  assert.equal((await call("/api/dev/start", { dir, env: ".env.missing" })).status, 400);
});

test("Run as: the build runs first, the env file's values reach the server, and Restart keeps both", async () => {
  const started = await call("/api/dev/start", { dir, mode: "devrc:qa" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const s = await ready();
  assert.deepEqual(s.run, { mode: "devrc:qa", label: "QA build", envFile: ".env.qa" });
  assert.equal(await (await fetch(s.url!)).text(), "hello-from-qa|true");
  const logs = JSON.stringify((await call(`/api/dev/logs?dir=${encodeURIComponent(dir)}`)).body);
  assert.ok(logs.includes("built"), "the build's output is in the log");
  assert.ok(!logs.includes("hello-from-qa"), "values never reach the log");

  fs.rmSync(path.join(dir, "built.txt"));
  await call("/api/dev/restart", { dir });
  const again = await ready();
  assert.equal(again.run?.mode, "devrc:qa");
  assert.equal(await (await fetch(again.url!)).text(), "hello-from-qa|true", "built again, same values");
});
