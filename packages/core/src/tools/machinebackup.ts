import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findInstalledTools, installCommand, TOOL_IDS, toolName, defaultRunner, type Installed, type Runner, type ToolId } from "./machine.js";
import { majorOf } from "./versions.js";

/**
 * Moving to a new computer: `dx machine export` writes what this one has for development (the tools
 * and their versions, global npm packages, git's own settings, the editor's extensions, the names
 * of the SSH keys) and `dx machine restore <file>` works out what the other computer still needs,
 * as commands to read and run yourself. Nothing is installed by dx, and the file holds no secrets:
 * no key, token, password or path. It's read strictly, since its text becomes commands.
 */

export interface MachineFile {
  format: "dx-machine";
  version: 1;
  exportedAt: string;
  platform: { os: string; arch: string };
  tools: { id: ToolId; name: string; version: string }[];
  npmGlobals: { name: string; version: string }[];
  git: { name?: string; email?: string; defaultBranch?: string; autocrlf?: "true" | "false" | "input" };
  extensions: string[];
  /** Names of the SSH keys that exist (id_ed25519…), never what's in them. */
  sshKeys: string[];
}

export const MACHINE_FILE_MAX = 512 * 1024;
const NPM_NAME = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const SEMVER = /^\d{1,6}\.\d{1,6}\.\d{1,6}([-+][\w.-]{1,40})?$/;
const EXTENSION = /^[a-z0-9][\w-]{0,60}\.[a-z0-9][\w-]{0,60}$/i;
const SSH_KEY = /^id_(rsa|ed25519|ecdsa|dsa)$/;
// Packages that come with the tools above, not worth restoring.
const NPM_SKIP = new Set(["npm", "corepack", "dx-devkit"]);
const plain = (s: unknown, max = 200): string | undefined => (typeof s === "string" && s.length >= 1 && s.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(s) ? s : undefined);

/** Gathers what this computer has. `run` and `installed` are replaceable for tests; the commands are fixed. */
export async function captureMachine(options: { run?: Runner; installed?: Installed[]; home?: string; now?: Date } = {}): Promise<MachineFile> {
  const run = options.run ?? defaultRunner;
  const installed = options.installed ?? (await findInstalledTools());
  const home = options.home ?? os.homedir();
  // The value git uses (system, global and included files), not only the one in ~/.gitconfig: Git for Windows sets autocrlf in the system file.
  const git = async (key: string) => plain((await run("git", ["config", "--get", key])).split(/\r?\n/)[0]?.trim());

  let npmGlobals: MachineFile["npmGlobals"] = [];
  if (installed.some((t) => t.id === "npm" && t.version)) {
    const out = await run("npm", ["ls", "-g", "--depth=0", "--json"]);
    try {
      const deps = (JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as { dependencies?: Record<string, { version?: string }> }).dependencies ?? {};
      npmGlobals = Object.entries(deps)
        .filter(([name, d]) => NPM_NAME.test(name) && !NPM_SKIP.has(name) && SEMVER.test(d.version ?? ""))
        .map(([name, d]) => ({ name, version: d.version as string }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // npm printed something else: no globals listed
    }
  }
  const extensions = (await run("code", ["--list-extensions"])).split(/\r?\n/).map((l) => l.trim()).filter((l) => EXTENSION.test(l)).sort();
  let sshKeys: string[] = [];
  try {
    sshKeys = fs.readdirSync(path.join(home, ".ssh")).filter((f) => SSH_KEY.test(f)).sort();
  } catch {
    // no .ssh folder
  }
  const autocrlf = await git("core.autocrlf");
  return {
    format: "dx-machine",
    version: 1,
    exportedAt: (options.now ?? new Date()).toISOString(),
    platform: { os: process.platform, arch: process.arch },
    tools: installed.filter((t) => t.version && SEMVER.test(t.version.replace(/\.windows\.\d+$/, ""))).map((t) => ({ id: t.id, name: toolName(t.id), version: t.version as string })),
    npmGlobals,
    git: { name: await git("user.name"), email: await git("user.email"), defaultBranch: await git("init.defaultBranch"), ...(autocrlf === "true" || autocrlf === "false" || autocrlf === "input" ? { autocrlf } : {}) },
    extensions,
    sshKeys,
  };
}

export class MachineFileError extends Error {}

/** Reads a machine file strictly: known fields only, each value checked, since the plan's commands are built from them. */
export function readMachine(input: unknown): MachineFile {
  let o: unknown = input;
  if (typeof input === "string") {
    if (input.length > MACHINE_FILE_MAX) throw new MachineFileError("A dx machine file is at most 512 KB.");
    try {
      o = JSON.parse(input.replace(/^﻿/, ""));
    } catch {
      throw new MachineFileError("That isn't a dx machine file (not JSON).");
    }
  }
  const f = o as Record<string, unknown>;
  if (!f || typeof f !== "object" || f.format !== "dx-machine") throw new MachineFileError("That isn't a dx machine file.");
  if (f.version !== 1) throw new MachineFileError("This machine file is from a newer dx; update dx and try again.");
  const known = new Set(["format", "version", "exportedAt", "platform", "tools", "npmGlobals", "git", "extensions", "sshKeys"]);
  for (const k of Object.keys(f)) if (!known.has(k)) throw new MachineFileError(`Unknown field "${k}" in the machine file.`);
  const list = (v: unknown, what: string, max: number): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max) throw new MachineFileError(`${what} must be a list of at most ${max}.`);
    return v;
  };
  const ids = new Set<string>(TOOL_IDS);
  const tools = list(f.tools, "tools", 40).map((t) => {
    const x = t as Record<string, unknown>;
    if (!x || typeof x.id !== "string" || !ids.has(x.id) || typeof x.version !== "string" || !SEMVER.test(x.version.replace(/\.windows\.\d+$/, ""))) throw new MachineFileError("A tool in the file isn't one dx knows, or has no version.");
    return { id: x.id as ToolId, name: toolName(x.id as ToolId), version: x.version };
  });
  const npmGlobals = list(f.npmGlobals, "npmGlobals", 300).map((p) => {
    const x = p as Record<string, unknown>;
    if (!x || typeof x.name !== "string" || !NPM_NAME.test(x.name) || typeof x.version !== "string" || !SEMVER.test(x.version)) throw new MachineFileError("A global package in the file has a name or version that isn't valid.");
    return { name: x.name, version: x.version };
  });
  const g = (f.git ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(g)) if (!["name", "email", "defaultBranch", "autocrlf"].includes(k)) throw new MachineFileError(`Unknown git setting "${k}".`);
  const git: MachineFile["git"] = {};
  // A name starting with - would read as an option to git config.
  if (g.name !== undefined) git.name = (typeof g.name === "string" && !g.name.startsWith("-") ? plain(g.name) : undefined) ?? (() => { throw new MachineFileError("The git name isn't valid."); })();
  if (g.email !== undefined) git.email = typeof g.email === "string" && /^[^\s@<>"'`$\\]{1,100}@[^\s@<>"'`$\\]{1,100}$/.test(g.email) ? g.email : (() => { throw new MachineFileError("The git email isn't valid."); })();
  if (g.defaultBranch !== undefined) git.defaultBranch = typeof g.defaultBranch === "string" && /^[\w./-]{1,60}$/.test(g.defaultBranch) ? g.defaultBranch : (() => { throw new MachineFileError("The default branch name isn't valid."); })();
  if (g.autocrlf !== undefined) git.autocrlf = g.autocrlf === "true" || g.autocrlf === "false" || g.autocrlf === "input" ? g.autocrlf : (() => { throw new MachineFileError("core.autocrlf must be true, false or input."); })();
  const extensions = list(f.extensions, "extensions", 500).map((e) => {
    if (typeof e !== "string" || !EXTENSION.test(e)) throw new MachineFileError("An editor extension in the file has an id that isn't valid.");
    return e;
  });
  const sshKeys = list(f.sshKeys, "sshKeys", 10).map((k) => {
    if (typeof k !== "string" || !SSH_KEY.test(k)) throw new MachineFileError("An SSH key name in the file isn't one of the standard ones.");
    return k;
  });
  const p = (f.platform ?? {}) as Record<string, unknown>;
  return {
    format: "dx-machine",
    version: 1,
    exportedAt: plain(f.exportedAt, 40) ?? "",
    platform: { os: plain(p.os, 20) ?? "", arch: plain(p.arch, 20) ?? "" },
    tools,
    npmGlobals,
    git,
    extensions,
    sshKeys,
  };
}

export interface RestoreStep {
  kind: "tool" | "npm" | "git" | "extension" | "ssh";
  /** One line a person reads: "Node.js 24.1.0 isn't installed". */
  label: string;
  /** A command to run, as written for this computer's shell. */
  command?: string;
  /** What to do by hand when there's no command. */
  advice?: string;
}

export interface RestorePlan {
  /** Where the file was made, and where this is. */
  from: string;
  to: string;
  /** What is already as in the file. */
  have: number;
  steps: RestoreStep[];
}

// PowerShell also reads the typographic single quotes (U+2018 to U+201B) as quotes inside '...', so each is doubled too.
const shq = (s: string, powershell: boolean) => (powershell ? `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'` : `'${s.replace(/'/g, `'\\''`)}'`);

/** What this computer still needs to match the file, as steps (nothing is run). */
export function restorePlan(file: MachineFile, current: MachineFile, platform: NodeJS.Platform = process.platform): RestorePlan {
  const ps = platform === "win32";
  const steps: RestoreStep[] = [];
  let have = 0;
  const nodeMajor = current.tools.find((t) => t.id === "node") ? majorOf(current.tools.find((t) => t.id === "node")!.version) : undefined;
  for (const t of file.tools) {
    const here = current.tools.find((c) => c.id === t.id);
    // Git for Windows' build number is kept in the version; the numbers before it are what's compared.
    const want = t.version.replace(/\.windows\.\d+$/, "");
    // The same major or newer is as in the file: an older patch of the same line isn't worth a step.
    if (here && majorOf(here.version) >= majorOf(want)) {
      have++;
      continue;
    }
    const how = installCommand(t.id, platform, nodeMajor);
    steps.push({
      kind: "tool",
      label: here ? `${t.name} ${here.version} is older than the ${t.version} the file has` : `${t.name} ${t.version} isn't installed`,
      ...(how.fix && how.runnable ? { command: how.fix } : { advice: how.fix ?? `Install ${t.name} ${majorOf(want)} or newer.` }),
    });
  }
  const missingPkgs = file.npmGlobals.filter((p) => !current.npmGlobals.some((c) => c.name === p.name));
  have += file.npmGlobals.length - missingPkgs.length;
  for (let i = 0; i < missingPkgs.length; i += 20) {
    const group = missingPkgs.slice(i, i + 20);
    steps.push({ kind: "npm", label: `Global npm packages missing: ${group.map((p) => p.name).join(", ")}`, command: `npm install -g ${group.map((p) => `${p.name}@${p.version}`).join(" ")}` });
  }
  for (const [key, want] of [["name", "user.name"], ["email", "user.email"], ["defaultBranch", "init.defaultBranch"], ["autocrlf", "core.autocrlf"]] as const) {
    const wanted = file.git[key];
    if (!wanted) continue;
    if (current.git[key] === wanted) have++;
    else steps.push({ kind: "git", label: `git ${want} is ${current.git[key] ? `"${current.git[key]}"` : "not set"}; the file has "${wanted}"`, command: `git config --global ${want} ${shq(wanted, ps)}` });
  }
  const missingExt = file.extensions.filter((e) => !current.extensions.some((c) => c.toLowerCase() === e.toLowerCase()));
  have += file.extensions.length - missingExt.length;
  for (const e of missingExt) steps.push({ kind: "extension", label: `Editor extension ${e} isn't installed`, command: `code --install-extension ${e}` });
  if (file.sshKeys.length && !current.sshKeys.length) {
    steps.push({ kind: "ssh", label: `There was an SSH key (${file.sshKeys.join(", ")}) and this computer has none`, advice: "Make a new one rather than copying the old: ssh-keygen -t ed25519, then add its public key to GitHub with gh ssh-key add ~/.ssh/id_ed25519.pub (never copy the private key by mail or chat)." });
  } else if (file.sshKeys.length) have++;
  return { from: `${file.platform.os} ${file.platform.arch}`.trim(), to: `${current.platform.os} ${current.platform.arch}`.trim(), have, steps };
}

/** The runnable steps as a script to read first and run yourself: PowerShell on Windows, sh elsewhere. dx never runs it. */
export function restoreScript(plan: RestorePlan, platform: NodeJS.Platform = process.platform): string {
  const ps = platform === "win32";
  const out = ps ? ["# dx machine restore: read it, then run it in PowerShell. dx doesn't run it for you.", ""] : ["#!/bin/sh", "# dx machine restore: read it, then run it. dx doesn't run it for you.", ""];
  for (const s of plan.steps) {
    out.push(`# ${s.label.replace(/[\r\n]+/g, " ")}`);
    if (s.command) out.push(s.command);
    else out.push(`# ${(s.advice ?? "").replace(/[\r\n]+/g, " ")}`);
    out.push("");
  }
  return out.join(ps ? "\r\n" : "\n");
}
