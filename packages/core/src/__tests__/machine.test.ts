import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-machine-test-"));
const core = await import("../index.js");
const {
  satisfies,
  parseVersion,
  compareVersions,
  checkTools,
  installerOf,
  updateCommand,
  readNeeds,
  checkProjectNeeds,
  needLabel,
  nodeTarget,
  classifyProcess,
  groupProcesses,
  parseElapsed,
  parseSize,
  parseWindowsSnapshot,
  parseWindowsServices,
  dockerInfo,
  dockerPrune,
  dockerStop,
  findInstalledTools,
  latestVersions,
} = core;

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-needs-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const NOW = Date.parse("2026-11-04T12:00:00Z");
const LATEST = {
  at: NOW,
  cycles: {
    nodejs: [
      { cycle: "26", releaseDate: "2026-05-05", lts: "2026-10-28", eol: "2029-04-30", latest: "26.13.0" },
      { cycle: "25", releaseDate: "2025-10-15", lts: false, eol: "2026-06-01", latest: "25.9.0" },
      { cycle: "24", releaseDate: "2025-05-06", lts: "2025-10-28", eol: "2028-04-30", latest: "24.22.2" },
      { cycle: "22", releaseDate: "2024-04-24", lts: "2024-10-29", eol: "2027-01-30", latest: "22.30.0" },
      { cycle: "18", releaseDate: "2022-04-19", lts: "2022-10-25", eol: "2025-04-30", latest: "18.20.8" },
    ],
    python: [
      { cycle: "3.14", releaseDate: "2025-10-07", eol: "2030-10-31", latest: "3.14.10" },
      { cycle: "3.13", releaseDate: "2024-10-07", eol: "2029-10-31", latest: "3.13.18" },
      { cycle: "3.8", releaseDate: "2019-10-14", eol: "2024-10-07", latest: "3.8.20" },
    ],
    go: [{ cycle: "1.27", releaseDate: "2026-08-19", eol: false, latest: "1.27.3" }],
  },
  npm: { npm: "12.2.1", pnpm: "10.20.0", yarn: "1.22.22", "@yarnpkg/cli-dist": "4.10.0", bun: "1.3.1" },
  github: { "cli/cli": "2.103.3", "git-for-windows/git": "2.56.0.windows.4" },
};

test("versions: reads the versions tools print, and compares them", () => {
  assert.equal(parseVersion("v24.20.0"), "24.20.0");
  assert.equal(parseVersion("Python 3.13.5"), "3.13.5");
  assert.equal(parseVersion("go version go1.22.1 windows/amd64"), "1.22.1");
  assert.equal(parseVersion('openjdk version "21" 2023-09-19'), "21.0.0");
  assert.equal(parseVersion('java version "1.8.0_381"'), "8.0.381");
  assert.equal(parseVersion("'pnpm' is not recognized as an internal or external command"), undefined);
  assert.ok(compareVersions("2.49.0", "2.56.0") < 0);
  assert.ok(compareVersions("10.0.0", "9.9.9") > 0);
});

test("versions: the ranges projects write", () => {
  const yes = (v: string, r: string) => assert.equal(satisfies(v, r), true, `${v} meets ${r}`);
  const no = (v: string, r: string) => assert.equal(satisfies(v, r), false, `${v} doesn't meet ${r}`);
  yes("20.11.1", ">=18");
  no("16.20.0", ">=18");
  yes("20.1.0", "^20");
  no("21.0.0", "^20.1.0");
  yes("18.19.0", "^18 || ^20");
  no("22.1.0", "^18 || ^20");
  yes("20.5.0", ">=18 <21");
  no("21.0.0", ">=18 <21");
  yes("20.5.0", ">= 18.0.0");
  yes("20.9.1", "20.x");
  no("21.0.0", "20.x");
  yes("20.9.1", "20");
  yes("1.2.9", "~1.2.3");
  no("1.3.0", "~1.2.3");
  yes("0.2.5", "^0.2.3");
  no("0.3.0", "^0.2.3");
  yes("19.0.0", "18 - 20");
  no("21.0.0", "18 - 20");
  yes("24.1.0", "lts/*");
  no("25.1.0", "lts/*");
  yes("20.11.0", "lts/iron");
  no("22.1.0", "lts/iron");
  yes("1.27.0", "*");
  assert.equal(satisfies("20.0.0", "lts/unknown-name"), undefined, "a name it doesn't know isn't a mismatch");
});

test("tools: what needs an update, and what's no longer supported", async () => {
  const tools = await checkTools({
    now: NOW,
    platform: "win32",
    latest: LATEST,
    installed: [
      { id: "node", version: "18.20.4", path: "C:\\Program Files\\nodejs\\node.exe", via: "winget" },
      { id: "npm", version: "12.2.1", via: "system" },
      { id: "pnpm", version: "9.4.0", via: "npm-global" },
      { id: "git", version: "2.49.0.windows.1", via: "winget" },
      { id: "python", version: "3.13.5", via: "winget" },
      { id: "go" },
    ],
  });
  const by = (id: string) => tools.find((t) => t.id === id)!;
  assert.equal(by("node").status, "unsupported");
  assert.match(by("node").detail, /Node 18 stopped getting security fixes on 30 Apr 2025\. Move to 26/);
  assert.equal(by("node").fix, "winget install --id OpenJS.NodeJS.LTS");
  assert.equal(by("npm").status, "ok");
  assert.equal(by("pnpm").status, "update");
  assert.match(by("pnpm").detail, /10\.20\.0 is out \(a new major version/);
  assert.equal(by("pnpm").fix, "npm install -g pnpm@latest");
  assert.equal(by("git").status, "update");
  assert.equal(by("git").fix, "git update-git-for-windows");
  assert.equal(by("python").status, "update");
  assert.equal(by("python").fix, "winget upgrade --id Python.Python.3.13");
  assert.equal(by("go").status, "missing");

  const ending = await checkTools({ now: Date.parse("2026-11-04"), platform: "linux", latest: LATEST, installed: [{ id: "node", version: "22.30.0", via: "fnm" }] });
  assert.equal(ending[0].status, "ending", "support ends within 4 months");
  assert.match(ending[0].detail, /stops getting security fixes on 30 Jan 2027/);
  assert.equal(ending[0].fix, "fnm install 26 && fnm default 26");

  const current = await checkTools({ now: NOW, latest: LATEST, installed: [{ id: "node", version: "24.22.2", via: "nvm" }] });
  assert.equal(current[0].status, "ok");
  assert.match(current[0].detail, /26 is the newest LTS/);

  const offline = await checkTools({ now: NOW, offline: true, installed: [{ id: "node", version: "24.1.0" }] });
  assert.equal(offline[0].status, "unknown");
  assert.match(offline[0].detail, /couldn't check/);
});

test("tools: finds what's installed with the commands it runs, and where it came from", async () => {
  const runs: string[] = [];
  const installed = await findInstalledTools(
    async (command, args) => {
      runs.push([command, ...args].join(" "));
      if (command === "node") return "v24.20.0\n";
      if (command === "python") return "Python was not found; run without arguments to install from the Microsoft Store";
      if (command === "py") return "Python 3.13.5";
      return `'${command}' is not recognized as an internal or external command`;
    },
    async (command) => (command === "node" ? "C:\\Program Files\\nodejs\\node.exe\r\n" : command === "py" ? "C:\\Windows\\py.exe\r\n" : ""),
  );
  assert.equal(installed.find((t) => t.id === "node")?.version, "24.20.0");
  assert.equal(installed.find((t) => t.id === "pnpm")?.version, undefined);
  if (process.platform === "win32") assert.equal(installed.find((t) => t.id === "python")?.version, "3.13.5", "the Store's stub is skipped for the py launcher");
  assert.ok(runs.includes("node --version"));
  assert.ok(runs.every((r) => /^[\w]+ (--version|version|-version)$/.test(r)), "only fixed version commands");

  assert.equal(installerOf("node", "/home/octocat/.nvm/versions/node/v20.0.0/bin/node", {}, "linux"), "nvm");
  assert.equal(installerOf("node", "C:\\Users\\octocat\\AppData\\Roaming\\fnm\\node-versions\\v20\\node.exe", {}, "win32"), "fnm");
  assert.equal(installerOf("node", "C:\\Program Files\\nodejs\\node.exe", { NVM_HOME: "C:\\nvm" }, "win32"), "nvm-windows");
  assert.equal(installerOf("pnpm", "C:\\Users\\octocat\\AppData\\Roaming\\npm\\pnpm.cmd", {}, "win32"), "npm-global");
  assert.equal(installerOf("pnpm", "C:\\Program Files\\nodejs\\pnpm.cmd", {}, "win32"), "corepack");
  assert.equal(installerOf("node", "/opt/homebrew/bin/node", {}, "darwin"), "brew");
  assert.equal(installerOf("python", "C:\\Python313\\python.exe", {}, "win32"), "winget");
  assert.deepEqual(updateCommand("node", "nvm", "linux"), updateCommand("node", "nvm", "darwin"));
  assert.deepEqual(updateCommand("node", "unknown", "linux"), { fix: "Download it from https://nodejs.org/en/download", runnable: false });
});

test("tools: latest versions are cached, and a source that doesn't answer is left out", async () => {
  let calls = 0;
  const fetcher = (async (url: string) => {
    calls++;
    if (String(url).includes("endoflife.date/api/nodejs")) return new Response(JSON.stringify(LATEST.cycles.nodejs));
    if (String(url).includes("registry.npmjs.org/pnpm")) return new Response(JSON.stringify({ version: "10.20.0" }));
    throw new Error("offline");
  }) as typeof fetch;
  const first = await latestVersions({ refresh: true, fetcher });
  assert.equal(first.npm.pnpm, "10.20.0");
  assert.equal(first.cycles.nodejs?.length, 5);
  assert.equal(first.github["cli/cli"], undefined);
  const before = calls;
  const second = await latestVersions({ fetcher });
  assert.equal(calls, before, "read from the cache");
  assert.equal(second.npm.pnpm, "10.20.0");
});

test("projects: reads what each project needs from its own files", () => {
  const dir = project({
    ".nvmrc": "v20.11.0\n",
    "package.json": JSON.stringify({ engines: { node: ">=18" }, packageManager: "pnpm@9.1.0+sha512.abc" }),
    "pnpm-lock.yaml": "",
    "compose.yaml": "services: {}",
    "go.mod": "module example.com/shop\n\ngo 1.22.1\n",
  });
  const needs = readNeeds(dir);
  assert.deepEqual(needs.find((n) => n.tool === "node"), { tool: "node", wants: "20.11.0", source: ".nvmrc" }, ".nvmrc wins over engines");
  assert.deepEqual(needs.find((n) => n.tool === "pnpm"), { tool: "pnpm", wants: "^9", source: "package.json packageManager" });
  assert.deepEqual(needs.find((n) => n.tool === "go"), { tool: "go", wants: ">=1.22.1", source: "go.mod" });
  assert.ok(needs.some((n) => n.tool === "docker" && n.source === "compose.yaml"));

  const py = readNeeds(project({ "pyproject.toml": '[project]\nrequires-python = ">=3.10"\n', ".tool-versions": "nodejs 22.4.0\n" }));
  assert.deepEqual(py.find((n) => n.tool === "python"), { tool: "python", wants: ">=3.10", source: "pyproject.toml" });
  assert.deepEqual(py.find((n) => n.tool === "node"), { tool: "node", wants: "22.4.0", source: ".tool-versions" });

  assert.equal(needLabel({ tool: "node", wants: "lts/iron", source: ".nvmrc" }), "Node 20");
  assert.equal(needLabel({ tool: "go", wants: ">=1.22", source: "go.mod" }), "Go 1.22 or newer");
  assert.equal(needLabel({ tool: "pnpm", wants: "^9", source: "x" }), "pnpm 9");
  assert.equal(nodeTarget(">=18 <21"), "20");
  assert.equal(nodeTarget("^18 || ^20", ["26", "24", "22", "20", "18"]), "20");
  assert.equal(nodeTarget("lts/jod"), "22");
});

test("projects: what doesn't match this computer, with the command that fixes it", () => {
  const shop = project({ ".nvmrc": "20\n", "package.json": "{}", "yarn.lock": "" });
  const api = project({ "package.json": JSON.stringify({ engines: { node: ">=18" } }) });
  const projects = [
    { name: "shop-website", dir: shop, root: os.tmpdir(), kind: "node" as const, scripts: [], hasGit: false, lastActive: 0 },
    { name: "api-gateway", dir: api, root: os.tmpdir(), kind: "node" as const, scripts: [], hasGit: false, lastActive: 0 },
  ];
  const result = checkProjectNeeds(projects, [{ id: "node", version: "24.1.0", via: "fnm" }], { platform: "linux" });
  assert.equal(result[0].project, "shop-website", "problems first");
  const node = result[0].needs.find((n) => n.tool === "node")!;
  assert.equal(node.ok, false);
  assert.equal(node.problem, "version");
  assert.equal(node.label, "Node 20");
  assert.equal(node.fix, "fnm use --install-if-missing", "fnm reads .nvmrc itself");
  const yarn = result[0].needs.find((n) => n.tool === "yarn")!;
  assert.equal(yarn.problem, "missing");
  assert.equal(yarn.fix, "corepack enable");
  assert.equal(result[1].problems, 0);

  // No version manager: the advice says how to get one, and isn't run as a command.
  const plain = checkProjectNeeds(projects.slice(0, 1), [{ id: "node", version: "24.1.0", via: "winget" }, { id: "yarn", version: "1.22.22" }], { platform: "win32" });
  const advice = plain[0].needs.find((n) => n.tool === "node")!;
  assert.equal(advice.runnable, false);
  assert.match(advice.fix ?? "", /winget install --id Schniz\.fnm/);
});

test("processes: what each one is", () => {
  assert.equal(classifyProcess("node.exe", '"node" "C:\\work\\shop\\node_modules\\vite\\bin\\vite.js" --port 5173').label, "Vite");
  assert.equal(classifyProcess("node", "node /work/shop/node_modules/.bin/../next/dist/bin/next dev").label, "Next.js");
  assert.equal(classifyProcess("node", "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js").kind, "tool");
  assert.equal(classifyProcess("node", "node /usr/lib/node_modules/npm/bin/npx-cli.js -y @modelcontextprotocol/server-filesystem").kind, "tool");
  assert.equal(classifyProcess("node", "node /path/to/dx-toolkit/packages/web/dist/background.js").kind, "dx");
  assert.equal(classifyProcess("python3", "python3 manage.py runserver").label, "Django");
  assert.equal(classifyProcess("node", "node server.js").label, "node server.js");
  assert.equal(classifyProcess("node.exe", '"C:\\Program Files\\nodejs\\node.exe" "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev').label, "npm run dev");
});

test("processes: a dev server's tree is one entry, and one left behind by a closed terminal says so", () => {
  const t = NOW - 3600_000;
  const snapshot = {
    all: [
      { pid: 10, ppid: 1, name: "WindowsTerminal.exe", startedAt: t - 1000 },
      { pid: 11, ppid: 10, name: "pwsh.exe", startedAt: t - 900 },
      { pid: 100, ppid: 11, name: "node.exe", startedAt: t },
      { pid: 101, ppid: 100, name: "cmd.exe", startedAt: t + 10 },
      { pid: 102, ppid: 101, name: "node.exe", startedAt: t + 20 },
      { pid: 103, ppid: 102, name: "esbuild.exe", startedAt: t + 30 },
      // 200's terminal is gone: its parent id now belongs to a newer process.
      { pid: 50, ppid: 1, name: "notepad.exe", startedAt: t + 5000 },
      { pid: 200, ppid: 50, name: "node.exe", startedAt: t + 100 },
      { pid: 300, ppid: 400, name: "node.exe", startedAt: t + 200 },
      { pid: 400, ppid: 1, name: "node.exe", startedAt: t + 150 },
    ],
    dev: [
      { pid: 100, ppid: 11, name: "node.exe", command: "node C:\\nodejs\\npm-cli.js run dev", startedAt: t, memory: 50e6, cpu: 0 },
      { pid: 102, ppid: 101, name: "node.exe", command: "node C:\\work\\shop-website\\node_modules\\vite\\bin\\vite.js", startedAt: t + 20, memory: 200e6, cpu: 1.5 },
      { pid: 103, ppid: 102, name: "esbuild.exe", command: "C:\\work\\shop-website\\node_modules\\@esbuild\\esbuild.exe --service", startedAt: t + 30, memory: 30e6, cpu: 0.5 },
      { pid: 200, ppid: 50, name: "node.exe", command: "node C:\\work\\api-gateway\\node_modules\\nodemon\\bin\\nodemon.js", startedAt: t + 100, memory: 80e6 },
      { pid: 400, ppid: 1, name: "node.exe", command: "node /path/to/dx-toolkit/packages/web/dist/background.js", startedAt: t + 150, memory: 40e6 },
      { pid: 300, ppid: 400, name: "node.exe", command: "node C:\\work\\todo-app\\node_modules\\vite\\bin\\vite.js", startedAt: t + 200, memory: 90e6 },
    ],
  };
  const projects = ["shop-website", "api-gateway", "todo-app"].map((name) => ({ name, dir: `C:\\work\\${name}`, root: "C:\\work", kind: "node" as const, scripts: [], hasGit: false, lastActive: 0 }));
  const ports = [{ port: 5173, pid: 102, addresses: ["0.0.0.0"], system: false }];
  const list = groupProcesses(snapshot, ports, projects, [400]);
  const shop = list.find((p) => p.pid === 100)!;
  assert.equal(shop.label, "Vite", "npm → shell → vite is one entry, named for vite");
  assert.deepEqual(shop.children.sort(), [102, 103]);
  assert.equal(shop.memory, 280e6);
  assert.equal(shop.cpu, 2);
  assert.equal(shop.project, "shop-website");
  assert.equal(shop.startedBy, "WindowsTerminal");
  assert.equal(shop.leftBehind, false);
  assert.deepEqual(shop.ports, [{ port: 5173, addresses: ["0.0.0.0"], network: true }]);
  const left = list.find((p) => p.pid === 200)!;
  assert.equal(left.leftBehind, true);
  assert.equal(left.label, "nodemon");
  assert.equal(list[0].pid, 200, "left behind first");
  const dxRun = list.find((p) => p.pid === 400)!;
  assert.equal(dxRun.kind, "dx");
  assert.equal(dxRun.label, "dx dashboard");
  assert.deepEqual(dxRun.children, [], "a dev server dx started is its own entry");
  const served = list.find((p) => p.pid === 300)!;
  assert.equal(served.runByDx, true);
  assert.equal(served.leftBehind, false);
  assert.equal(served.project, "todo-app");
});

test("processes: parses what Windows and ps say", () => {
  const snap = parseWindowsSnapshot(
    "\uFEFF" + JSON.stringify({ all: [{ p: 5, pp: 1, n: "node.exe", t: 1700000000000 }], dev: { pid: 5, ppid: 1, name: "node.exe", cmd: "node x.js", t: 1700000000000, mem: 1024, cpu: 2.5 } }),
  );
  assert.equal(snap.all.length, 1);
  assert.equal(snap.dev[0].command, "node x.js", "a single process comes back as an object, not a list");
  assert.equal(snap.dev[0].cpu, 2.5);
  assert.equal(parseElapsed("05:03"), 303);
  assert.equal(parseElapsed("02:00:01"), 7201);
  assert.equal(parseElapsed("3-00:00:00"), 3 * 86400);
});

test("docker: containers and space, and only fixed clean-up commands", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const ok = (stdout: string) => ({ stdout, stderr: "", failed: false, missing: false });
    if (args[0] === "ps")
      return ok(
        [
          JSON.stringify({ ID: "abc123", Names: "shop-db-1", Image: "postgres:17", State: "running", Status: "Up 2 hours", Ports: "127.0.0.1:5432->5432/tcp", Labels: "com.docker.compose.project=shop,x=y" }),
          JSON.stringify({ ID: "def456", Names: "old-redis", Image: "redis:7", State: "exited", Status: "Exited (0) 3 weeks ago", Ports: "", Labels: "" }),
        ].join("\n"),
      );
    if (args[0] === "system") return ok(JSON.stringify({ Type: "Build Cache", TotalCount: 12, Size: "2.5GB", Reclaimable: "1.2GB" }));
    if (args[0] === "stats") return ok(JSON.stringify({ Name: "shop-db-1", CPUPerc: "0.50%", MemUsage: "120MiB / 7.6GiB" }));
    if (args[0] === "builder") return ok("Total reclaimed space: 1.2GB\n");
    if (args[0] === "stop") return ok("abc123\n");
    return ok("");
  };
  const info = await dockerInfo(run);
  assert.equal(info.running, true);
  assert.equal(info.containers[0].composeProject, "shop");
  assert.equal(info.containers[0].memory, "120MiB");
  assert.equal(info.disk[0].prune, "build-cache");
  assert.equal(info.disk[0].reclaimableBytes, 1.2e9);
  assert.deepEqual(await dockerPrune("build-cache", run), { ok: true, message: "Freed 1.2GB." });
  assert.equal((await dockerPrune("volumes" as never, run)).ok, false, "volumes hold data: never pruned");
  assert.equal((await dockerStop("nope", run)).ok, false, "only a container docker lists");
  assert.equal((await dockerStop("def456", run)).ok, false, "not running");
  assert.equal((await dockerStop("abc123", run)).ok, true);
  assert.deepEqual(calls.find((c) => c[0] === "stop"), ["stop", "--", "abc123"]);

  const down = await dockerInfo(async () => ({ stdout: "", stderr: "error during connect: is the docker daemon running?", failed: true, missing: false }));
  assert.deepEqual([down.installed, down.running, down.error], [true, false, undefined]);
  const none = await dockerInfo(async () => ({ stdout: "", stderr: "", failed: true, missing: true }));
  assert.equal(none.installed, false);
  assert.equal(parseSize("512MB (40%)"), 512e6);
  assert.equal(parseSize("0B"), 0);
});

test("services: database services, with commands to stop them, never run by dx", () => {
  const list = parseWindowsServices(JSON.stringify([{ name: "postgresql-x64-17", display: "PostgreSQL 17", state: "Running", start: "Auto", mem: 52428800 }]));
  assert.equal(list[0].running, true);
  assert.equal(list[0].atStartup, true);
  assert.equal(list[0].stop, 'Stop-Service -Name "postgresql-x64-17"');
  assert.equal(list[0].manual, 'Set-Service -Name "postgresql-x64-17" -StartupType Manual');
});
