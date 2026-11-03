// Builds the one package published to npm as "dxkit", in ./release, and packs it.
//
// The repository is four workspace packages (core, web, cli, mcp) that aren't published on their
// own. The release is the CLI, with the other three bundled inside it (bundleDependencies), so
// `npm install -g dxkit` gives the `dx` command, the dashboard and the MCP server in one install.
// Run `npm run build` first; `npm run release` does both.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "dxkit";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "release");
const rootPkg = readJson(path.join(root, "package.json"));
const version = rootPkg.version;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);

// The CLI is the package itself.
copy(path.join(root, "packages", "cli", "dist"), path.join(out, "dist"));
for (const f of ["README.md", "LICENSE", "CHANGELOG.md"]) fs.copyFileSync(path.join(root, f), path.join(out, f));

// core, web and mcp are bundled, without their workspace dependency lists (npm would look them up).
const external = {};
for (const name of ["core", "web", "mcp"]) {
  const src = path.join(root, "packages", name);
  const pkg = readJson(path.join(src, "package.json"));
  const dest = path.join(out, "node_modules", "@dx", name);
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) if (!dep.startsWith("@dx/")) external[dep] = range;
  delete pkg.dependencies;
  delete pkg.devDependencies;
  delete pkg.scripts;
  delete pkg.bin;
  pkg.version = version;
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  copy(path.join(src, "dist"), path.join(dest, "dist"), (f) => !f.includes(`${path.sep}__tests__`) && !f.endsWith(".tsbuildinfo"));
  if (fs.existsSync(path.join(src, "public"))) copy(path.join(src, "public"), path.join(dest, "public"));
}

// A small entry for running the MCP server by hand: `dx-mcp`.
fs.mkdirSync(path.join(out, "bin"));
fs.writeFileSync(path.join(out, "bin", "dx-mcp.js"), '#!/usr/bin/env node\nimport "@dx/mcp/dist/index.js";\n');

const cliPkg = readJson(path.join(root, "packages", "cli", "package.json"));
const pkg = {
  name: NAME,
  version,
  description: "Your projects, dev servers, ports, journal and weekly summary in one place: a local dashboard, a dx command, and tools your AI coding agent can use to run your app and see its errors. No setup.",
  license: "MIT",
  type: "module",
  bin: { dx: "dist/index.js", "dx-mcp": "bin/dx-mcp.js" },
  engines: rootPkg.engines,
  files: ["dist", "bin", "node_modules/@dx", "README.md", "LICENSE", "CHANGELOG.md"],
  dependencies: {
    "@dx/core": version,
    "@dx/web": version,
    "@dx/mcp": version,
    ...external,
    ...Object.fromEntries(Object.entries(cliPkg.dependencies ?? {}).filter(([d]) => !d.startsWith("@dx/"))),
  },
  bundleDependencies: ["@dx/core", "@dx/web", "@dx/mcp"],
  keywords: ["developer-tools", "cli", "dashboard", "mcp", "mcp-server", "dev-server", "localhost", "monorepo", "ai-agent", "productivity"],
  ...repository(),
};
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

const tarball = execSync("npm pack --silent", { cwd: out, encoding: "utf8" }).trim().split(/\r?\n/).pop();
console.log(`Built ${NAME}@${version} in release/ → release/${tarball}`);
console.log("Publish with: npm publish ./release");

/** The GitHub repository this checkout pushes to, for the npm page's links. Read at build time, never stored in the repo. */
function repository() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim();
    const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(url);
    if (!m) return {};
    const web = `https://github.com/${m[1]}/${m[2]}`;
    return { repository: { type: "git", url: `git+${web}.git` }, homepage: `${web}#readme`, bugs: { url: `${web}/issues` } };
  } catch {
    return {};
  }
}

function copy(from, to, keep = () => true) {
  fs.cpSync(from, to, { recursive: true, filter: (f) => keep(f) });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
