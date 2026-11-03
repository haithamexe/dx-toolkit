import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { configPath, dxHome, ensureDxHome, loadConfig } from "../config.js";
import { listAiTools } from "./aiSetup.js";
import { listListeningPorts } from "./ports.js";
import { scanProjects } from "./projects.js";

const run = promisify(execFile);

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** How to fix it: a command to run, or what to do. AI agents get this through MCP and can do it. */
  fix?: string;
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
      detail: exists ? root : `${root} doesn't exist`,
      fix: exists ? undefined : `dx config add-root <your code folder>, or remove it from "projectsRoots" in ${configPath()}`,
    });
  }
  const projects = scanProjects(config);
  checks.push({
    name: "Projects found",
    status: projects.length > 0 ? "ok" : "warn",
    detail: projects.length > 0 ? `${projects.length}` : "none in your projects folders",
    fix: projects.length > 0 ? undefined : "dx config add-root <the folder that holds your projects>",
  });

  const editor = await commandExists(config.editor);
  checks.push({
    name: "Editor",
    status: editor ? "ok" : "warn",
    detail: editor ? `${config.editor} → ${editor}` : `"${config.editor}" isn't on PATH`,
    fix: editor ? undefined : "dx config editor <command>, e.g. code, cursor or zed",
  });

  try {
    const ports = await listListeningPorts();
    checks.push({ name: "Port listing", status: "ok", detail: `${ports.length} listening port(s) visible` });
  } catch (err) {
    checks.push({ name: "Port listing", status: "fail", detail: (err as Error).message, fix: lsofFix() });
  }

  if (process.platform === "linux") {
    const clip = (await commandExists("wl-copy")) ?? (await commandExists("xclip"));
    checks.push({
      name: "Clipboard",
      status: clip ? "ok" : "warn",
      detail: clip ? clip : "neither wl-copy nor xclip is installed; dx summary --copy won't work",
      fix: clip ? undefined : linuxInstall(process.env.WAYLAND_DISPLAY ? "wl-clipboard" : "xclip"),
    });
  }

  const ai = await listAiTools();
  const installed = ai.filter((t) => t.installed);
  const missing = installed.filter((t) => !t.connected || !t.current);
  checks.push({
    name: "AI tools",
    status: installed.length === 0 ? "ok" : missing.length ? "warn" : "ok",
    detail:
      installed.length === 0
        ? "none found (Claude Code, Claude Desktop, Cursor, Windsurf, VS Code)"
        : missing.length
          ? `not connected to ${missing.map((t) => t.name).join(", ")}`
          : `connected to ${installed.map((t) => t.name).join(", ")}`,
    fix: missing.length ? "dx setup" : undefined,
  });

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

function linuxInstall(pkg: string): string {
  return `sudo apt install -y ${pkg}   (Fedora: sudo dnf install -y ${pkg}; Arch: sudo pacman -S ${pkg})`;
}

function lsofFix(): string | undefined {
  if (process.platform === "linux") return linuxInstall("lsof");
  if (process.platform === "darwin") return "lsof ships with macOS; check that /usr/sbin is on your PATH";
  return undefined;
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
