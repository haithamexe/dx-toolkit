// Installs the packed release the way a user would (npm install -g, into a temporary prefix) and
// checks it works: the dx command, the dashboard in the background, and the MCP server. Run after
// `npm run release`; CI runs it on every system. With --from-npm it installs this version from the
// npm registry instead, to check a release once it's published.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
const fromNpm = process.argv.includes("--from-npm");
let version, spec;
if (fromNpm) {
  version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  spec = `dx-devkit@${version}`;
} else {
  const tarball = fs.existsSync(release) && fs.readdirSync(release).find((f) => /^dx-devkit-.*\.tgz$/.test(f));
  if (!tarball) fail("No release/dx-devkit-*.tgz. Run npm run release first.");
  version = JSON.parse(fs.readFileSync(path.join(release, "package.json"), "utf8")).version;
  spec = path.join(release, tarball);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dx-devkit-smoke-"));
const prefix = path.join(tmp, "prefix");
const home = path.join(tmp, "dx-home");
const projects = path.join(tmp, "projects");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(projects, "hello"), { recursive: true });
fs.writeFileSync(path.join(projects, "hello", "package.json"), JSON.stringify({ name: "hello", scripts: { dev: "node -e \"require('http').createServer((q,r)=>r.end('hi')).listen(0,()=>{})\"" } }));
// autoConnectAi: false so the smoke test never touches this computer's AI tools.
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [projects], autoConnectAi: false, localDomainsPort: 0 }));

step(`npm install -g ${fromNpm ? spec : path.basename(spec)}`);
execSync(`npm install -g "${spec}" --prefix "${prefix}" --no-audit --no-fund`, { stdio: "inherit" });

const isWin = process.platform === "win32";
const bin = (name) => path.join(prefix, isWin ? `${name}.cmd` : path.join("bin", name));
const env = { ...process.env, DX_HOME: home };
// .cmd shims need the shell on Windows; the arguments here are fixed words, never input.
const dx = (...args) => (isWin ? execSync(`"${bin("dx")}" ${args.join(" ")}`, { env, encoding: "utf8" }) : execFileSync(bin("dx"), args, { env, encoding: "utf8" }));

step("dx --version");
const shown = dx("--version").trim();
if (shown !== version) fail(`dx --version printed ${shown}, expected ${version}`);
console.log(shown);

step("dx projects");
const list = dx("projects");
if (!list.includes("hello")) fail(`dx projects didn't list the test project:\n${list}`);

step("dx ui --background, then --stop");
console.log(dx("ui", "--background", "--no-open"));
const info = JSON.parse(fs.readFileSync(path.join(home, "dashboard.json"), "utf8"));
const page = await fetch(info.url).then((r) => r.text());
if (!page.includes("dx-token")) fail("The dashboard didn't serve its page.");
console.log(dx("ui", "--stop"));

step("the MCP server, as an AI tool starts it");
const installed = isWin ? path.join(prefix, "node_modules", "dx-devkit") : path.join(prefix, "lib", "node_modules", "dx-devkit");
const { mcpServerScript } = await import(pathUrl(path.join(installed, "node_modules", "@dx", "core", "dist", "index.js")));
const script = mcpServerScript();
if (!fs.existsSync(script)) fail(`The path dx setup writes into AI tools doesn't exist: ${script}`);
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], env }));
const { tools } = await client.listTools();
await client.close();
for (const t of ["start_dev_server", "check_url", "set_stack", "work_summary"]) if (!tools.some((x) => x.name === t)) fail(`The MCP server has no ${t} tool.`);
console.log(`${tools.length} tools`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n✓ dx-devkit ${version} installs and runs`);

function step(name) {
  console.log(`\n── ${name}`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function pathUrl(p) {
  return new URL(`file://${isWinPath(p) ? "/" : ""}${p.replace(/\\/g, "/")}`).href;
}

function isWinPath(p) {
  return /^[A-Za-z]:/.test(p);
}
