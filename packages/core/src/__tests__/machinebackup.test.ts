import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Moving to a new computer: what a computer has, the file's strict reading, and the plan for what
// another still needs. Commands are stand-ins and the home is a temp folder: nothing real is run.
process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-machine-home-"));
const { captureMachine, readMachine, restorePlan, restoreScript, MachineFileError } = await import("../index.js");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-machine-ssh-"));
fs.mkdirSync(path.join(home, ".ssh"));
for (const f of ["id_ed25519", "id_ed25519.pub", "known_hosts", "config"]) fs.writeFileSync(path.join(home, ".ssh", f), "PRIVATE KEY MATERIAL");

const answers: Record<string, string> = {
  "git config --get user.name": "Octo Cat\n",
  "git config --get user.email": "octocat@example.com\n",
  "git config --get init.defaultBranch": "main\n",
  "git config --get core.autocrlf": "input\n",
  "npm ls -g --depth=0 --json": 'npm warn something\n{"dependencies":{"npm":{"version":"11.0.0"},"corepack":{"version":"0.30.0"},"dx-devkit":{"version":"1.9.0"},"typescript":{"version":"5.9.2"},"@scope/tool":{"version":"2.0.1"},"bad name!":{"version":"1.0.0"}}}\n',
  "code --list-extensions": "ms-python.python\nesbenp.prettier-vscode\nnot an id\n",
};
const run = async (cmd: string, args: string[]) => answers[[cmd, ...args].join(" ")] ?? "";
const installed = [
  { id: "node" as const, version: "24.1.0" },
  { id: "npm" as const, version: "11.0.0" },
  { id: "git" as const, version: "2.49.0.windows.1" },
  { id: "docker" as const },
];

test("a computer is described by its tools, global packages, git settings, extensions and SSH key names, and nothing secret", async () => {
  const m = await captureMachine({ run, installed, home, now: new Date("2026-11-10T10:00:00Z") });
  assert.deepEqual(m.tools.map((t) => [t.id, t.version]), [["node", "24.1.0"], ["npm", "11.0.0"], ["git", "2.49.0.windows.1"]], "only what has a version");
  assert.deepEqual(m.npmGlobals, [{ name: "@scope/tool", version: "2.0.1" }, { name: "typescript", version: "5.9.2" }], "npm, corepack and dx itself are left out, and a bad name");
  assert.deepEqual(m.git, { name: "Octo Cat", email: "octocat@example.com", defaultBranch: "main", autocrlf: "input" });
  assert.deepEqual(m.extensions, ["esbenp.prettier-vscode", "ms-python.python"]);
  assert.deepEqual(m.sshKeys, ["id_ed25519"], "key names only: not the .pub, known_hosts or config");
  assert.ok(!JSON.stringify(m).includes("PRIVATE KEY"));
  assert.equal(JSON.stringify(readMachine(JSON.stringify(m))), JSON.stringify(m), "what is exported reads back unchanged");
});

test("a machine file is read strictly: its text becomes commands, so every value is checked", () => {
  const ok = { format: "dx-machine", version: 1, exportedAt: "2026-11-10T10:00:00Z", platform: { os: "win32", arch: "x64" }, tools: [], npmGlobals: [], git: {}, extensions: [], sshKeys: [] };
  const bad = (o: unknown, re: RegExp) => assert.throws(() => readMachine(JSON.stringify(o)), (e: Error) => e instanceof MachineFileError && re.test(e.message));
  readMachine(JSON.stringify(ok));
  bad({ ...ok, extra: 1 }, /Unknown field/);
  bad({ ...ok, format: "dx-state" }, /isn't a dx machine file/);
  bad({ ...ok, version: 2 }, /newer dx/);
  bad({ ...ok, tools: [{ id: "node; rm -rf ~", version: "1.0.0" }] }, /isn't one dx knows/);
  bad({ ...ok, tools: [{ id: "node", version: "1.0.0; echo x" }] }, /isn't one dx knows|no version/);
  bad({ ...ok, npmGlobals: [{ name: "x; curl evil | sh", version: "1.0.0" }] }, /isn't valid/);
  bad({ ...ok, npmGlobals: [{ name: "left-pad", version: "latest" }] }, /isn't valid/);
  bad({ ...ok, git: { name: "a\nb" } }, /git name/);
  bad({ ...ok, git: { email: "a@b.c; x" } }, /git email/);
  bad({ ...ok, git: { defaultBranch: "main; x" } }, /branch name/);
  bad({ ...ok, git: { editor: "evil" } }, /Unknown git setting/);
  bad({ ...ok, extensions: ["a.b && x"] }, /extension/);
  bad({ ...ok, sshKeys: ["../../id_rsa"] }, /SSH key/);
  assert.throws(() => readMachine("{nope"), /not JSON/);
  assert.throws(() => readMachine("x".repeat(600 * 1024)), /at most 512 KB/);
});

test("the plan lists what is missing or older, with commands for this computer's shell, and counts what already matches", async () => {
  const file = readMachine(JSON.stringify(await captureMachine({ run, installed, home, now: new Date() })));
  const bare = { ...file, tools: [{ id: "node" as const, name: "Node.js", version: "22.3.0" }], npmGlobals: [{ name: "typescript", version: "5.9.2" }], git: { name: "Someone Else" }, extensions: ["ms-python.python"], sshKeys: [] as string[] };
  const win = restorePlan(file, bare, "win32");
  assert.ok(win.steps.some((s) => s.kind === "tool" && /npm 11\.0\.0 isn't installed/.test(s.label)));
  assert.ok(win.steps.some((s) => s.command === "winget install --id Git.Git"));
  assert.ok(win.steps.some((s) => /Node\.js 22\.3\.0 is older than the 24\.1\.0/.test(s.label)), "an older major is a step");
  assert.ok(!restorePlan({ ...file, tools: [{ id: "node", name: "Node.js", version: "22.3.0" }] }, file, "win32").steps.some((s) => /Node/.test(s.label)), "a newer node than the file's is as good");
  assert.equal(win.steps.find((s) => s.kind === "npm")?.command, "npm install -g @scope/tool@2.0.1");
  assert.ok(win.steps.some((s) => s.command === "git config --global user.name 'Octo Cat'"));
  assert.ok(win.steps.some((s) => s.command === "git config --global core.autocrlf 'input'"));
  assert.ok(win.steps.some((s) => s.command === "code --install-extension esbenp.prettier-vscode"));
  assert.ok(!win.steps.some((s) => /ms-python/.test(s.label)), "the one it has isn't listed");
  assert.equal(win.have, 2, "the global package and the extension it has");
  const noSshHere = restorePlan({ ...file, sshKeys: ["id_ed25519"] }, bare, "linux");
  assert.ok(noSshHere.steps.some((s) => s.kind === "ssh" && /never copy the private key/.test(s.advice ?? "")));
  assert.equal(restorePlan(file, file, "linux").steps.length, 0, "the same computer needs nothing");
});

test("PowerShell's typographic quotes are quotes too, so they're doubled; C1 controls and a leading dash are refused", () => {
  const f = readMachine(JSON.stringify({ format: "dx-machine", version: 1, exportedAt: "", platform: { os: "win32", arch: "x64" }, tools: [], npmGlobals: [], git: { name: "a\u2019; calc.exe; \u2018b" }, extensions: [], sshKeys: [] }));
  const step = restorePlan(f, { ...f, git: {} }, "win32").steps[0];
  assert.equal(step.command, "git config --global user.name 'a\u2019\u2019; calc.exe; \u2018\u2018b'", "each typographic quote doubled, so the text stays inside the quotes");
  const bad = (git: unknown) => assert.throws(() => readMachine(JSON.stringify({ format: "dx-machine", version: 1, git })), MachineFileError);
  bad({ name: "-x" });
  bad({ name: "a\u009bb" });
  assert.equal(readMachine(JSON.stringify({ format: "dx-machine", version: 1, platform: { os: "\u001b[2Jwin32" } })).platform.os, "", "a platform with control characters is dropped");
  assert.throws(() => readMachine(JSON.stringify({ format: "dx-machine", version: 1, npmGlobals: [{ name: "-x", version: "1.0.0" }] })), MachineFileError);
});

test("a name with a quote is quoted for the shell, and the script is text to read: comments and commands, never run by dx", () => {
  const f = readMachine(JSON.stringify({ format: "dx-machine", version: 1, exportedAt: "", platform: { os: "linux", arch: "x64" }, tools: [], npmGlobals: [], git: { name: "O'Hara $(x)" }, extensions: [], sshKeys: [] }));
  const empty = { ...f, git: {} };
  const sh = restorePlan(f, empty, "linux");
  assert.equal(sh.steps[0].command, "git config --global user.name 'O'\\''Hara $(x)'");
  const ps = restorePlan(f, empty, "win32");
  assert.equal(ps.steps[0].command, "git config --global user.name 'O''Hara $(x)'");
  const script = restoreScript(sh, "linux");
  assert.ok(script.startsWith("#!/bin/sh\n") && script.includes("# git user.name is not set") && script.includes("git config --global user.name"));
  assert.ok(restoreScript(ps, "win32").includes("\r\n"));
});
