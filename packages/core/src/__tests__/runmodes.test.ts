import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-runmodes-home-"));
const { readProject } = await import("../tools/projects.js");
const { devCommandFromFiles, justRecipes, makeTargets, taskfileTasks } = await import("../tools/runfiles.js");
const { resolveRun, runEnvFiles, runModes } = await import("../tools/runmodes.js");

function folder(files: Record<string, string | object>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-runmodes-"));
  for (const [f, content] of Object.entries(files)) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

test("task runners: Makefile, justfile and Taskfile targets, best one first", () => {
  assert.deepEqual(makeTargets("VAR := 1\n.PHONY: dev\nbuild:\n\tgo build\ndev: build\n\tgo run .\n%.o: %.c\n"), ["build", "dev"]);
  assert.deepEqual(justRecipes("set dotenv-load\n@serve port='8000':\n  python -m http.server {{port}}\nx := 'y'\n"), ["serve"]);
  assert.deepEqual(taskfileTasks("version: '3'\ntasks:\n  build:\n    cmds: [go build]\n  dev:\n    cmds:\n      - go run .\n"), ["build", "dev"]);
  assert.equal(devCommandFromFiles(folder({ Makefile: "build:\n\tx\nrun:\n\ty\ndev:\n\tz\n" })), "make dev");
  assert.equal(devCommandFromFiles(folder({ justfile: "start:\n  ./server\n" })), "just start");
  assert.equal(devCommandFromFiles(folder({ "Taskfile.yml": "tasks:\n  serve:\n    cmds: [x]\n" })), "task serve");
  assert.equal(devCommandFromFiles(folder({ "deno.json": { tasks: { dev: "deno run -A main.ts" } } })), "deno task dev");
});

test("frameworks' own commands: Rails, Laravel, Phoenix, Django, FastAPI, Flask, .NET", () => {
  assert.equal(devCommandFromFiles(folder({ Gemfile: "gem 'rails', '~> 7.1'\n" }), "linux"), "bin/rails server");
  assert.equal(devCommandFromFiles(folder({ Gemfile: "gem \"rails\"\n", "bin/dev": "#!/bin/sh\n" }), "darwin"), "bin/dev");
  assert.equal(devCommandFromFiles(folder({ Gemfile: "gem 'rails'\n" }), "win32"), "ruby bin/rails server");
  assert.equal(devCommandFromFiles(folder({ artisan: "<?php\n", "composer.json": "{}" })), "php artisan serve");
  assert.equal(devCommandFromFiles(folder({ "mix.exs": "{:phoenix, \"~> 1.7\"}\n" })), "mix phx.server");
  assert.equal(devCommandFromFiles(folder({ "manage.py": "", "requirements.txt": "django\n" })), "python manage.py runserver");
  assert.equal(devCommandFromFiles(folder({ "requirements.txt": "fastapi\nuvicorn\n", "app/main.py": "" })), "python -m uvicorn app.main:app --reload");
  assert.equal(devCommandFromFiles(folder({ "pyproject.toml": "[project]\ndependencies = [\"Flask>=3\"]\n", "app.py": "" })), "python -m flask --app app run --debug");
  assert.equal(devCommandFromFiles(folder({ "Shop.csproj": "<Project />" })), "dotnet watch run");
  assert.equal(devCommandFromFiles(folder({ "README.md": "hi" })), undefined);
});

test("a project with only a Makefile gets a dev command, so Run shows", () => {
  const dir = folder({ Makefile: "dev:\n\tdocker compose up\n" });
  fs.mkdirSync(path.join(dir, ".git"));
  assert.equal(readProject(dir)?.devCommand, "make dev");
  assert.equal(readProject(folder({ "package.json": { scripts: { dev: "vite" } }, Makefile: "dev:\n\tx\n" }))?.devCommand, "npm run dev", "package.json's script wins");
});

test("Next.js: a production build then next start, with .env.production, and per-environment scripts", () => {
  const dir = folder({
    "package.json": { scripts: { dev: "next dev", build: "next build", start: "next start", "start:staging": "next start -p 4000", "build:staging": "next build" } },
    ".env.production": "API_URL=https://api.example.com\n",
    ".env.staging": "API_URL=https://staging.example.com\nDEBUG=1\n",
    ".env.local": "SECRET=x\n",
    ".env.example": "API_URL=\n",
  });
  const project = readProject(dir)!;
  const modes = runModes(project);
  assert.deepEqual(modes.map((m) => m.id), ["dev", "production", "script:start:staging"]);
  const prod = modes[1];
  assert.equal(prod.build, "npm run build");
  assert.equal(prod.command, "npm run start");
  assert.equal(prod.envFile, ".env.production");
  assert.equal(modes[2].build, "npm run build:staging");
  assert.equal(modes[2].envFile, ".env.staging");
  assert.deepEqual(runEnvFiles(dir).map((e) => [e.file, e.count]), [[".env.production", 1], [".env.staging", 2]], "local overrides and examples aren't environments");

  const run = resolveRun(project, { mode: "production" });
  assert.equal(run.command, "npm run build && npm run start");
  assert.deepEqual(run.env, { API_URL: "https://api.example.com", NODE_ENV: "production" });
  assert.equal(resolveRun(project, { mode: "production", env: "" }).envFile, undefined, "an empty env means none");
  assert.deepEqual(resolveRun(project, { env: ".env.staging" }).env, { API_URL: "https://staging.example.com", DEBUG: "1" });
  assert.equal(resolveRun(project).command, "next dev".replace("next dev", "npm run dev"));
  assert.throws(() => resolveRun(project, { mode: "rm -rf /" }), /no run mode/);
  assert.throws(() => resolveRun(project, { env: ".env.example" }), /has no \.env\.example/);
  assert.throws(() => resolveRun(project, { env: "../.env.production" }), /has no/);
});

test("Vite: preview is its production server; CRA's start is the dev server, so no production mode", () => {
  const vite = readProject(folder({ "package.json": { scripts: { dev: "vite", build: "vite build", preview: "vite preview" } } }))!;
  assert.equal(runModes(vite).find((m) => m.id === "production")?.command, "npm run preview");
  const cra = readProject(folder({ "package.json": { scripts: { start: "react-scripts start", build: "react-scripts build" } } }))!;
  assert.equal(runModes(cra).find((m) => m.id === "production"), undefined);
});

test(".devrc.json modes: the project's own build, command, env file and variables", () => {
  const dir = folder({
    "package.json": { scripts: { dev: "vite" } },
    ".env.qa": "X=1\n",
    ".devrc.json": { modes: { qa: { label: "QA build", build: "npm run build -- --mode qa", run: "npx serve dist", env: ".env.qa", vars: { APP_ENV: "qa", "bad key": "x", N: 1 } }, "no run": { build: "x" } } },
  });
  const modes = runModes(readProject(dir)!);
  const qa = modes.find((m) => m.id === "devrc:qa")!;
  assert.equal(qa.label, "QA build");
  assert.equal(qa.envFile, ".env.qa");
  assert.deepEqual(qa.vars, { APP_ENV: "qa" }, "only plain names with text values");
  assert.equal(modes.length, 2, "a mode without a command, or with an odd name, is left out");
  assert.deepEqual(resolveRun(readProject(dir)!, { mode: "devrc:qa" }).env, { X: "1", APP_ENV: "qa" });
});
