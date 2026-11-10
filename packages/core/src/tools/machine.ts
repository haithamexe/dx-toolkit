import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dxPath } from "../config.js";
import { compareVersions, majorOf, parseVersion, toVersion } from "./versions.js";

/**
 * The developer tools on this computer: which are installed, their version, what installed
 * them, whether a newer one is out, and whether that version still gets security fixes.
 * Latest versions come from public sources (endoflife.date, the npm registry, GitHub releases),
 * kept for 12 hours; without a network the installed versions are still listed.
 */

export type ToolId = "node" | "npm" | "pnpm" | "yarn" | "bun" | "deno" | "git" | "gh" | "docker" | "python" | "go" | "java" | "rust";

/** How a tool got onto this computer, read from where its command lives. */
export type Installer =
  | "nvm"
  | "nvm-windows"
  | "fnm"
  | "volta"
  | "asdf"
  | "mise"
  | "pyenv"
  | "rustup"
  | "brew"
  | "scoop"
  | "choco"
  | "winget"
  | "npm-global"
  | "corepack"
  | "self"
  | "system"
  | "unknown";

export type ToolStatus = "ok" | "update" | "ending" | "unsupported" | "unknown" | "missing";

export interface ToolInfo {
  id: ToolId;
  name: string;
  installed: boolean;
  version?: string;
  path?: string;
  via?: Installer;
  /** The newest release (of the same line, for Node, Python and Go). */
  latest?: string;
  /** For Node, Python and Go: the line to move to when this one's support ends. */
  newestLine?: string;
  /** When this version's line stops getting security fixes (YYYY-MM-DD). */
  supportEnds?: string;
  status: ToolStatus;
  /** One line a person reads: "24.22.2 is out", "Node 18 stopped getting security fixes on 30 Apr 2025". */
  detail: string;
  /** The command that updates it, when there is one. Run in a terminal the user can see. */
  fix?: string;
  /** False when `fix` is advice to follow, not a command. */
  runnable?: boolean;
}

interface ToolDef {
  id: ToolId;
  name: string;
  commands: string[];
  args: string[];
}

const TOOLS: ToolDef[] = [
  { id: "node", name: "Node.js", commands: ["node"], args: ["--version"] },
  { id: "npm", name: "npm", commands: ["npm"], args: ["--version"] },
  { id: "pnpm", name: "pnpm", commands: ["pnpm"], args: ["--version"] },
  { id: "yarn", name: "Yarn", commands: ["yarn"], args: ["--version"] },
  { id: "bun", name: "Bun", commands: ["bun"], args: ["--version"] },
  { id: "deno", name: "Deno", commands: ["deno"], args: ["--version"] },
  { id: "git", name: "Git", commands: ["git"], args: ["--version"] },
  { id: "gh", name: "GitHub CLI", commands: ["gh"], args: ["--version"] },
  { id: "docker", name: "Docker", commands: ["docker"], args: ["--version"] },
  // The Microsoft Store's python.exe stub prints no version, so the py launcher is tried next.
  { id: "python", name: "Python", commands: process.platform === "win32" ? ["python", "py"] : ["python3", "python"], args: ["--version"] },
  { id: "go", name: "Go", commands: ["go"], args: ["version"] },
  { id: "java", name: "Java", commands: ["java"], args: ["-version"] },
  { id: "rust", name: "Rust", commands: ["rustc"], args: ["--version"] },
];

export const TOOL_IDS: ToolId[] = TOOLS.map((t) => t.id);
export function toolName(id: ToolId): string {
  return TOOLS.find((t) => t.id === id)?.name ?? id;
}

export interface Installed {
  id: ToolId;
  version?: string;
  path?: string;
  via?: Installer;
}

export type Runner = (command: string, args: string[]) => Promise<string>;

/** Runs a command we chose (never one from a request), its stdout and stderr together. */
export const defaultRunner: Runner = (command, args) =>
  new Promise((resolve) => {
    // .cmd shims (npm, pnpm, yarn) only run through cmd.exe on Windows.
    const [file, list] = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", [command, ...args].join(" ")]] : [command, args];
    execFile(file, list, { windowsHide: true, timeout: 8000, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve("");
      resolve(`${stdout ?? ""}\n${stderr ?? ""}`);
    });
  });

const whereRunner: Runner = (command) =>
  new Promise((resolve) => {
    execFile(process.platform === "win32" ? "where" : "which", [command], { windowsHide: true, timeout: 5000, encoding: "utf8" }, (err, stdout) => resolve(err ? "" : stdout));
  });

/** Which tools are installed and their versions. Each is asked in parallel; nothing is installed. */
export async function findInstalledTools(run: Runner = defaultRunner, where: Runner = whereRunner): Promise<Installed[]> {
  return Promise.all(
    TOOLS.map(async (t) => {
      for (const command of t.commands) {
        const out = await run(command, t.args);
        if (/not recognized|not found|no such file|was not found/i.test(out) && !parseVersion(out.replace(/was not found.*/is, ""))) continue;
        const version = parseVersion(out);
        if (!version) continue;
        const found = (await where(command, [])).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        // On Windows `where npm` lists the extensionless shell script first; the .cmd is what runs.
        const file = found.find((f) => /\.(exe|cmd|bat)$/i.test(f)) ?? found[0];
        return { id: t.id, version: windowsGitVersion(t.id, out) ?? version, path: file, via: file ? installerOf(t.id, file) : undefined };
      }
      return { id: t.id };
    }),
  );
}

/** Git for Windows numbers its builds 2.49.0.windows.1: keep the build, newer ones fix security issues too. */
function windowsGitVersion(id: ToolId, out: string): string | undefined {
  if (id !== "git") return undefined;
  const m = /(\d+\.\d+\.\d+)\.windows\.(\d+)/.exec(out);
  return m ? `${m[1]}.windows.${m[2]}` : undefined;
}

/** What installed a tool, from its path. Unknown is fine: the update is then a link, not a command. */
export function installerOf(id: ToolId, file: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): Installer {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    // keep the path as found
  }
  const p = `${file}|${real}`.replace(/\\/g, "/").toLowerCase();
  if (/\/\.nvm\//.test(p)) return "nvm";
  if (env.NVM_HOME && id === "node" && platform === "win32") return "nvm-windows";
  if (/fnm/.test(p)) return "fnm";
  if (/\/\.?volta\//.test(p)) return "volta";
  if (/\/\.asdf\//.test(p)) return "asdf";
  if (/\/mise\//.test(p)) return "mise";
  if (/\/\.pyenv\/|pyenv-win/.test(p)) return "pyenv";
  if (/\/\.cargo\/|rustup/.test(p)) return "rustup";
  if (/\/corepack\//.test(p)) return "corepack";
  if (/\/node_modules\/(pnpm|yarn|bun|npm)\//.test(p) || /\/appdata\/roaming\/npm\//.test(p)) return id === "npm" && /program files\/nodejs/.test(p) ? "system" : "npm-global";
  if (/\/scoop\//.test(p)) return "scoop";
  if (/chocolatey/.test(p)) return "choco";
  if (/homebrew|\/cellar\/|\/linuxbrew\//.test(p)) return "brew";
  if (/\/\.bun\/|\/\.deno\/|\/appdata\/local\/pnpm\/|\/\.local\/share\/pnpm\//.test(p)) return "self";
  if (platform === "win32") {
    // Node puts its own npm, and corepack's shims, next to node.exe.
    if (/program files\/nodejs\//.test(p)) return id === "npm" ? "system" : id === "node" ? "winget" : "corepack";
    if (/program files|windowsapps|appdata\/local\/programs|appdata\/local\/microsoft\/winget|^[a-z]:\/python\d+\//.test(p)) return "winget";
  }
  if (platform === "linux" && /^\/usr\/(s?bin|lib)\//.test(real.replace(/\\/g, "/"))) return "system";
  return "unknown";
}

// ---------------------------------------------------------------- latest versions

interface Cycle {
  cycle: string;
  releaseDate?: string;
  eol: string | boolean;
  latest: string;
  lts?: string | boolean;
}

export interface LatestData {
  at: number;
  cycles: Partial<Record<"nodejs" | "python" | "go", Cycle[]>>;
  /** Latest versions by npm package name. */
  npm: Record<string, string>;
  /** Latest release tags by GitHub repository. */
  github: Record<string, string>;
}

const LATEST_TTL_MS = 12 * 3600_000;
const NPM_PACKAGES = ["npm", "pnpm", "yarn", "@yarnpkg/cli-dist", "bun"];
const GITHUB_REPOS = ["cli/cli", "denoland/deno", "git-for-windows/git"];

/** Latest versions, from the 12-hour cache or the network. A source that doesn't answer is left out. */
export async function latestVersions(options: { refresh?: boolean; fetcher?: typeof fetch } = {}): Promise<LatestData> {
  const file = dxPath("cache", "latest-versions.json");
  if (!options.refresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8")) as LatestData;
      if (Date.now() - cached.at < LATEST_TTL_MS) return cached;
    } catch {
      // none yet
    }
  }
  const get = options.fetcher ?? fetch;
  const json = async (url: string) => {
    try {
      const res = await get(url, { headers: { "User-Agent": "dx-devkit", Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
      return res.ok ? ((await res.json()) as unknown) : undefined;
    } catch {
      return undefined;
    }
  };
  const data: LatestData = { at: Date.now(), cycles: {}, npm: {}, github: {} };
  await Promise.all([
    ...(["nodejs", "python", "go"] as const).map(async (product) => {
      const list = await json(`https://endoflife.date/api/${product}.json`);
      if (Array.isArray(list)) data.cycles[product] = list as Cycle[];
    }),
    ...NPM_PACKAGES.map(async (name) => {
      const r = (await json(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`)) as { version?: string } | undefined;
      if (r?.version) data.npm[name] = r.version;
    }),
    ...GITHUB_REPOS.map(async (repo) => {
      const r = (await json(`https://api.github.com/repos/${repo}/releases/latest`)) as { tag_name?: string } | undefined;
      if (r?.tag_name) data.github[repo] = r.tag_name.replace(/^v/, "");
    }),
  ]);
  const answered = Object.keys(data.cycles).length + Object.keys(data.npm).length + Object.keys(data.github).length;
  if (answered > 0) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    } catch {
      // checked again next time
    }
  }
  return data;
}

// ---------------------------------------------------------------- the check

export interface ToolCheckOptions {
  refresh?: boolean;
  /** Skip the network: installed versions only. */
  offline?: boolean;
  installed?: Installed[];
  latest?: LatestData;
  now?: number;
  platform?: NodeJS.Platform;
}

let installedCache: { at: number; list: Installed[] } | undefined;

/** Installed tools, asked again after 30 seconds (the Machine page asks several times). */
export async function installedTools(refresh = false): Promise<Installed[]> {
  if (!refresh && installedCache && Date.now() - installedCache.at < 30_000) return installedCache.list;
  const list = await findInstalledTools();
  installedCache = { at: Date.now(), list };
  return list;
}

export async function checkTools(options: ToolCheckOptions = {}): Promise<ToolInfo[]> {
  const [installed, latest] = await Promise.all([
    options.installed ?? installedTools(options.refresh),
    options.latest ?? (options.offline ? Promise.resolve<LatestData>({ at: 0, cycles: {}, npm: {}, github: {} }) : latestVersions({ refresh: options.refresh })),
  ]);
  const now = options.now ?? Date.now();
  const platform = options.platform ?? process.platform;
  return installed.map((t) => judge(t, latest, now, platform));
}

const DAY = 86_400_000;

function judge(t: Installed, latest: LatestData, now: number, platform: NodeJS.Platform): ToolInfo {
  const name = toolName(t.id);
  const base: ToolInfo = { id: t.id, name, installed: Boolean(t.version), version: t.version, path: t.path, via: t.via, status: "unknown", detail: "" };
  if (!t.version) return { ...base, status: "missing", detail: "not installed" };
  const v = t.version;

  const product = t.id === "node" ? "nodejs" : t.id === "python" ? "python" : t.id === "go" ? "go" : undefined;
  if (product) {
    const cycles = latest.cycles[product];
    if (!cycles?.length) return { ...base, detail: "couldn't check for updates" };
    const key = product === "nodejs" ? String(majorOf(v)) : toVersion(v).slice(0, 2).join(".");
    const cycle = cycles.find((c) => c.cycle === key);
    const supported = cycles.filter((c) => !isPast(c.eol, now) && (!c.releaseDate || Date.parse(c.releaseDate) <= now));
    // For Node the line to be on is the newest LTS; for Python and Go, the newest release.
    const newest = (product === "nodejs" ? supported.filter((c) => typeof c.lts === "string" && Date.parse(c.lts) <= now) : supported)
      .sort((a, b) => compareVersions(b.cycle, a.cycle))[0];
    const label = `${name.replace(".js", "")} ${key}`;
    const info: ToolInfo = { ...base, latest: cycle?.latest, newestLine: newest?.cycle, supportEnds: typeof cycle?.eol === "string" ? cycle.eol : undefined };
    if (!cycle) return { ...info, detail: `${label} isn't in the release list` };
    if (isPast(cycle.eol, now)) {
      const fix = updateCommand(t.id, t.via, platform, newest?.cycle, v);
      return {
        ...info,
        status: "unsupported",
        detail: `${label} stopped getting security fixes${typeof cycle.eol === "string" ? ` on ${formatDay(cycle.eol)}` : ""}${newest ? `. Move to ${newest.cycle}` : ""}`,
        ...fix,
      };
    }
    if (typeof cycle.eol === "string" && Date.parse(cycle.eol) - now < 120 * DAY) {
      return { ...info, status: "ending", detail: `${label} stops getting security fixes on ${formatDay(cycle.eol)}${newest && newest.cycle !== key ? `. Move to ${newest.cycle}` : ""}`, ...updateCommand(t.id, t.via, platform, newest?.cycle, v) };
    }
    if (compareVersions(v, cycle.latest) < 0) return { ...info, status: "update", detail: `${cycle.latest} is out`, ...updateCommand(t.id, t.via, platform, undefined, v) };
    const newer = newest && compareVersions(newest.cycle, key) > 0 ? `; ${newest.cycle} is the newest${product === "nodejs" ? " LTS" : ""}` : "";
    return { ...info, status: "ok", detail: `up to date${newer}` };
  }

  const newest = latestFor(t.id, v, latest, platform);
  if (!newest) return { ...base, detail: t.id === "docker" ? "Docker Desktop checks for its own updates" : t.id === "java" || t.id === "rust" ? "" : "couldn't check for updates" };
  if (compareGitAware(v, newest) < 0) {
    const behind = majorOf(newest) > majorOf(v) ? ` (a new major version: read its changes first)` : "";
    return { ...base, latest: newest, status: "update", detail: `${newest} is out${behind}`, ...updateCommand(t.id, t.via, platform, undefined, v) };
  }
  return { ...base, latest: newest, status: "ok", detail: "up to date" };
}

function latestFor(id: ToolId, v: string, latest: LatestData, platform: NodeJS.Platform): string | undefined {
  switch (id) {
    case "npm":
    case "pnpm":
    case "bun":
      return latest.npm[id];
    case "yarn":
      // Yarn 1 and Yarn 2+ are different packages.
      return majorOf(v) >= 2 ? latest.npm["@yarnpkg/cli-dist"] : latest.npm.yarn;
    case "gh":
      return latest.github["cli/cli"];
    case "deno":
      return latest.github["denoland/deno"];
    case "git":
      return platform === "win32" && v.includes("windows") ? latest.github["git-for-windows/git"] : undefined;
    default:
      return undefined;
  }
}

/** 2.49.0.windows.1 < 2.49.0.windows.2 < 2.50.0.windows.1. */
function compareGitAware(a: string, b: string): number {
  const base = compareVersions(a, b);
  if (base !== 0) return base;
  const wa = Number(/windows\.(\d+)/.exec(a)?.[1] ?? 0);
  const wb = Number(/windows\.(\d+)/.exec(b)?.[1] ?? 0);
  return wa - wb;
}

/** Node lines with long-term support that still get security fixes, newest first. */
export function supportedNodeLines(latest?: LatestData, now = Date.now()): string[] | undefined {
  const cycles = latest?.cycles.nodejs;
  if (!cycles?.length) return undefined;
  return cycles
    .filter((c) => !isPast(c.eol, now) && typeof c.lts === "string" && Date.parse(c.lts) <= now)
    .map((c) => c.cycle)
    .sort((a, b) => Number(b) - Number(a));
}

function isPast(eol: string | boolean, now: number): boolean {
  return eol === true || (typeof eol === "string" && Date.parse(eol) <= now);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ---------------------------------------------------------------- commands

const LINUX = (pkg: string) => `sudo apt install --only-upgrade -y ${pkg}`;

/**
 * The command that updates a tool the way it was installed. `line` moves Node, Python or Go to
 * another line (a version that's no longer supported). Never run by dx itself: the dashboard
 * opens it in a terminal the user can see, where installers can ask for a password.
 */
export function updateCommand(
  id: ToolId,
  via: Installer | undefined,
  platform: NodeJS.Platform = process.platform,
  line?: string,
  version?: string,
): { fix?: string; runnable?: boolean } {
  const cmd = (fix: string) => ({ fix, runnable: true });
  const advice = (fix: string) => ({ fix, runnable: false });
  const win = platform === "win32";
  const mac = platform === "darwin";
  switch (id) {
    case "node": {
      const target = line ?? "lts";
      if (via === "nvm-windows") return cmd(`nvm install ${target} && nvm use ${target}`);
      if (via === "nvm") return cmd(line ? `nvm install ${line}` : "nvm install --lts");
      if (via === "fnm") return cmd(line ? `fnm install ${line} && fnm default ${line}` : "fnm install --lts");
      if (via === "volta") return cmd(`volta install node@${line ?? "lts"}`);
      if (via === "mise") return cmd(`mise use -g node@${line ?? "lts"}`);
      if (via === "asdf") return cmd(`asdf install nodejs latest${line ? `:${line}` : ""}`);
      if (via === "scoop") return cmd("scoop update nodejs-lts");
      if (via === "choco") return cmd("choco upgrade nodejs-lts -y");
      if (via === "brew") return cmd(line ? `brew install node@${line}` : "brew upgrade node");
      if (win && via === "winget") return cmd(line ? "winget install --id OpenJS.NodeJS.LTS" : 'winget upgrade --name "Node.js"');
      if (via === "system" && platform === "linux") return cmd(LINUX("nodejs"));
      return advice("Download it from https://nodejs.org/en/download");
    }
    case "npm":
      return cmd("npm install -g npm@latest");
    case "pnpm":
      if (via === "corepack") return cmd("corepack install -g pnpm@latest");
      if (via === "npm-global") return cmd("npm install -g pnpm@latest");
      if (via === "brew") return cmd("brew upgrade pnpm");
      if (via === "scoop") return cmd("scoop update pnpm");
      if (win && via === "winget") return cmd("winget upgrade --id pnpm.pnpm");
      return cmd("pnpm self-update");
    case "yarn":
      if (via === "corepack") return cmd("corepack install -g yarn@stable");
      if (via === "brew") return cmd("brew upgrade yarn");
      return cmd("npm install -g yarn@latest");
    case "bun":
      if (via === "npm-global") return cmd("npm install -g bun@latest");
      if (via === "brew") return cmd("brew upgrade bun");
      return cmd("bun upgrade");
    case "deno":
      if (via === "brew") return cmd("brew upgrade deno");
      return cmd("deno upgrade");
    case "git":
      if (win) return cmd(via === "winget" || via === "unknown" ? "git update-git-for-windows" : via === "scoop" ? "scoop update git" : via === "choco" ? "choco upgrade git -y" : "git update-git-for-windows");
      if (mac) return via === "brew" ? cmd("brew upgrade git") : advice("Install the newest with Homebrew: brew install git");
      return cmd(LINUX("git"));
    case "gh":
      if (win) return cmd(via === "scoop" ? "scoop update gh" : "winget upgrade --id GitHub.cli");
      if (mac || via === "brew") return cmd("brew upgrade gh");
      return cmd(LINUX("gh"));
    case "python": {
      if (via === "pyenv") return cmd(`pyenv install ${line ?? "3"}`);
      if (via === "brew") return cmd(line ? `brew install python@${line}` : "brew upgrade python");
      // winget has one package per Python line: Python.Python.3.13.
      const own = version ? toVersion(version).slice(0, 2).join(".") : undefined;
      if (win && (line || own)) return cmd(`winget ${line ? "install" : "upgrade"} --id Python.Python.${line ?? own}`);
      return advice("Update it with your system's package manager, or install a newer one with uv: uv python install");
    }
    case "go":
      if (via === "brew") return cmd("brew upgrade go");
      if (win) return cmd("winget upgrade --id GoLang.Go");
      return advice("Download the newest from https://go.dev/dl/");
    case "rust":
      return cmd("rustup update");
    case "docker":
      return advice("Open Docker Desktop and choose Check for updates");
    default:
      return {};
  }
}

/** The command that installs a tool a project needs, when it's missing. */
export function installCommand(id: ToolId, platform: NodeJS.Platform = process.platform, nodeMajor?: number): { fix?: string; runnable?: boolean } {
  const cmd = (fix: string) => ({ fix, runnable: true });
  const advice = (fix: string) => ({ fix, runnable: false });
  const win = platform === "win32";
  const mac = platform === "darwin";
  switch (id) {
    case "node":
      return win ? cmd("winget install --id OpenJS.NodeJS.LTS") : mac ? cmd("brew install node") : advice("Install Node with fnm: curl -fsSL https://fnm.vercel.app/install | bash, then fnm install --lts");
    case "pnpm":
    case "yarn":
      // corepack came with Node until 25; after that the package managers install from npm.
      return nodeMajor !== undefined && nodeMajor < 25 ? cmd("corepack enable") : cmd(`npm install -g ${id}`);
    case "bun":
      return win ? cmd("winget install --id Oven-sh.Bun") : mac ? cmd("brew install oven-sh/bun/bun") : cmd("npm install -g bun");
    case "deno":
      return win ? cmd("winget install --id DenoLand.Deno") : mac ? cmd("brew install deno") : advice("See https://docs.deno.com/runtime/getting_started/installation/");
    case "python":
      return win ? cmd("winget install --id Python.Python.3.13") : mac ? cmd("brew install python") : cmd("sudo apt install -y python3 python3-venv");
    case "go":
      return win ? cmd("winget install --id GoLang.Go") : mac ? cmd("brew install go") : advice("Download it from https://go.dev/dl/");
    case "java":
      return win ? cmd("winget install --id EclipseAdoptium.Temurin.21.JDK") : mac ? cmd("brew install --cask temurin") : cmd("sudo apt install -y default-jdk");
    case "rust":
      return win ? cmd("winget install --id Rustlang.Rustup") : advice("Install rustup from https://rustup.rs");
    case "docker":
      return win ? cmd("winget install --id Docker.DockerDesktop") : mac ? cmd("brew install --cask docker") : advice("Install Docker from https://docs.docker.com/engine/install/");
    case "git":
      return win ? cmd("winget install --id Git.Git") : mac ? cmd("brew install git") : cmd("sudo apt install -y git");
    case "gh":
      return win ? cmd("winget install --id GitHub.cli") : mac ? cmd("brew install gh") : cmd("sudo apt install -y gh");
    case "npm":
      return cmd("npm install -g npm@latest");
    default:
      return {};
  }
}
