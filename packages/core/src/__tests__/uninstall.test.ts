import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-uninstall-test-"));
const { planUninstall, runUninstall, uninstallBlocked, unsafeDataDir, describeDxProcess } = await import("../index.js");
type ProcessRow = { pid: number; ppid: number; name: string; command: string };

const cmdShim = (target: string) => `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\${target}" %*\r\n`;

/**
 * A pretend computer: npm's global folders with dx-devkit and a linked build, their shims and a
 * foreign one, a repository, the app's folder, shortcuts, Cursor connected to dx, and processes.
 * Nothing here is the real machine's.
 */
function computer() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dx-uninstall-pc-"));
  const root = path.join(base, "npm", "node_modules");
  const binDir = path.join(base, "npm");
  const npmDir = path.join(root, "dx-devkit");
  fs.mkdirSync(npmDir, { recursive: true });
  fs.writeFileSync(path.join(npmDir, "package.json"), JSON.stringify({ name: "dx-devkit", version: "1.8.0" }));

  // A clone of the repository, linked as @dx/cli.
  const repo = path.join(base, "code", "dx-toolkit");
  const cli = path.join(repo, "packages", "cli");
  fs.mkdirSync(path.join(cli, "dist"), { recursive: true });
  fs.writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@dx/cli", version: "1.10.0" }));
  fs.writeFileSync(path.join(cli, "dist", "index.js"), "// the build\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# kept\n");
  fs.mkdirSync(path.join(root, "@dx"), { recursive: true });
  fs.symlinkSync(cli, path.join(root, "@dx", "cli"), "junction");

  fs.writeFileSync(path.join(binDir, "dx.cmd"), cmdShim("dx-devkit\\dist\\index.js"));
  fs.writeFileSync(path.join(binDir, "dx-mcp.cmd"), cmdShim("dx-devkit\\bin\\dx-mcp.js"));
  fs.writeFileSync(path.join(binDir, "dx"), '#!/bin/sh\nexec node "$basedir/node_modules/@dx/cli/dist/index.js" "$@"\n');
  fs.writeFileSync(path.join(binDir, "dx.ps1"), "# another program called dx\n");
  fs.writeFileSync(path.join(binDir, "tsc.cmd"), cmdShim("typescript\\bin\\tsc"));
  // Another project's linked CLI that is also called dx-mcp, built under its own packages/cli.
  fs.writeFileSync(path.join(binDir, "dx-mcp"), '#!/bin/sh\nexec node "/code/other-monorepo/packages/cli/dist/index.js" "$@"\n');

  // The app, and its shortcuts in a pretend Start menu.
  const appHome = path.join(base, "dxapp");
  fs.mkdirSync(path.join(appHome, "runtime", "45.2.3"), { recursive: true });
  fs.writeFileSync(path.join(appHome, "launch.json"), "{}");
  const env = { APPDATA: path.join(base, "appdata") };
  const programs = path.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
  fs.mkdirSync(path.join(programs, "Startup"), { recursive: true });
  for (const f of [path.join(programs, "dx.lnk"), path.join(programs, "Startup", "dx.lnk"), path.join(programs, "Startup", "dx Floppy.lnk")]) fs.writeFileSync(f, "lnk");
  const otherShortcut = path.join(programs, "Startup", "Something else.lnk");
  fs.writeFileSync(otherShortcut, "lnk");

  // Cursor, connected to dx.
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { dx: { command: "node", args: ["x"] }, other: { command: "y" } } }));
  const ai = { home, appData: path.join(base, "ai-appdata"), platform: "win32" as const, node: "node", script: "x", hasClaudeCli: async () => false, claudeCli: async () => ({ ok: false, output: "" }) };

  const self = 100;
  const rows: ProcessRow[] = [
    { pid: 1, ppid: 0, name: "explorer.exe", command: "explorer.exe" },
    { pid: 90, ppid: 1, name: "node.exe", command: `node ${npmDir}\\node_modules\\@dx\\web\\dist\\background.js` }, // the dashboard, which started this
    { pid: self, ppid: 90, name: "node.exe", command: `node C:\\Temp\\dx-uninstall-x\\core\\uninstallRunner.js` },
    { pid: 200, ppid: 1, name: "node.exe", command: `node ${npmDir}\\node_modules\\@dx\\mcp\\dist\\index.js` },
    { pid: 201, ppid: 1, name: "dx.exe", command: `${appHome}\\current\\dx.exe ${npmDir}\\node_modules\\@dx\\web\\shell` },
    { pid: 202, ppid: 1, name: "node.exe", command: `node ${path.join(repo, "packages", "mcp", "dist", "index.js")}` },
    { pid: 300, ppid: 1, name: "node.exe", command: "node C:\\code\\shop-website\\node_modules\\next\\dist\\bin\\next dev" },
    { pid: 301, ppid: 1, name: "node.exe", command: `node ${path.join(base, "dxapp-backup", "x.js")}` },
    // Programs that only mention dx's folder: an editor with dx's config open, a terminal tailing the run log.
    { pid: 302, ppid: 1, name: "Code.exe", command: `"C:\\Program Files\\Microsoft VS Code\\Code.exe" ${path.join(process.env.DX_HOME!, "config.json")}` },
    { pid: 303, ppid: 1, name: "powershell.exe", command: `powershell -NoExit Get-Content -Wait ${path.join(process.env.DX_HOME!, "runs.jsonl")}` },
    { pid: 304, ppid: 1, name: "node.exe", command: `node C:\\tools\\notes.js ${path.join(process.env.DX_HOME!, "journal", "x.md")}` },
    // The dx browser and Floppy's window are dx's.
    { pid: 210, ppid: 1, name: "chrome.exe", command: `chrome.exe --remote-debugging-pipe --user-data-dir=${path.join(process.env.DX_HOME!, "browser-profile")}` },
    { pid: 211, ppid: 1, name: "powershell.exe", command: `powershell -NoProfile -Command "Invoke-Expression (Get-Content -Raw '${path.join(process.env.DX_HOME!, "floppy", "floppy.ps1")}')"` },
    // A dev server the dashboard runs.
    { pid: 91, ppid: 90, name: "node.exe", command: "node C:\\code\\todo-app\\node_modules\\vite\\bin\\vite.js" },
  ];
  const stopped: Array<[number, boolean]> = [];
  const uenv = {
    dirs: { root, binDir },
    npm: (args: string[]) => {
      if (args[0] === "uninstall" && args.includes("dx-devkit")) fs.rmSync(npmDir, { recursive: true, force: true });
      return { ok: true, out: "" };
    },
    processes: async () => rows.filter((r) => !stopped.some(([p]) => p === r.pid)),
    stop: async (pid: number, tree: boolean) => (stopped.push([pid, tree]), true),
    alive: (pid: number) => pid === 90 && !stopped.some(([p]) => p === 90),
    sleep: async () => undefined,
    ai,
    env,
    platform: "win32" as const,
    appHome,
    self,
  };
  return { base, root, binDir, npmDir, repo, cli, appHome, programs, otherShortcut, home, uenv, stopped };
}

test("the plan lists every kind of dx, and only dx's", async () => {
  const pc = computer();
  const plan = await planUninstall(pc.uenv);
  assert.deepEqual(
    plan.installs.map((i) => [i.kind, i.version]),
    [
      ["npm", "1.8.0"],
      ["local", "1.10.0"],
    ],
  );
  assert.equal(path.resolve(plan.installs[1].dir), path.resolve(pc.repo), "a linked build is named by its repository");
  assert.deepEqual(plan.shims.map((s) => path.basename(s)).sort(), ["dx", "dx-mcp.cmd", "dx.cmd"], "another program's dx.ps1 and tsc aren't dx's");
  assert.equal(plan.app?.dir, pc.appHome);
  assert.equal(plan.entries.length, 3, "the Start menu entry, the app's and Floppy's Startup shortcuts");
  assert.deepEqual(plan.aiTools, ["Cursor"]);
  assert.deepEqual(
    plan.processes.map((p) => p.pid),
    [200, 201, 202, 210, 211],
    "never this process or the dashboard that started it, nor a project's dev server or a folder that only starts like the app's",
  );
  assert.deepEqual(
    plan.processes.map((p) => p.what),
    ["an AI tool's dx server", "the dx app", "an AI tool's dx server", "the dx browser", "Floppy"],
  );
  assert.ok(plan.blocked, "with DX_HOME set, the removal itself is refused");
});

test("removing takes every install, shim, the app, shortcuts, AI entries and processes, and leaves the rest", async () => {
  const pc = computer();
  fs.mkdirSync(process.env.DX_HOME!, { recursive: true });
  fs.writeFileSync(path.join(process.env.DX_HOME!, "config.json"), "{}");
  fs.writeFileSync(path.join(process.env.DX_HOME!, "dashboard.json"), "{}");
  const lines: string[] = [];
  const r = await runUninstall({ data: false, waitFor: 90, env: pc.uenv, log: (l) => lines.push(l) });
  assert.equal(r.ok, true, r.left.join("; "));

  assert.ok(!fs.existsSync(pc.npmDir), "dx-devkit is gone");
  assert.ok(!fs.existsSync(path.join(pc.root, "@dx")), "the link and its empty @dx folder are gone");
  assert.ok(fs.existsSync(path.join(pc.cli, "dist", "index.js")) && fs.existsSync(path.join(pc.repo, "README.md")), "the repository behind the link is untouched");
  assert.deepEqual(fs.readdirSync(pc.binDir).sort(), ["dx-mcp", "dx.ps1", "node_modules", "tsc.cmd"], "only dx's shims went, not another project's linked CLI");
  assert.ok(!fs.existsSync(pc.appHome), "the app with its Electron versions is gone");
  assert.deepEqual(fs.readdirSync(path.join(pc.programs, "Startup")), ["Something else.lnk"], "only dx's shortcuts went");
  assert.ok(!fs.existsSync(path.join(pc.programs, "dx.lnk")));
  const cursor = JSON.parse(fs.readFileSync(path.join(pc.home, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(cursor.mcpServers), ["other"], "dx left Cursor; Cursor's other servers stay");

  const stoppedPids = pc.stopped.map(([p]) => p);
  assert.ok(stoppedPids.includes(90), "the dashboard that didn't close was stopped");
  assert.deepEqual(pc.stopped.find(([p]) => p === 90), [90, false], "on its own, never as a tree: this process is its child");
  assert.deepEqual(pc.stopped.find(([p]) => p === 91), [91, true], "what the dashboard still ran was stopped with its children first");
  for (const pid of [200, 201, 202, 210, 211]) assert.ok(pc.stopped.some(([p, tree]) => p === pid && tree), `PID ${pid} was stopped with its children`);
  for (const pid of [1, 100, 300, 301, 302, 303, 304]) assert.ok(!stoppedPids.includes(pid), `PID ${pid} isn't dx's and was left running`);

  assert.ok(fs.existsSync(path.join(process.env.DX_HOME!, "config.json")), "what dx keeps stays without data");
  assert.ok(!fs.existsSync(path.join(process.env.DX_HOME!, "dashboard.json")), "but not the note of a dashboard that's gone");
  assert.ok(lines.some((l) => l.includes("dx-devkit 1.8.0")));
});

test("with data, ~/.dx goes too", async () => {
  const pc = computer();
  const home = process.env.DX_HOME!;
  fs.mkdirSync(path.join(home, "activity"), { recursive: true });
  fs.writeFileSync(path.join(home, "activity", "x.jsonl"), "{}\n");
  const r = await runUninstall({ data: true, env: { ...pc.uenv, alive: () => false } });
  assert.equal(r.ok, true, r.left.join("; "));
  assert.ok(!fs.existsSync(home));
  fs.mkdirSync(home, { recursive: true });
});

test("a data folder that holds the home folder or is a drive's root is never deleted", () => {
  assert.match(unsafeDataDir(os.homedir()) ?? "", /home folder/);
  assert.match(unsafeDataDir(path.dirname(os.homedir())) ?? "", /home folder/);
  assert.match(unsafeDataDir(path.parse(os.homedir()).root) ?? "", /root/);
  assert.equal(unsafeDataDir(path.join(os.homedir(), ".dx")), undefined);
});

test("refused under DX_HOME, and processes are named", () => {
  assert.ok(uninstallBlocked({ DX_HOME: "/tmp/x" }));
  assert.equal(uninstallBlocked({}), undefined);
  assert.equal(describeDxProcess("node C:\\x\\dx-devkit\\node_modules\\@dx\\web\\dist\\background.js"), "the dashboard");
  assert.equal(describeDxProcess("node /x/node_modules/@dx/web/dist/floppyapp.js --detach"), "Floppy");
});

test("the removal runs from a copy of core in a temp folder, which refuses a DX_HOME copy of dx", async () => {
  const { startUninstall } = await import("../index.js");
  const r = startUninstall({ data: true, foreground: true });
  assert.equal(r.status, 1);
  assert.match(fs.readFileSync(r.log, "utf8"), /DX_HOME is set/);
  const core = path.join(path.dirname(r.log), "core");
  assert.ok(fs.existsSync(path.join(core, "uninstallRunner.js")) && fs.existsSync(path.join(core, "tools", "uninstall.js")));
  assert.ok(!fs.existsSync(path.join(core, "__tests__")), "tests aren't copied");
  fs.rmSync(path.dirname(r.log), { recursive: true, force: true });
});
