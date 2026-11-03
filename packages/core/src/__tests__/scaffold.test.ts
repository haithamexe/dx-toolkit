import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../config.js";
import { copyProject, isValidProjectName, listTemplates, resolveSource, saveAsTemplate } from "../tools/scaffold.js";

function tree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

test("copying a project leaves out git, installs, build output and secrets, and renames it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-new-"));
  const src = path.join(root, "todo-app");
  tree(src, {
    "package.json": JSON.stringify({ name: "todo-app", scripts: { dev: "vite" } }, null, 2) + "\n",
    "src/main.ts": "console.log('{{name}} stays as written in a project copy')",
    ".env": "SECRET=1",
    ".env.local": "SECRET=2",
    ".env.example": "SECRET=",
    ".git/HEAD": "ref",
    "node_modules/x/index.js": "x",
    "dist/app.js": "built",
    "debug.log": "noise",
  });
  const config = { ...defaultConfig(), projectsRoots: [root], templatesDir: path.join(root, "_templates") };
  const source = resolveSource("todo-app", config);
  assert.ok("kind" in source && source.kind === "project");

  const dest = path.join(root, "my-app");
  const result = copyProject(source, dest, "my-app");
  const files = fs.readdirSync(dest, { recursive: true }).map((f) => String(f).split(path.sep).join("/")).sort();
  assert.deepEqual(files, [".env.example", "package.json", "src", "src/main.ts"]);
  assert.equal(result.files, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8")).name, "my-app");
  assert.match(fs.readFileSync(path.join(dest, "src/main.ts"), "utf8"), /\{\{name\}\}/);

  assert.throws(() => copyProject(source, dest, "my-app"), /already exists/);
  assert.throws(() => copyProject(source, path.join(src, "inner"), "inner"), /inside/);
});

test("templates fill in {{name}} in text files and file names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-tpl-"));
  const templates = path.join(root, "_templates");
  tree(path.join(templates, "vite-app"), {
    "package.json": JSON.stringify({ name: "{{name}}" }, null, "\t"),
    "README.md": "# {{name}}\n\nWelcome to {{name}}.",
    "src/{{name}}.config.ts": "export default {}",
    "logo.png": "\x89PNG\x00\x00{{name}}",
  });
  const config = { ...defaultConfig(), projectsRoots: [root], templatesDir: templates };
  assert.deepEqual(listTemplates(config).map((t) => t.name), ["vite-app"]);

  const source = resolveSource("vite-app", config);
  assert.ok("kind" in source && source.kind === "template");
  const dest = path.join(root, "shop");
  const result = copyProject(source, dest, "shop");
  assert.equal(fs.readFileSync(path.join(dest, "README.md"), "utf8"), "# shop\n\nWelcome to shop.");
  assert.ok(fs.existsSync(path.join(dest, "src/shop.config.ts")));
  assert.match(fs.readFileSync(path.join(dest, "logo.png"), "latin1"), /\{\{name\}\}/, "binary files are copied as-is");
  const pkgText = fs.readFileSync(path.join(dest, "package.json"), "utf8");
  assert.equal(JSON.parse(pkgText).name, "shop");
  assert.match(pkgText, /^\t"name"/m, "tab indentation kept");
  assert.equal(result.filled, 2);
});

test("saveAsTemplate copies a project into the templates folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-save-"));
  tree(path.join(root, "todo-app"), { "package.json": '{"name":"todo-app"}', "node_modules/x.js": "x" });
  const config = { ...defaultConfig(), projectsRoots: [root], templatesDir: path.join(root, "_templates") };
  const source = resolveSource("todo-app", config);
  assert.ok("kind" in source);
  saveAsTemplate(source, "notes-starter", config);
  assert.deepEqual(listTemplates(config).map((t) => t.name), ["notes-starter"]);
  assert.ok(!fs.existsSync(path.join(root, "_templates/notes-starter/node_modules")));
  assert.throws(() => saveAsTemplate(source, "Bad Name", config), /valid template name/);
});

test("project names", () => {
  assert.equal(isValidProjectName("my-app"), true);
  assert.equal(isValidProjectName("app.v2_x"), true);
  assert.equal(isValidProjectName("My App"), false);
  assert.equal(isValidProjectName("-x"), false);
  assert.equal(isValidProjectName("../x"), false);
});

test("copying a git project takes what git tracks plus new files it doesn't ignore", (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    return t.skip("git not installed");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-new-git-"));
  const src = path.join(root, "app");
  tree(src, {
    "package.json": '{"name":"app"}',
    ".gitignore": "reports/\nuploads/\n*.local\n",
    "src/index.ts": "export {}",
    "src/new-file.ts": "export {}", // not committed yet, not ignored: copied
    "reports/run.html": "<html>", // ignored: left behind
    "uploads/photo.jpg": "jpg",
    "settings.local": "mine",
  });
  execFileSync("git", ["init", "-q"], { cwd: src });
  execFileSync("git", ["add", "package.json", ".gitignore", "src/index.ts"], { cwd: src });
  const config = { ...defaultConfig(), projectsRoots: [root] };
  const source = resolveSource("app", config);
  assert.ok("kind" in source);
  copyProject(source, path.join(root, "copy"), "copy");
  const files = fs.readdirSync(path.join(root, "copy"), { recursive: true }).map((f) => String(f).split(path.sep).join("/")).sort();
  assert.deepEqual(files, [".gitignore", "package.json", "src", "src/index.ts", "src/new-file.ts"]);
});
