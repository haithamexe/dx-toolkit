import fs from "node:fs";
import path from "node:path";
import { stripBom } from "../config.js";
import type { Project } from "./projects.js";
import { installCommand, toolName, type Installed, type Installer, type ToolId } from "./machine.js";
import { majorOf, NODE_LTS_CODENAMES, newestSatisfying, satisfies, toVersion } from "./versions.js";

/**
 * What each project needs from this computer, read from its own files (.nvmrc, engines,
 * packageManager, lock files, .python-version, go.mod, compose files…), next to what's
 * installed. "shop-website wants Node 20 (.nvmrc), you have 24."
 */

export interface Need {
  tool: ToolId;
  /** The version or range the project asks for; undefined when any version will do. */
  wants?: string;
  /** Where it says so: ".nvmrc", "package.json engines", "pnpm-lock.yaml". */
  source: string;
}

export interface NeedCheck extends Need {
  installed?: string;
  ok: boolean;
  problem?: "missing" | "version";
  /** "Node 20", "pnpm", "Go 1.22 or newer": what the project needs, in words. */
  label: string;
  /** The command that fixes it, run in the project's folder. */
  fix?: string;
  runnable?: boolean;
}

export interface ProjectNeeds {
  project: string;
  dir: string;
  needs: NeedCheck[];
  problems: number;
}

/** What one project asks for. Only its own files are read; nothing runs. */
export function readNeeds(dir: string): Need[] {
  const needs: Need[] = [];
  const add = (n: Need) => {
    // The first source to name a tool wins: .nvmrc is more specific than engines, engines than a lock file.
    if (!needs.some((x) => x.tool === n.tool)) needs.push(n);
  };
  const read = (name: string) => {
    try {
      return stripBom(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      return undefined;
    }
  };
  const exists = (name: string) => fs.existsSync(path.join(dir, name));
  const firstLine = (text?: string) =>
    text
      ?.split(/\r?\n/)
      .map((l) => l.replace(/#.*/, "").trim())
      .find(Boolean)
      ?.replace(/^v(?=\d)/, "");

  // Version-manager files first: they say exactly what to run.
  const nvmrc = firstLine(read(".nvmrc"));
  if (nvmrc) add({ tool: "node", wants: nvmrc, source: ".nvmrc" });
  const nodeVersion = firstLine(read(".node-version"));
  if (nodeVersion) add({ tool: "node", wants: nodeVersion, source: ".node-version" });
  const toolVersions = read(".tool-versions");
  if (toolVersions) {
    const names: Record<string, ToolId> = { nodejs: "node", node: "node", python: "python", golang: "go", go: "go", java: "java", rust: "rust", pnpm: "pnpm", yarn: "yarn", bun: "bun", deno: "deno" };
    for (const line of toolVersions.split(/\r?\n/)) {
      const [name, version] = line.replace(/#.*/, "").trim().split(/\s+/);
      const tool = names[name?.toLowerCase() ?? ""];
      if (tool && version) add({ tool, wants: tool === "java" ? version.replace(/^\D+-/, "").split("-")[0] : version, source: ".tool-versions" });
    }
  }
  const pythonVersion = firstLine(read(".python-version"));
  if (pythonVersion && /^\d/.test(pythonVersion)) add({ tool: "python", wants: pythonVersion, source: ".python-version" });

  const pkgText = read("package.json");
  if (pkgText) {
    let pkg: { engines?: Record<string, string>; volta?: Record<string, string>; packageManager?: string } = {};
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      // a broken package.json: the lock files still say something
    }
    if (pkg.volta?.node) add({ tool: "node", wants: pkg.volta.node, source: "package.json volta" });
    if (typeof pkg.engines?.node === "string") add({ tool: "node", wants: pkg.engines.node, source: "package.json engines" });
    const pm = typeof pkg.packageManager === "string" ? /^(npm|pnpm|yarn|bun)@(\d[\w.-]*)/.exec(pkg.packageManager) : null;
    if (pm) add({ tool: pm[1] as ToolId, wants: `^${majorOf(pm[2])}`, source: "package.json packageManager" });
    for (const tool of ["pnpm", "yarn", "npm", "bun"] as const) {
      if (typeof pkg.engines?.[tool] === "string") add({ tool, wants: pkg.engines[tool], source: "package.json engines" });
    }
    if (exists("pnpm-lock.yaml")) add({ tool: "pnpm", source: "pnpm-lock.yaml" });
    else if (exists("yarn.lock")) add({ tool: "yarn", source: "yarn.lock" });
    else if (exists("bun.lockb") || exists("bun.lock")) add({ tool: "bun", source: exists("bun.lock") ? "bun.lock" : "bun.lockb" });
    add({ tool: "node", source: "package.json" });
  }

  const pyproject = read("pyproject.toml");
  const requiresPython = pyproject && /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1];
  if (requiresPython) add({ tool: "python", wants: requiresPython.replace(/,/g, " "), source: "pyproject.toml" });
  const runtimeTxt = firstLine(read("runtime.txt"));
  if (runtimeTxt && /^python-\d/.test(runtimeTxt)) add({ tool: "python", wants: runtimeTxt.slice(7), source: "runtime.txt" });
  for (const marker of ["pyproject.toml", "requirements.txt", "Pipfile", "manage.py"]) {
    if (exists(marker)) add({ tool: "python", source: marker });
  }

  const goMod = read("go.mod");
  if (goMod) {
    // The go line is a minimum (Go 1.21 and newer download a newer toolchain themselves).
    const go = /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(goMod)?.[1];
    add({ tool: "go", wants: go ? `>=${go}` : undefined, source: "go.mod" });
  }
  if (exists("Cargo.toml")) add({ tool: "rust", source: "Cargo.toml" });
  for (const marker of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
    if (exists(marker)) add({ tool: "java", source: marker });
  }
  for (const marker of ["deno.json", "deno.jsonc"]) {
    if (exists(marker)) add({ tool: "deno", source: marker });
  }
  for (const marker of ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]) {
    if (exists(marker)) add({ tool: "docker", source: marker });
  }
  return needs;
}

/** What `wants` means in words: "Node 20", "Node 18 to 20", "Go 1.22 or newer". */
export function needLabel(n: Need): string {
  const name = toolName(n.tool).replace(".js", "");
  if (!n.wants) return name;
  const w = n.wants.trim();
  const lts = /^lts\/(\w+)$/i.exec(w);
  if (lts) return lts[1] === "*" || lts[1] === "-1" ? `${name} LTS` : `${name} ${NODE_LTS_CODENAMES[lts[1].toLowerCase()] ?? lts[1]}`;
  if (/^(node|latest|current|stable|\*)$/i.test(w)) return name;
  const atLeast = /^>=\s*v?([\d.]+)$/.exec(w);
  if (atLeast) return `${name} ${atLeast[1].replace(/\.0(\.0)?$/, "")} or newer`;
  const caret = /^\^v?(\d+)(?:\.\d+)*$/.exec(w);
  if (caret) return `${name} ${caret[1]}`;
  if (/^v?\d+(\.\d+){0,2}$/.test(w)) return `${name} ${w.replace(/^v/, "")}`;
  return `${name} ${w}`;
}

export interface NeedOptions {
  platform?: NodeJS.Platform;
  /** Node lines that exist (from endoflife.date), newest first, to pick the one to switch to. */
  nodeLines?: string[];
}

/** Each project's needs next to what's installed. Projects with problems come first. */
export function checkProjectNeeds(projects: Project[], installed: Installed[], options: NeedOptions = {}): ProjectNeeds[] {
  const byId = new Map(installed.map((t) => [t.id, t]));
  const out = projects.map((p) => {
    const needs = readNeeds(p.dir).map((n) => checkNeed(n, byId, options));
    return { project: p.name, dir: p.dir, needs, problems: needs.filter((n) => !n.ok).length };
  });
  return out.sort((a, b) => b.problems - a.problems || a.project.localeCompare(b.project));
}

function checkNeed(n: Need, installed: Map<ToolId, Installed>, options: NeedOptions): NeedCheck {
  const platform = options.platform ?? process.platform;
  const t = installed.get(n.tool);
  const label = needLabel(n);
  const node = installed.get("node");
  if (!t?.version) {
    return { ...n, label, ok: false, problem: "missing", ...installCommand(n.tool, platform, node?.version ? majorOf(node.version) : undefined) };
  }
  const meets = n.wants ? meetsVersion(t.version, n.wants, n.source) : true;
  if (meets !== false) return { ...n, label, installed: t.version, ok: true };
  return { ...n, label, installed: t.version, ok: false, problem: "version", ...switchCommand(n, t.via, platform, options.nodeLines) };
}

/**
 * Exact versions in .nvmrc, .node-version and .python-version are read as their line (20.11.0 → any
 * 20; 3.12.1 → any 3.12): a different patch release isn't worth a warning.
 */
function meetsVersion(installed: string, wants: string, source: string): boolean | undefined {
  const exact = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(wants.trim());
  if (exact && /nvmrc|node-version|tool-versions|volta/.test(source)) return majorOf(installed) === Number(exact[1]);
  if (exact && /python-version|runtime\.txt/.test(source)) return toVersion(installed).slice(0, 2).join(".") === `${exact[1]}.${exact[2]}`;
  return satisfies(installed, wants);
}

/** Switching to the version a project asks for, with the version manager the tool came from. */
function switchCommand(n: Need, via: Installer | undefined, platform: NodeJS.Platform, nodeLines?: string[]): { fix?: string; runnable?: boolean } {
  const cmd = (fix: string) => ({ fix, runnable: true });
  const advice = (fix: string) => ({ fix, runnable: false });
  if (n.tool === "node") {
    const target = nodeTarget(n.wants ?? "", nodeLines);
    if (!target) return advice(`Install ${needLabel(n)} from https://nodejs.org/en/download`);
    const fromFile = n.source === ".nvmrc" || n.source === ".node-version";
    if (via === "nvm-windows") return cmd(`nvm install ${target} && nvm use ${target}`);
    if (via === "nvm") return cmd(fromFile ? "nvm install && nvm use" : `nvm install ${target} && nvm use ${target}`);
    if (via === "fnm") return cmd(fromFile ? "fnm use --install-if-missing" : `fnm use --install-if-missing ${target}`);
    if (via === "volta") return cmd(`volta pin node@${target}`);
    if (via === "mise") return cmd(`mise use node@${target}`);
    if (via === "asdf") return cmd(`asdf install nodejs latest:${target} && asdf local nodejs latest:${target}`);
    // Without a version manager there's only one Node: suggest one that keeps a Node per project.
    const install = platform === "win32" ? "winget install --id Schniz.fnm" : platform === "darwin" ? "brew install fnm" : "curl -fsSL https://fnm.vercel.app/install | bash";
    return advice(`Install fnm to keep a Node version per project (${install}), then in this folder: fnm use --install-if-missing ${target}`);
  }
  if (n.tool === "python") {
    const target = (n.wants ?? "").replace(/^[^\d]*/, "").split(/[\s,]/)[0];
    if (via === "pyenv") return cmd(n.source === ".python-version" ? "pyenv install --skip-existing" : `pyenv install --skip-existing ${target}`);
    if (platform === "win32" && /^\d+\.\d+/.test(target)) return cmd(`winget install --id Python.Python.${target.split(".").slice(0, 2).join(".")}`);
    return advice(`Install Python ${target}, for example with uv: uv python install ${target}`);
  }
  if (n.tool === "pnpm" || n.tool === "yarn") {
    const major = /(\d+)/.exec(n.wants ?? "")?.[1];
    if (n.source === "package.json packageManager") return cmd("corepack enable");
    return cmd(`npm install -g ${n.tool}@${major ?? "latest"}`);
  }
  if (n.tool === "go") return platform === "win32" ? cmd("winget upgrade --id GoLang.Go") : platform === "darwin" ? cmd("brew upgrade go") : advice("Download a newer Go from https://go.dev/dl/");
  if (n.tool === "npm") return cmd(`npm install -g npm@${/(\d+)/.exec(n.wants ?? "")?.[1] ?? "latest"}`);
  return {};
}

/** The Node major line to switch to: the newest that meets the range. */
export function nodeTarget(wants: string, nodeLines?: string[]): string | undefined {
  const w = wants.trim().toLowerCase();
  if (w.startsWith("lts/")) {
    const m = NODE_LTS_CODENAMES[w.slice(4)];
    return m ? String(m) : "lts";
  }
  const exact = /^v?(\d+)(\.\d+){0,2}$/.exec(w);
  if (exact) return exact[1];
  // Without the release list, the even lines: those are the ones that get long-term support.
  const lines = nodeLines?.length ? nodeLines : Array.from({ length: 15 }, (_, i) => String(32 - 2 * i));
  const found = newestSatisfying(
    lines.flatMap((l) => [`${l}.99.99`, `${l}.0.0`]),
    wants,
  );
  return found ? String(majorOf(found)) : undefined;
}
