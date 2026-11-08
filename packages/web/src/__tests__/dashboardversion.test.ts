import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// After an update, a background dashboard left from the older dx is replaced by this version's,
// with the dev servers it ran started again. A real background dashboard, in a dx home of our own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-version-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-version-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));
const app = path.join(root, "todo-app");
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "todo-app", scripts: { dev: "node server.cjs" } }));
fs.writeFileSync(path.join(app, "server.cjs"), `const s = require("http").createServer((q, r) => r.end("ok")).listen(0, "127.0.0.1", () => console.log("Local: http://localhost:" + s.address().port + "/"));`);

const { ensureDashboard, findDashboard, olderVersion, dxVersion, dashboardInfoPath } = await import("../link.js");

after(async () => {
  const d = await findDashboard();
  if (d) await d.post("/api/shutdown").catch(() => undefined);
});

const pretend = (patch: Record<string, unknown>) => {
  const info = JSON.parse(fs.readFileSync(dashboardInfoPath(), "utf8")) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete info[k];
  else info[k] = v;
  fs.writeFileSync(dashboardInfoPath(), JSON.stringify(info));
};

async function ready(client: Awaited<ReturnType<typeof ensureDashboard>>) {
  for (let i = 0; i < 120; i++) {
    const s = (await client.get<{ dir: string; status: string }[]>("/api/dev")).find((d) => d.dir === app);
    if (s?.status === "ready") return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

test("versions compare as x.y.z, a missing one being the oldest", () => {
  assert.ok(olderVersion("1.7.2", "1.7.3"));
  assert.ok(olderVersion("1.9.0", "1.10.0"));
  assert.ok(olderVersion(undefined, "1.7.3"));
  assert.ok(!olderVersion("1.7.3", "1.7.3"));
  assert.ok(!olderVersion("2.0.0", "1.7.3"));
});

test("a background dashboard from an older dx is replaced, its dev servers started again; a newer one is left alone", async () => {
  const first = await ensureDashboard();
  assert.equal(first.info.version, dxVersion(), "the version is in dashboard.json");
  assert.equal((await first.get<{ version: string }>("/api/ping")).version, dxVersion());
  await first.post("/api/dev/start", { dir: app });
  assert.ok(await ready(first));

  // The same dashboard, but as one from before versions were written down.
  pretend({ version: undefined });
  const second = await ensureDashboard();
  assert.notEqual(second.info.pid, first.info.pid, "a new dashboard");
  assert.deepEqual(second.replaced, { from: "an older dx", servers: ["todo-app"] });
  assert.ok(await ready(second), "the dev server runs again on the new one");

  // One from a newer dx (an AI tool's MCP server can still be the old dx) is never replaced.
  pretend({ version: "999.0.0" });
  const third = await ensureDashboard();
  assert.equal(third.info.pid, second.info.pid);
  assert.equal(third.replaced, undefined);
});
