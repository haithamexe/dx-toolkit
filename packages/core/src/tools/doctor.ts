import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { configPath, dxHome, ensureDxHome, loadConfig } from "../config.js";
import { listListeningPorts } from "./ports.js";
import { scanProjects } from "./projects.js";

const run = promisify(execFile);

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

/** Checks that everything dx relies on works on this machine. */
export async function runDoctor(): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js",
    status: major >= 22 ? "ok" : "fail",
    detail: major >= 22 ? `v${process.versions.node}` : `v${process.versions.node}; dx and Raycast need Node 22 or newer`,
  });

  try {
    ensureDxHome();
    fs.accessSync(dxHome(), fs.constants.W_OK);
    checks.push({ name: "dx folder", status: "ok", detail: dxHome() });
  } catch (err) {
    checks.push({ name: "dx folder", status: "fail", detail: `${dxHome()} isn't writable: ${(err as Error).message}` });
    return checks;
  }

  let config;
  try {
    config = loadConfig();
    checks.push({ name: "Config", status: "ok", detail: configPath() });
  } catch (err) {
    checks.push({ name: "Config", status: "fail", detail: (err as Error).message });
    return checks;
  }

  for (const root of config.projectsRoots) {
    const exists = fs.existsSync(root);
    checks.push({
      name: "Projects root",
      status: exists ? "ok" : "fail",
      detail: exists ? root : `${root} doesn't exist; fix "projectsRoots" in ${configPath()}`,
    });
  }
  const projects = scanProjects(config);
  checks.push({
    name: "Projects found",
    status: projects.length > 0 ? "ok" : "warn",
    detail: projects.length > 0 ? `${projects.length}` : "none; check projectsRoots and scanDepth",
  });

  const editor = await commandExists(config.editor);
  checks.push({
    name: "Editor",
    status: editor ? "ok" : "warn",
    detail: editor ? `${config.editor} → ${editor}` : `"${config.editor}" isn't on PATH; set "editor" in ${configPath()}`,
  });

  try {
    const ports = await listListeningPorts();
    checks.push({ name: "Port listing", status: "ok", detail: `${ports.length} listening port(s) visible` });
  } catch (err) {
    checks.push({ name: "Port listing", status: "fail", detail: (err as Error).message });
  }

  if (process.platform === "win32") {
    const wt = await commandExists("wt");
    checks.push({
      name: "Windows Terminal",
      status: wt ? "ok" : "warn",
      detail: wt ? wt : "not found; new terminal windows will open in plain cmd.exe",
    });
  }
  return checks;
}

/** Returns the resolved path of a command, or undefined if it can't be found. */
export async function commandExists(command: string): Promise<string | undefined> {
  // `"C:\Program Files\X\x.exe" --flag` → the quoted part; `code -n` → `code`
  const trimmed = command.trim();
  const unquoted = trimmed.startsWith('"') ? trimmed.slice(1, trimmed.indexOf('"', 1)) : trimmed.split(/\s+/)[0];
  if (/[\\/]/.test(unquoted)) return fs.existsSync(unquoted) ? unquoted : undefined;
  try {
    const { stdout } = await run(process.platform === "win32" ? "where" : "which", [unquoted], { windowsHide: true });
    return stdout.split(/\r?\n/).find(Boolean)?.trim();
  } catch {
    return undefined;
  }
}
