import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { configPath, dxHome, dxPath, ensureDxHome, loadConfig } from "../config.js";
import { listAiTools } from "./aiSetup.js";
import { browserInstallFix, findBrowser } from "./browser.js";
import { githubToken } from "./github.js";
import { certFiles, mkcertInstallFix } from "./https.js";
import { listListeningPorts } from "./ports.js";
import { scanProjects } from "./projects.js";
import { detectStack } from "./stacks.js";

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

  // Docker matters only when a project's stack has a database in docker-compose.
  const needDocker = projects.filter((p) => detectStack(p)?.services.some((s) => s.kind === "docker"));
  if (needDocker.length) {
    const docker = await commandExists("docker");
    checks.push({
      name: "Docker",
      status: docker ? "ok" : "warn",
      detail: docker ? docker : `not installed; ${needDocker.map((p) => p.name).slice(0, 3).join(", ")} start a database with it`,
      fix: docker ? undefined : "Install Docker Desktop (https://docs.docker.com/get-docker/), or on Linux the docker package, then start it",
    });
  }

  // Local domains (shop.localhost) run with the dashboard, on port 80 when they can get it.
  const dashboard = readDashboardFile();
  if (dashboard) {
    const p = dashboard.localDomainsPort;
    if (p === undefined) {
      checks.push({ name: "Local domains", status: "warn", detail: "off: no port was free", fix: "dx ui --stop, then open the dashboard again" });
    } else if (p === 80) {
      checks.push({ name: "Local domains", status: "ok", detail: "apps are at name.localhost" });
    } else {
      let holder = "";
      try {
        holder = (await listListeningPorts(80)).map((e) => e.processName ?? `PID ${e.pid}`).join(", ");
      } catch {
        // can't tell who
      }
      checks.push({
        name: "Local domains",
        status: "warn",
        detail: `on port ${p}, so addresses look like shop.localhost:${p}${holder ? ` (port 80 is used by ${holder})` : ""}`,
        fix:
          process.platform === "linux" && !holder
            ? "sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80 && echo net.ipv4.ip_unprivileged_port_start=80 | sudo tee /etc/sysctl.d/50-dx-localhost.conf, then dx ui --stop"
            : holder
              ? `Stop ${holder} if you don't need it, then dx ui --stop`
              : undefined,
      });
    }
  }

  // Local HTTPS is opt-in (dx https); once on, it needs mkcert and the certificate.
  if (config.https === true) {
    const mkcert = await commandExists("mkcert");
    const cert = fs.existsSync(certFiles().cert);
    checks.push({
      name: "Local HTTPS",
      status: mkcert && cert ? "ok" : "warn",
      detail: mkcert && cert ? "https://name.localhost uses a trusted local certificate" : !mkcert ? "on, but mkcert isn't installed" : "on, but there's no certificate yet",
      fix: mkcert && cert ? undefined : !mkcert ? `${mkcertInstallFix()}, then dx https` : "dx https",
    });
  }

  // AI agents load pages in it to see browser errors (check_url with browser).
  const browser = findBrowser();
  checks.push({
    name: "Headless browser",
    status: browser ? "ok" : "warn",
    detail: browser ? `${browser.name}: ${browser.path}` : "no Chrome, Edge, Chromium or Brave found; agents can't see errors in the browser",
    fix: browser ? undefined : browserInstallFix(),
  });

  // Private pull requests in dx summary need a GitHub login; only worth saying when there are GitHub repos.
  const onGithub = projects.some((p) => p.hasGit && hasGithubRemote(p.dir));
  if (onGithub) {
    const token = await githubToken();
    const gh = token ? undefined : await commandExists("gh");
    checks.push({
      name: "GitHub",
      status: token ? "ok" : "warn",
      detail: token ? "signed in: dx summary includes private pull requests" : "not signed in: dx summary shows pull requests from public repos only",
      fix: token ? undefined : gh ? "gh auth login" : `${ghInstall()}, then gh auth login (or set GITHUB_TOKEN)`,
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

/** The running dashboard's ~/.dx/dashboard.json, if there is one. */
function readDashboardFile(): { localDomainsPort?: number; pid: number } | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(dxPath("dashboard.json"), "utf8")) as { localDomainsPort?: number; pid: number };
    process.kill(info.pid, 0); // throws when that process is gone
    return info;
  } catch {
    return undefined;
  }
}

function hasGithubRemote(dir: string): boolean {
  try {
    return /github\.com/i.test(fs.readFileSync(`${dir}/.git/config`, "utf8"));
  } catch {
    return false;
  }
}

function ghInstall(): string {
  if (process.platform === "win32") return "winget install GitHub.cli";
  if (process.platform === "darwin") return "brew install gh";
  return linuxInstall("gh");
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
