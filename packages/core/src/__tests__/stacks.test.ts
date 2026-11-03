import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readProject } from "../tools/projects.js";
import { detectStack, mainService, readCompose, roleOf, saveStackSpec, splitRunnerLine, startOrder, type Stack } from "../tools/stacks.js";

function project(files: Record<string, string | object>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-stack-"));
  for (const [f, content] of Object.entries(files)) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  }
  return readProject(dir)!;
}

const names = (stack: Stack | undefined) => stack?.services.map((s) => s.name);
const waves = (stack: Stack) => startOrder(stack).map((w) => w.map((s) => s.name).sort());

test("a plain project has no stack", () => {
  assert.equal(detectStack(project({ "package.json": { scripts: { dev: "vite" } } })), undefined);
});

test("Procfile.dev: one service per line, ports handed out like foreman", () => {
  const stack = detectStack(project({ "Procfile.dev": "web: bin/rails server -p $PORT\ncss: bin/rails tailwindcss:watch\n# a comment\nworker: bundle exec sidekiq\n" }))!;
  assert.equal(stack.source, "procfile");
  assert.deepEqual(names(stack), ["web", "css", "worker"]);
  assert.equal(stack.services[0].env?.PORT, "5000");
  assert.equal(stack.services[0].url, "http://localhost:5000");
  assert.deepEqual(waves(stack), [["worker"], ["css"], ["web"]], "back end, then the rest, then the front end");
});

test("workspaces with dev scripts: each runs in its own folder, front end last", () => {
  const stack = detectStack(
    project({
      "package.json": { workspaces: ["apps/*", "packages/ui"], scripts: { build: "x" } },
      "apps/web/package.json": { name: "@shop/web", scripts: { dev: "next dev -p 3001" } },
      "apps/api/package.json": { name: "@shop/api", scripts: { dev: "tsx watch src/server.ts" } },
      "packages/ui/package.json": { name: "@shop/ui", scripts: { build: "tsc" } },
    }),
  )!;
  assert.equal(stack.source, "workspaces");
  assert.deepEqual(names(stack)?.sort(), ["api", "web"]);
  const web = stack.services.find((s) => s.name === "web")!;
  assert.equal(web.url, "http://localhost:3001");
  assert.ok(web.dir.endsWith(path.join("apps", "web")));
  assert.equal(web.command, "npm run dev");
  assert.deepEqual(waves(stack), [["api"], ["web"]]);
  assert.equal(mainService(stack)?.name, "web");
});

test("pnpm-workspace.yaml is read too", () => {
  const stack = detectStack(
    project({
      "package.json": { name: "root" },
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  # - 'old/*'\n",
      "apps/site/package.json": { scripts: { dev: "astro dev" } },
      "apps/server/package.json": { scripts: { dev: "node --watch index.js" } },
    }),
  )!;
  assert.deepEqual(names(stack)?.sort(), ["server", "site"]);
  assert.equal(stack.services[0].command, "pnpm run dev");
});

test("a root dev script that runs turbo stays one command, and its output is split by service", () => {
  const stack = detectStack(
    project({
      "package.json": { workspaces: ["apps/*"], scripts: { dev: "turbo run dev --parallel" } },
      "apps/web/package.json": { name: "@acme/web", scripts: { dev: "vite" } },
      "apps/api/package.json": { name: "@acme/api", scripts: { dev: "nodemon src/index.js" } },
    }),
  )!;
  assert.equal(stack.source, "runner");
  assert.equal(stack.runner?.command, "npm run dev");
  assert.deepEqual(splitRunnerLine("@acme/web:dev:   VITE v6 ready in 300 ms", stack.services), { service: "web", text: "  VITE v6 ready in 300 ms" });
  assert.deepEqual(splitRunnerLine("api:dev: listening on 4000", stack.services), { service: "api", text: "listening on 4000" });
  assert.deepEqual(splitRunnerLine("• Packages in scope: @acme/api, @acme/web", stack.services), { text: "• Packages in scope: @acme/api, @acme/web" });
});

test("root dev:* scripts: run separately, or split when concurrently runs them", () => {
  const separate = detectStack(project({ "package.json": { scripts: { "dev:web": "vite", "dev:api": "tsx watch api.ts" } } }))!;
  assert.equal(separate.source, "scripts");
  assert.deepEqual(
    separate.services.map((s) => s.command).sort(),
    ["npm run dev:api", "npm run dev:web"],
  );
  const together = detectStack(project({ "package.json": { scripts: { dev: 'concurrently "npm:dev:*"', "dev:web": "vite", "dev:api": "tsx watch api.ts" } } }))!;
  assert.equal(together.source, "runner");
  assert.deepEqual(splitRunnerLine("[dev:api] listening", together.services), { service: "api", text: "listening" });
  assert.deepEqual(splitRunnerLine("[web] ready", together.services), { service: "web", text: "ready" });
});

test("docker-compose: databases start first; app services built from source are left to run natively", () => {
  const compose = [
    "services:",
    "  db:",
    "    image: postgres:16",
    "    ports:",
    '      - "5433:5432"',
    "  cache:",
    "    image: redis:7-alpine",
    "    ports: ['6379:6379']",
    "  api:",
    "    build: ./api",
    "    ports:",
    "      - 4000:4000",
    "volumes:",
    "  data: {}",
  ].join("\n");
  const c = readCompose(project({ "docker-compose.yml": compose }).dir)!;
  assert.deepEqual(
    c.services.map((s) => [s.name, s.image ?? null, !!s.build, s.hostPort ?? null]),
    [
      ["db", "postgres:16", false, 5433],
      ["cache", "redis:7-alpine", false, 6379],
      ["api", null, true, 4000],
    ],
  );

  const stack = detectStack(project({ "docker-compose.yml": compose, "package.json": { scripts: { dev: "next dev" } } }))!;
  assert.equal(stack.source, "compose");
  assert.deepEqual(names(stack), ["db", "cache", "app"]);
  assert.equal(stack.services[0].command, "docker compose up -d db");
  assert.equal(stack.services[0].url, "http://localhost:5433");
  assert.deepEqual(waves(stack), [["cache", "db"], ["app"]]);
});

test(".devrc.json stack: explicit services, other projects by folder, docker services, and its own order", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dx-stack-pair-"));
  fs.mkdirSync(path.join(parent, "shop-api"));
  fs.writeFileSync(path.join(parent, "shop-api", "package.json"), JSON.stringify({ scripts: { dev: "next dev -p 4000" } }));
  fs.mkdirSync(path.join(parent, "shop-web"));
  fs.writeFileSync(path.join(parent, "shop-web", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  fs.writeFileSync(path.join(parent, "shop-web", "compose.yaml"), "services:\n  db:\n    image: mysql:8\n    ports:\n      - 3306:3306\n");
  saveStackSpec(path.join(parent, "shop-web"), {
    web: { dev: "npm run dev", dependsOn: ["api"] },
    api: { project: "../shop-api", dependsOn: ["db"] },
    db: { docker: "db" },
  });
  const devrc = JSON.parse(fs.readFileSync(path.join(parent, "shop-web", ".devrc.json"), "utf8"));
  assert.ok(devrc.stack.web);

  const stack = detectStack(readProject(path.join(parent, "shop-web"))!)!;
  assert.equal(stack.source, "devrc");
  const api = stack.services.find((s) => s.name === "api")!;
  assert.equal(api.dir, path.join(parent, "shop-api"));
  assert.equal(api.command, "npm run dev");
  assert.equal(api.url, "http://localhost:4000");
  assert.equal(stack.services.find((s) => s.name === "db")?.hostPort, 3306);
  assert.deepEqual(waves(stack), [["db"], ["api"], ["web"]]);

  saveStackSpec(path.join(parent, "shop-web"), undefined);
  assert.equal(detectStack(readProject(path.join(parent, "shop-web"))!)?.source, "compose", "removing the stack falls back to what dx finds");
});

test("roles from names and commands", () => {
  assert.equal(roleOf("api"), "backend");
  assert.equal(roleOf("auth-server"), "backend");
  assert.equal(roleOf("worker"), "backend");
  assert.equal(roleOf("web"), "frontend");
  assert.equal(roleOf("admin-ui"), "frontend");
  assert.equal(roleOf("shop", "vite --port 5174"), "frontend");
  assert.equal(roleOf("thing", "uvicorn main:app --reload"), "backend");
  assert.equal(roleOf("css", "tailwindcss --watch"), "other");
});
