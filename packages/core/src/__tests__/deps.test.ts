import assert from "node:assert/strict";
import { test } from "node:test";
import { describeVulnerabilities, isMajorBump, parseAuditCounts, parseOutdated } from "../tools/deps.js";

test("parseOutdated reads npm output, flags major updates and missing installs", () => {
  const out = parseOutdated({
    react: { current: "18.3.1", wanted: "18.3.1", latest: "19.2.0", dependent: "app" },
    vite: { current: "6.1.0", wanted: "6.3.5", latest: "6.3.5" },
    zod: { wanted: "3.25.0", latest: "4.1.0" }, // not installed
    eslint: [
      { current: "8.57.0", wanted: "8.57.1", latest: "9.30.0" },
      { current: "8.50.0", wanted: "8.57.1", latest: "9.30.0" },
    ],
    weird: { current: "1.0.0" },
  });
  assert.deepEqual(
    out.map((p) => [p.name, p.current, p.latest, p.major]),
    [
      ["eslint", "8.57.0", "9.30.0", true],
      ["react", "18.3.1", "19.2.0", true],
      ["zod", undefined, "4.1.0", true],
      ["vite", "6.1.0", "6.3.5", false],
    ],
  );
  assert.deepEqual(parseOutdated({}), []);
  assert.deepEqual(parseOutdated(null), []);
});

test("isMajorBump treats 0.x minor bumps as breaking", () => {
  assert.equal(isMajorBump("1.2.3", "2.0.0"), true);
  assert.equal(isMajorBump("1.2.3", "1.9.0"), false);
  assert.equal(isMajorBump("0.4.1", "0.5.0"), true);
  assert.equal(isMajorBump("0.4.1", "0.4.9"), false);
  assert.equal(isMajorBump(undefined, "1.0.0"), false);
});

test("parseAuditCounts reads npm v2 and pnpm totals", () => {
  const npm = parseAuditCounts({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 1, moderate: 2, high: 0, critical: 1, total: 4 } },
  });
  assert.deepEqual(npm, { critical: 1, high: 0, moderate: 2, low: 1, info: 0, total: 4 });
  assert.equal(describeVulnerabilities(npm), "1 critical, 2 moderate, 1 low");

  const pnpm = parseAuditCounts({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 3, critical: 0 } } });
  assert.equal(pnpm?.total, 3);
  assert.equal(describeVulnerabilities({ critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 }), "none");
  assert.equal(parseAuditCounts({ error: { code: "ENOLOCK" } }), undefined);
  assert.equal(describeVulnerabilities(undefined), "?");
});

test("yarn and bun projects are checked against the registry", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { _auditFromRegistry } = await import("../tools/deps.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-deps-yarn-"));
  const write = (file: string, json: unknown) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(json));
  };
  write("package.json", { name: "shop-website", dependencies: { react: "^18.2.0", "@scope/ui": "^2.0.0", local: "workspace:*" }, devDependencies: { vite: "^6.0.0" } });
  write("node_modules/react/package.json", { name: "react", version: "18.2.0" });
  write("node_modules/@scope/ui/package.json", { name: "@scope/ui", version: "2.1.0" });
  write("node_modules/vite/package.json", { name: "vite", version: "6.3.5" });
  write("node_modules/vite/node_modules/esbuild/package.json", { name: "esbuild", version: "0.24.0" });
  const asked: string[] = [];
  let bulk: Record<string, string[]> = {};
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    asked.push(url);
    if (url.endsWith("/advisories/bulk")) {
      bulk = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ esbuild: [{ severity: "moderate" }], react: [{ severity: "high" }, { severity: "low" }] }));
    }
    const versions: Record<string, string> = { react: "19.1.0", "@scope%2fui": "2.1.0", vite: "6.3.5" };
    const name = url.split("/").slice(-2, -1)[0];
    return versions[name] ? new Response(JSON.stringify({ version: versions[name] })) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  const r = await _auditFromRegistry({ name: "shop-website", dir, packageManager: "yarn" } as never, fakeFetch);
  assert.ok(!asked.some((u) => u.includes("/local/")), "workspace packages aren't looked up");
  assert.deepEqual(r.outdated, [{ name: "react", current: "18.2.0", wanted: undefined, latest: "19.1.0", major: true }]);
  assert.deepEqual(bulk.esbuild, ["0.24.0"], "nested packages are audited too");
  assert.equal(r.vulnerabilities?.high, 1);
  assert.equal(r.vulnerabilities?.moderate, 1);
  assert.equal(r.vulnerabilities?.total, 3);
});
