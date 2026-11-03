import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../config.js";
import { findProjects, getProjectPort, guessDevUrl, scanProjects } from "../tools/projects.js";

function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-projects-"));
  const write = (rel: string, content = "") => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("shop-website/package.json", JSON.stringify({ scripts: { dev: "next dev -p 3001", build: "next build" } }));
  write("shop-website/pnpm-lock.yaml");
  write("todo-app/package.json", JSON.stringify({ packageManager: "yarn@4.1.0", scripts: { dev: "vite" } }));
  write("api-gateway/go.mod", "module x");
  write("archive/old-thing/package.json", JSON.stringify({ scripts: { start: "node index.js" } }));
  write("archive/old-thing/node_modules/dep/package.json", "{}");
  write("custom/.devrc.json", JSON.stringify({ name: "custom-app", dev: "make serve", url: "http://localhost:9000" }));
  write("not-a-project/readme.txt", "hello");
  write(".claude/package.json", "{}");
  write("node_modules/x/package.json", "{}");
  return root;
}

test("scans projects, detects kind, package manager, dev command and url", () => {
  const root = makeTree();
  const config = { ...defaultConfig(), projectsRoots: [root] };
  const projects = scanProjects(config);
  const byName = Object.fromEntries(projects.map((p) => [p.name, p]));

  assert.deepEqual(Object.keys(byName).sort(), ["api-gateway", "custom-app", "old-thing", "shop-website", "todo-app"]);

  assert.equal(byName["shop-website"].packageManager, "pnpm");
  assert.equal(byName["shop-website"].devCommand, "pnpm run dev");
  assert.equal(byName["shop-website"].url, "http://localhost:3001");
  assert.equal(byName["shop-website"].urlGuessed, true);

  assert.equal(byName["todo-app"].packageManager, "yarn");
  assert.equal(byName["todo-app"].url, "http://localhost:5173");

  assert.equal(byName["api-gateway"].kind, "go");
  assert.equal(byName["api-gateway"].devCommand, "go run .");

  assert.equal(byName["old-thing"].devCommand, "npm run start");
  assert.equal(byName["old-thing"].url, undefined);

  assert.equal(byName["custom-app"].devCommand, "make serve");
  assert.equal(byName["custom-app"].urlGuessed, false);
  assert.equal(getProjectPort(byName["custom-app"]), 9000);
});

test("scanDepth 1 skips nested folders", () => {
  const root = makeTree();
  const projects = scanProjects({ ...defaultConfig(), projectsRoots: [root], scanDepth: 1 });
  assert.ok(!projects.some((p) => p.name === "old-thing"));
});

test("ignore list is respected", () => {
  const root = makeTree();
  const projects = scanProjects({ ...defaultConfig(), projectsRoots: [root], ignore: ["archive"] });
  assert.ok(!projects.some((p) => p.name === "old-thing"));
});

test("findProjects picks a clear winner or returns candidates", () => {
  const root = makeTree();
  const projects = scanProjects({ ...defaultConfig(), projectsRoots: [root] });
  assert.equal(findProjects("todo-app", projects).match?.name, "todo-app");
  assert.equal(findProjects("gate", projects).match?.name, "api-gateway");
  assert.equal(findProjects("zzz", projects).candidates.length, 0);
  assert.equal(findProjects("", projects).candidates.length, projects.length);
});

test("guessDevUrl reads ports and framework defaults", () => {
  assert.equal(guessDevUrl("next dev"), "http://localhost:3000");
  assert.equal(guessDevUrl("next dev --port=4000"), "http://localhost:4000");
  assert.equal(guessDevUrl("cross-env PORT=8088 node server.js"), "http://localhost:8088");
  assert.equal(guessDevUrl("astro dev"), "http://localhost:4321");
  assert.equal(guessDevUrl("node index.js"), undefined);
});
