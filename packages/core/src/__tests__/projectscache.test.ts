import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The kept project scan: the same list inside its few seconds, a project made meanwhile found at
// once, a changed one read again, and one that's gone refused, with no waiting for the scan to expire.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-scan-cache-"));
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-scan-home-"));
const { scanProjectsCached, findKnownProject, invalidateProjectScan } = await import("../index.js");
const config = { projectsRoots: [root], ignore: [], scanDepth: 1 } as unknown as Parameters<typeof scanProjectsCached>[0];

const make = (name: string, dev = "node a.js") => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "package.json"), JSON.stringify({ name, scripts: { dev } }));
  return path.join(root, name);
};

test("the scan is kept inside its few seconds", () => {
  invalidateProjectScan();
  const a = make("todo-app");
  const first = scanProjectsCached(config);
  assert.deepEqual(first.map((p) => p.name), ["todo-app"]);
  make("shop-website");
  assert.strictEqual(scanProjectsCached(config), first, "the same list, not a new walk");
  assert.equal(scanProjectsCached(config, 0).length, 2, "a ttl of 0 walks again");
  assert.ok(a);
});

test("a project made meanwhile is found at once, a changed one is read again, a removed one is refused", () => {
  invalidateProjectScan();
  const a = make("api-gateway");
  scanProjectsCached(config);
  const b = make("blog-site");
  assert.equal(findKnownProject(b, config)?.name, "blog-site", "not in the kept scan: a fresh scan finds it");
  assert.equal(findKnownProject(b.toUpperCase(), config)?.name, "blog-site", "case doesn't matter");
  assert.equal(findKnownProject(a, config)?.devCommand, "npm run dev");
  fs.writeFileSync(path.join(a, "package.json"), JSON.stringify({ name: "api-gateway", scripts: { start: "node server.js" } }));
  const again = findKnownProject(a, config);
  assert.match(again?.devCommand ?? "", /npm (run )?start|node server\.js/, "its own files are read again, not taken from the kept scan");
  assert.equal(findKnownProject(path.join(root, "not-a-project"), config), undefined);
  fs.rmSync(b, { recursive: true, force: true });
  assert.equal(findKnownProject(b, config), undefined, "removed: refused although the kept scan still listed it");
});

test("a different set of projects folders is a different scan", () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dx-scan-other-"));
  fs.mkdirSync(path.join(other, "x"));
  fs.writeFileSync(path.join(other, "x", "package.json"), JSON.stringify({ name: "x" }));
  const list = scanProjectsCached({ ...config, projectsRoots: [other] } as typeof config);
  assert.deepEqual(list.map((p) => p.name), ["x"]);
});
