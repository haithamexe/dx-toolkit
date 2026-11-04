import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dxPath } from "../config.js";
import { isSystemPid, killProcess, listListeningPorts, type KillResult, type PortEntry } from "./ports.js";
import type { Project } from "./projects.js";

/**
 * What runs in the background on this computer that a developer started: dev servers and
 * watchers left behind by a closed terminal, AI tools and editor helpers, Docker containers and
 * the space Docker keeps, and database services that start with the computer.
 */

// ---------------------------------------------------------------- processes

export interface RawProcess {
  pid: number;
  ppid: number;
  name: string;
  command?: string;
  /** ms since epoch */
  startedAt?: number;
  /** bytes */
  memory?: number;
  /** % of the whole computer's CPU, right now */
  cpu?: number;
}

/** Every process (to follow parents), and the developer ones in detail. */
export interface ProcessSnapshot {
  all: Array<{ pid: number; ppid: number; name: string; startedAt?: number }>;
  dev: RawProcess[];
}

export type ProcessKind = "server" | "watcher" | "other" | "tool" | "dx";

export interface DevProcess {
  pid: number;
  name: string;
  command: string;
  /** What it is: "Vite", "Next.js", "Claude Code", "node server.js". */
  label: string;
  kind: ProcessKind;
  startedAt?: number;
  /** bytes, with its child processes */
  memory: number;
  /** %, with its child processes */
  cpu?: number;
  /** Child processes folded into this one. */
  children: number[];
  project?: string;
  dir?: string;
  ports: Array<{ port: number; addresses: string[]; network: boolean }>;
  /** The program that started it, past shells ("claude", "Code", "WindowsTerminal"). */
  startedBy?: string;
  /** The terminal or program that started it is gone. */
  leftBehind: boolean;
  /** A dev server dx runs: stopped from the Projects page instead. */
  runByDx: boolean;
}

// npm, npx, pnpm and yarn are node on Windows, but on Linux and macOS they rename themselves ("npm run dev").
const DEV_NAMES = /^(node|npm|npx|pnpm|yarn|bun|deno|python[\d.]*w?|py|ruby|php[\d.]*|java|dotnet|esbuild|air|uvicorn|gunicorn|flask|celery|rails|puma|nodemon|tsx)$/;

export function isDevProcessName(name: string): boolean {
  return DEV_NAMES.test(path.basename(name).toLowerCase().replace(/\.exe$/, ""));
}

const RULES: Array<[RegExp, ProcessKind, string]> = [
  [/dx-devkit|(^|[\s"/])packages\/(web|cli|mcp)\/dist\/|\/@dx\//, "dx", "dx"],
  [/@anthropic-ai\/claude-code|claude-code|\/claude(\.exe)?["\s]|\/\.claude\//, "tool", "Claude Code"],
  [/modelcontextprotocol|mcp-server|server-mcp|[-/]mcp\b|\bmcp\//, "tool", "MCP server"],
  [/tsserver|typescript-language-server|language-?server|vscode|eslint[-_]?server|copilot|\/cursor\/|windsurf|jetbrains|prettierd/, "tool", "Editor helper"],
  [/\/vite\/bin\/|\bvite(\.js)?(\s|$|")/, "server", "Vite"],
  [/next-server|\/next\/dist\/bin|\bnext\s+(dev|start)\b/, "server", "Next.js"],
  [/\bnuxi?\b/, "server", "Nuxt"],
  [/\/astro\/|\bastro\s+dev\b/, "server", "Astro"],
  [/@remix-run|react-router\s+dev/, "server", "Remix"],
  [/react-scripts/, "server", "Create React App"],
  [/webpack-dev-server|webpack(\.js)?\s+(serve|dev)/, "server", "webpack"],
  [/@angular\/cli|\bng\s+serve\b/, "server", "Angular"],
  [/\/gatsby\//, "server", "Gatsby"],
  [/svelte-kit|@sveltejs/, "server", "SvelteKit"],
  [/\/parcel\//, "server", "Parcel"],
  [/storybook/, "server", "Storybook"],
  [/\/expo\/|@expo\/|metro-/, "server", "Expo"],
  [/wrangler/, "server", "Wrangler"],
  [/firebase.*emulators/, "server", "Firebase emulators"],
  [/@nestjs|\bnest\s+start\b/, "server", "NestJS"],
  [/json-server/, "server", "json-server"],
  [/http-server|live-server/, "server", "Static server"],
  [/uvicorn/, "server", "Uvicorn"],
  [/gunicorn/, "server", "Gunicorn"],
  [/manage\.py["\s]+runserver/, "server", "Django"],
  [/\bflask\b/, "server", "Flask"],
  [/streamlit/, "server", "Streamlit"],
  [/jupyter/, "server", "Jupyter"],
  [/\brails\b|\bpuma\b/, "server", "Rails"],
  [/artisan["\s]+serve|php(\.exe)?["\s]+-s\s/, "server", "PHP server"],
  [/spring-boot/, "server", "Spring Boot"],
  [/nodemon/, "watcher", "nodemon"],
  [/ts-node-dev|\btsx\b.*\bwatch\b/, "watcher", "tsx watch"],
  [/vitest/, "watcher", "Vitest"],
  [/\bjest\b/, "watcher", "Jest"],
  [/\/typescript\/bin\/tsc|\btsc\b.*(-w|--watch)\b/, "watcher", "TypeScript compiler"],
  [/tailwind/, "watcher", "Tailwind"],
  [/\besbuild\b/, "watcher", "esbuild"],
  [/\bturbo\b/, "watcher", "Turborepo"],
  [/\/nx\/|\bnx\s+(daemon|serve|run)\b/, "watcher", "Nx"],
  [/\bcelery\b/, "watcher", "Celery"],
  [/gradle/, "watcher", "Gradle daemon"],
  [/dotnet.*\bwatch\b/, "watcher", "dotnet watch"],
  [/--watch\b/, "watcher", "Watcher"],
];

/** What a process is, from its name and command line. */
export function classifyProcess(name: string, command = ""): { kind: ProcessKind; label: string } {
  const cmd = command.replace(/\\/g, "/").toLowerCase();
  for (const [re, kind, label] of RULES) if (re.test(cmd)) return { kind, label };
  const base = path.basename(name).replace(/\.exe$/i, "");
  // "node server.js", "python app.py": the program and the script it runs.
  const args = command.match(/"[^"]*"|\S+/g)?.slice(1).map((a) => a.replace(/^"|"$/g, "")) ?? [];
  const script = args.find((a) => !a.startsWith("-") && /[./\\]/.test(a));
  if (/npm-cli\.js|\/npm\/bin\//.test(cmd)) return { kind: "other", label: `npm ${args.slice(args.findIndex((a) => /npm-cli/.test(a)) + 1).join(" ")}`.trim() };
  return { kind: "other", label: script ? `${base} ${path.basename(script)}` : base };
}

const KIND_ORDER: ProcessKind[] = ["server", "watcher", "other", "tool", "dx"];

export interface ProcessOptions {
  projects?: Project[];
  ports?: PortEntry[];
  snapshot?: ProcessSnapshot;
  /** dx's own processes: the dashboard and this one. Their children are dx's dev servers. */
  ownerPids?: number[];
}

/** Developer processes, each with the child processes it started folded in. */
export async function listDevProcesses(options: ProcessOptions = {}): Promise<DevProcess[]> {
  const [snapshot, ports] = await Promise.all([
    options.snapshot ?? takeSnapshot(),
    options.ports ?? listListeningPorts().catch(() => [] as PortEntry[]),
  ]);
  return groupProcesses(snapshot, ports, options.projects ?? [], options.ownerPids ?? ownerPids());
}

export function groupProcesses(snapshot: ProcessSnapshot, ports: PortEntry[], projects: Project[], owners: number[]): DevProcess[] {
  const all = new Map(snapshot.all.map((p) => [p.pid, p]));
  const dev = new Map(snapshot.dev.map((p) => [p.pid, p]));
  // A parent must have started before its child; a newer process with that id is someone else.
  const parentOf = (p: { ppid: number; startedAt?: number }) => {
    const parent = all.get(p.ppid);
    if (!parent || p.ppid === 0) return undefined;
    if (parent.startedAt && p.startedAt && parent.startedAt > p.startedAt + 1000) return undefined;
    return parent;
  };
  // npm runs a script through a shell (npm → cmd.exe → node vite): a shell between two developer
  // processes doesn't split them. dx's own processes do: a dev server dx started is its own entry.
  const devParentOf = (p: RawProcess): RawProcess | undefined => {
    const parent = parentOf(p);
    if (!parent || owners.includes(parent.pid)) return undefined;
    const direct = dev.get(parent.pid);
    if (direct) return direct;
    if (!SHELLS.test(parent.name)) return undefined;
    const above = parentOf(parent);
    return above && !owners.includes(above.pid) ? dev.get(above.pid) : undefined;
  };
  const rootOf = (p: RawProcess) => {
    let root = p;
    for (let i = 0; i < 50; i++) {
      const parent = devParentOf(root);
      if (!parent || parent.pid === root.pid) break;
      root = parent;
    }
    return root;
  };
  /** The program that started a group, past shells: "claude", "Code", "WindowsTerminal". */
  const appOf = (p: RawProcess): string | undefined => {
    let up = parentOf(p);
    for (let i = 0; up && i < 10; i++) {
      if (!SHELLS.test(up.name) && !isDevProcessName(up.name) && !/^(conhost|explorer|svchost|services|wininit|launchd|systemd|init|login|sshd|tmux.*|screen)(\.exe)?$/i.test(up.name)) {
        return up.name.replace(/\.exe$/i, "");
      }
      up = parentOf(up);
    }
    return undefined;
  };
  const groups = new Map<number, RawProcess[]>();
  for (const p of snapshot.dev) {
    const root = rootOf(p);
    groups.set(root.pid, [...(groups.get(root.pid) ?? []), p]);
  }
  const portsByPid = new Map<number, PortEntry[]>();
  for (const e of ports) portsByPid.set(e.pid, [...(portsByPid.get(e.pid) ?? []), e]);
  const dirs = projects.map((p) => ({ p, d: `${norm(p.dir)}/` })).sort((a, b) => b.d.length - a.d.length);

  const out: DevProcess[] = [];
  for (const [rootPid, members] of groups) {
    const root = dev.get(rootPid)!;
    const kinds = members.map((m) => ({ m, ...classifyProcess(m.name, m.command) }));
    const own = kinds.find((k) => k.m.pid === rootPid)!;
    // npm run dev → node vite: the group is what the child is.
    const best =
      own.kind !== "other"
        ? own
        : kinds.filter((k) => k.kind !== "other").sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))[0] ?? own;
    const listening = members.flatMap((m) => portsByPid.get(m.pid) ?? []);
    const commands = members.map((m) => norm(m.command ?? ""));
    const project = dirs.find(({ d }) => commands.some((c) => c.includes(d)) || members.some((m) => cwdOf(m.pid)?.startsWith(d)))?.p;
    const parent = parentOf(root);
    const parentName = parent?.name.toLowerCase() ?? "";
    const leftBehind = !parent || root.ppid === 1 || /^(launchd|systemd|init)$/.test(parentName);
    // dx's dev servers: below the dashboard, or below the shell dx started (its pid is the server's).
    let runByDx = false;
    for (let p: { ppid: number; startedAt?: number; pid?: number } | undefined = root, i = 0; p && i < 30; p = parentOf(p), i++) {
      if (owners.includes(p.ppid)) runByDx = true;
    }
    const cpu = members.some((m) => m.cpu !== undefined) ? members.reduce((n, m) => n + (m.cpu ?? 0), 0) : undefined;
    out.push({
      pid: rootPid,
      name: root.name,
      command: root.command ?? "",
      label: best.kind === "dx" ? dxLabel(best.m.command ?? "") : best.label === "MCP server" ? mcpLabel(best.m.command ?? "") : best.label,
      startedBy: appOf(root),
      kind: best.kind === "other" && listening.length ? "server" : best.kind,
      startedAt: root.startedAt,
      memory: members.reduce((n, m) => n + (m.memory ?? 0), 0),
      cpu: cpu === undefined ? undefined : Math.round(cpu * 10) / 10,
      children: members.filter((m) => m.pid !== rootPid).map((m) => m.pid),
      project: project?.name,
      dir: project?.dir,
      ports: listening
        .map((e) => ({ port: e.port, addresses: e.addresses, network: e.addresses.some((a) => !isLoopback(a)) }))
        .filter((e, i, list) => list.findIndex((x) => x.port === e.port) === i)
        .sort((a, b) => a.port - b.port),
      leftBehind: best.kind !== "dx" && best.kind !== "tool" && !runByDx && leftBehind,
      runByDx: runByDx && best.kind !== "dx",
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.leftBehind) - Number(a.leftBehind) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      b.memory - a.memory,
  );
}

const SHELLS = /^(cmd|sh|bash|zsh|dash|fish|pwsh|powershell)(\.exe)?$/i;

function dxLabel(command: string): string {
  const c = command.replace(/\\/g, "/");
  if (/\/web\/dist\/|\/cli\/dist\/index\.js["\s]+ui\b/.test(c)) return "dx dashboard";
  if (/\/mcp\/dist\//.test(c)) return "dx MCP server";
  return "dx";
}

/** "MCP server: server-pdf" from `npx -y @modelcontextprotocol/server-pdf`. */
function mcpLabel(command: string): string {
  const tokens = (command.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, "").replace(/\\/g, "/"));
  const pkg = tokens.find((t) => /^(@[\w.-]+\/)?[\w.-]*(mcp|server-)[\w.-]*$/i.test(t) && !/npx|npm/.test(t));
  if (pkg) return `MCP server: ${pkg.replace(/^@modelcontextprotocol\//, "")}`;
  const file = tokens.find((t) => /mcp/i.test(t) && /\//.test(t));
  const parts = file?.split("/").filter((p) => p && !/^(dist|build|src|lib|bin|index\.[cm]?js|node_modules)$/i.test(p)) ?? [];
  const named = [...parts].reverse().find((p) => /mcp/i.test(p));
  return named ? `MCP server: ${named.replace(/\.[cm]?js$/, "")}` : "MCP server";
}

export function isLoopback(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  return a === "::1" || a === "localhost" || a.startsWith("127.") || a === "::ffff:127.0.0.1";
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function cwdOf(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return `${norm(fs.readlinkSync(`/proc/${pid}/cwd`))}/`;
  } catch {
    return undefined;
  }
}

/** The running dashboard and this process: dev servers below them are dx's own. */
function ownerPids(): number[] {
  const pids = [process.pid];
  try {
    const info = JSON.parse(fs.readFileSync(dxPath("dashboard.json"), "utf8")) as { pid?: number };
    if (typeof info.pid === "number") pids.push(info.pid);
  } catch {
    // no dashboard running
  }
  return pids;
}

/** Stops a developer process and the child processes folded into it, after finding it again. */
export async function stopDevProcess(pid: number, options: ProcessOptions = {}): Promise<KillResult & { label?: string }> {
  const list = await listDevProcesses(options);
  const p = list.find((x) => x.pid === pid);
  if (!p) return { pid, ok: false, message: "That process isn't running any more, or isn't one dx lists. Refresh the list." };
  if (p.kind === "dx" || pid === process.pid) return { pid, ok: false, message: "That's dx itself. Stop the dashboard with dx ui --stop." };
  if (p.runByDx) return { pid, ok: false, message: `dx runs ${p.project ?? "this server"}: stop it from the Projects page.` };
  if (isSystemPid(pid)) return { pid, ok: false, message: `PID ${pid} belongs to the operating system; dx won't stop it.` };
  if (process.platform !== "win32") {
    // taskkill /T takes the tree on Windows; elsewhere the children go first.
    for (const child of [...p.children].reverse()) await killProcess(child).catch(() => undefined);
  }
  const r = await killProcess(pid);
  return { ...r, label: p.label };
}

export async function takeSnapshot(): Promise<ProcessSnapshot> {
  return process.platform === "win32" ? windowsSnapshot() : unixSnapshot();
}

function exec(file: string, args: string[], timeout = 15_000): Promise<{ stdout: string; stderr: string; failed: boolean; missing: boolean }> {
  return new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", failed: Boolean(err), missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT" }),
    ),
  );
}

function powershell(script: string) {
  const encoded = Buffer.from(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ErrorActionPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString("base64");
  return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], 30_000);
}

/** One CIM query for every process, then the CPU time of the developer ones twice, half a second apart. */
export const WINDOWS_PROCESS_SCRIPT = `
$all = @(Get-CimInstance Win32_Process)
$dev = @($all | Where-Object { ([string]$_.Name).ToLower() -match '^(node|bun|deno|python[0-9.]*w?|py|ruby|php[0-9.]*|java|dotnet|esbuild|air|uvicorn|gunicorn|flask|celery|rails|puma|nodemon|tsx)\\.exe$' })
$ids = @($dev | ForEach-Object { [int]$_.ProcessId })
$t0 = @{}
if ($ids.Count -gt 0) { Get-Process -Id $ids | ForEach-Object { $t0[$_.Id] = $_.TotalProcessorTime.TotalMilliseconds } }
Start-Sleep -Milliseconds 500
$cpu = @{}
if ($ids.Count -gt 0) { Get-Process -Id $ids | ForEach-Object { if ($t0.ContainsKey($_.Id)) { $cpu[$_.Id] = ($_.TotalProcessorTime.TotalMilliseconds - $t0[$_.Id]) / 5 / [Environment]::ProcessorCount } } }
function ms($d) { if ($d) { ([DateTimeOffset]$d).ToUnixTimeMilliseconds() } else { 0 } }
$out = [pscustomobject]@{
  all = @($all | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; n = [string]$_.Name; t = (ms $_.CreationDate) } })
  dev = @($dev | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; cmd = [string]$_.CommandLine; t = (ms $_.CreationDate); mem = [double]$_.WorkingSetSize; cpu = $cpu[[int]$_.ProcessId] } })
}
ConvertTo-Json -InputObject $out -Compress -Depth 4
`;

async function windowsSnapshot(): Promise<ProcessSnapshot> {
  const r = await powershell(WINDOWS_PROCESS_SCRIPT);
  return parseWindowsSnapshot(r.stdout);
}

export function parseWindowsSnapshot(stdout: string): ProcessSnapshot {
  const text = stdout.replace(/^﻿/, "").trim();
  if (!text) return { all: [], dev: [] };
  const data = JSON.parse(text) as { all?: unknown; dev?: unknown };
  const arr = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []) as Array<Record<string, unknown>>;
  return {
    all: arr(data.all).map((r) => ({ pid: Number(r.p), ppid: Number(r.pp), name: String(r.n ?? ""), startedAt: Number(r.t) || undefined })),
    dev: arr(data.dev).map((r) => ({
      pid: Number(r.pid),
      ppid: Number(r.ppid),
      name: String(r.name ?? ""),
      command: typeof r.cmd === "string" && r.cmd ? r.cmd : undefined,
      startedAt: Number(r.t) || undefined,
      memory: Number(r.mem) || 0,
      cpu: typeof r.cpu === "number" ? Math.max(0, r.cpu) : undefined,
    })),
  };
}

async function unixSnapshot(): Promise<ProcessSnapshot> {
  // Two lists, because a name and a command line can both hold spaces: one column per call stays readable.
  const [stats, args] = await Promise.all([exec("ps", ["-axo", "pid=,ppid=,etime=,pcpu=,rss=,comm="]), exec("ps", ["-axo", "pid=,args="])]);
  return parsePs(stats.stdout, args.stdout, Date.now());
}

/**
 * `ps` output as a snapshot. The program's name comes from `comm`, or else from the command
 * line's first word: Node 24 renames its main thread, so on Linux `comm` says "MainThread" for
 * every Node process, and npm sets its title to "npm run dev".
 */
export function parsePs(stats: string, argsOut: string, now: number): ProcessSnapshot {
  const commands = new Map<number, string>();
  for (const line of argsOut.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) commands.set(Number(m[1]), m[2].trim());
  }
  const all: ProcessSnapshot["all"] = [];
  const dev: RawProcess[] = [];
  for (const line of stats.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = commands.get(pid);
    const comm = path.basename(m[6].trim());
    const first = command ? path.basename(command.split(/\s+/)[0]) : "";
    const name = isDevProcessName(comm) || !isDevProcessName(first) ? comm : first;
    const p = { pid, ppid: Number(m[2]), name, startedAt: now - parseElapsed(m[3]) * 1000 };
    all.push(p);
    if (isDevProcessName(name)) dev.push({ ...p, command, cpu: Number(m[4]), memory: Number(m[5]) * 1024 });
  }
  return { all, dev };
}

/** ps's elapsed time, [[dd-]hh:]mm:ss, in seconds. */
export function parseElapsed(text: string): number {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = rest.split(":").map(Number).reverse();
  return Number(days) * 86400 + (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600;
}

// ---------------------------------------------------------------- Docker

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  /** The docker compose project it belongs to. */
  composeProject?: string;
  memory?: string;
  cpu?: string;
}

export interface DockerDisk {
  type: string;
  count: number;
  size: string;
  sizeBytes: number;
  reclaimable: string;
  reclaimableBytes: number;
  /** What `dockerPrune` takes to clean this up; undefined for volumes (they hold data). */
  prune?: DockerPrune;
}

export interface DockerInfo {
  installed: boolean;
  running: boolean;
  containers: Container[];
  disk: DockerDisk[];
  error?: string;
}

export type DockerPrune = "containers" | "images" | "build-cache";
const PRUNE_ARGS: Record<DockerPrune, string[]> = {
  containers: ["container", "prune", "-f"],
  // What `docker system df` counts as reclaimable, so the page frees what it says: images no
  // container uses (a stopped container keeps its image), and all of the build cache.
  images: ["image", "prune", "-a", "-f"],
  "build-cache": ["builder", "prune", "-a", "-f"],
};

type DockerRun = (args: string[]) => Promise<{ stdout: string; stderr: string; failed: boolean; missing: boolean }>;
const docker: DockerRun = (args) => exec("docker", args, 20_000);

export async function dockerInfo(run: DockerRun = docker): Promise<DockerInfo> {
  const ps = await run(["ps", "-a", "--no-trunc", "--format", "{{json .}}"]);
  if (ps.missing) return { installed: false, running: false, containers: [], disk: [] };
  if (ps.failed) {
    const msg = (ps.stderr || ps.stdout).trim();
    const notRunning = /cannot connect|daemon|error during connect|pipe|is the docker daemon running/i.test(msg);
    return { installed: true, running: false, containers: [], disk: [], error: notRunning ? undefined : msg.split("\n")[0] };
  }
  const containers = jsonLines(ps.stdout).map(
    (r): Container => ({
      id: String(r.ID ?? ""),
      name: String(r.Names ?? "").split(",")[0],
      image: String(r.Image ?? ""),
      state: String(r.State ?? "").toLowerCase(),
      status: String(r.Status ?? ""),
      ports: String(r.Ports ?? ""),
      composeProject: /(?:^|,)com\.docker\.compose\.project=([^,]+)/.exec(String(r.Labels ?? ""))?.[1],
    }),
  );
  const [df, stats] = await Promise.all([
    run(["system", "df", "--format", "{{json .}}"]),
    containers.some((c) => c.state === "running") ? run(["stats", "--no-stream", "--format", "{{json .}}"]) : Promise.resolve(undefined),
  ]);
  for (const s of stats ? jsonLines(stats.stdout) : []) {
    const c = containers.find((x) => x.name === s.Name || x.id.startsWith(String(s.ID ?? "-")));
    if (c) {
      c.memory = String(s.MemUsage ?? "").split("/")[0].trim() || undefined;
      c.cpu = String(s.CPUPerc ?? "") || undefined;
    }
  }
  const prunes: Record<string, DockerPrune> = { Containers: "containers", Images: "images", "Build Cache": "build-cache" };
  const disk = jsonLines(df.stdout).map((r): DockerDisk => {
    const type = String(r.Type ?? "");
    const reclaimable = String(r.Reclaimable ?? "0B");
    return {
      type,
      count: Number(r.TotalCount ?? 0),
      size: String(r.Size ?? "0B"),
      sizeBytes: parseSize(String(r.Size ?? "0")),
      reclaimable,
      reclaimableBytes: parseSize(reclaimable),
      prune: prunes[type],
    };
  });
  return { installed: true, running: true, containers, disk };
}

function jsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/** Docker's sizes ("1.234GB", "512MB (40%)", "0B") in bytes; it counts in thousands. */
export function parseSize(text: string): number {
  const m = /([\d.]+)\s*([kKMGT]?i?B)/.exec(text);
  if (!m) return 0;
  const unit = m[2].toUpperCase().replace("I", "");
  const pow = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 }[unit] ?? 0;
  return Math.round(Number(m[1]) * (m[2].includes("i") ? 1024 : 1000) ** pow);
}

/** Stops a running container, found again first: only one docker lists. */
export async function dockerStop(id: string, run: DockerRun = docker): Promise<{ ok: boolean; message: string; name?: string }> {
  const info = await dockerInfo(run);
  const c = info.containers.find((x) => x.id === id);
  if (!c) return { ok: false, message: "That container isn't there any more. Refresh the list." };
  if (c.state !== "running") return { ok: false, message: `${c.name} isn't running.`, name: c.name };
  const r = await run(["stop", "--", c.id]);
  return r.failed ? { ok: false, message: (r.stderr || r.stdout).trim(), name: c.name } : { ok: true, message: `Stopped ${c.name}.`, name: c.name };
}

/** Removes stopped containers, images no container uses, or the build cache. Never volumes. */
export async function dockerPrune(what: DockerPrune, run: DockerRun = docker): Promise<{ ok: boolean; message: string }> {
  const args = PRUNE_ARGS[what];
  if (!args) return { ok: false, message: "Pick stopped containers, unused images or the build cache." };
  const r = await run(args);
  if (r.failed) return { ok: false, message: (r.stderr || r.stdout).trim() || "docker failed" };
  const freed = /Total reclaimed space:\s*(\S+)/i.exec(r.stdout)?.[1];
  return { ok: true, message: freed ? `Freed ${freed}.` : "Nothing to clean up." };
}

// ---------------------------------------------------------------- services

export interface MachineService {
  name: string;
  display: string;
  running: boolean;
  /** Starts with the computer (or at login, for Homebrew). */
  atStartup: boolean;
  memory?: number;
  /** Commands for the user to run: stopping or changing a service needs admin rights. */
  stop: string;
  manual: string;
  note?: string;
}

const SERVICE_NAMES = /^(postgres(ql)?|mysql|mariadb|redis|memurai|mongo(db|d)?|mssql|sql ?server|com\.docker\.service|docker|rabbitmq|elasticsearch|opensearch|couchdb|cassandra|neo4j|influxdb|minio|clickhouse|kafka|zookeeper|memcached)/i;

export async function listServices(): Promise<MachineService[]> {
  if (process.platform === "win32") return windowsServices();
  if (process.platform === "darwin") return brewServices();
  return systemdServices();
}

async function windowsServices(): Promise<MachineService[]> {
  const r = await powershell(`
$s = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -match '${SERVICE_NAMES.source}' })
$out = @($s | ForEach-Object {
  $mem = 0
  if ($_.ProcessId -gt 0) { $p = Get-Process -Id $_.ProcessId; if ($p) { $mem = [double]$p.WorkingSet64 } }
  [pscustomobject]@{ name = [string]$_.Name; display = [string]$_.DisplayName; state = [string]$_.State; start = [string]$_.StartMode; mem = $mem }
})
ConvertTo-Json -InputObject $out -Compress -Depth 3
`);
  return parseWindowsServices(r.stdout);
}

export function parseWindowsServices(stdout: string): MachineService[] {
  const text = stdout.replace(/^﻿/, "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const name = String(r.name ?? "");
    return {
      name,
      display: String(r.display || name),
      running: String(r.state).toLowerCase() === "running",
      atStartup: /^auto/i.test(String(r.start)),
      memory: Number(r.mem) || undefined,
      stop: `Stop-Service -Name "${name}"`,
      manual: `Set-Service -Name "${name}" -StartupType Manual`,
      note: "in PowerShell opened as administrator",
    };
  });
}

async function brewServices(): Promise<MachineService[]> {
  const r = await exec("brew", ["services", "info", "--all", "--json"]);
  if (r.failed) return [];
  try {
    const list = JSON.parse(r.stdout) as Array<{ name: string; running?: boolean; loaded?: boolean; status?: string }>;
    return list
      .filter((s) => SERVICE_NAMES.test(s.name))
      .map((s) => ({
        name: s.name,
        display: s.name,
        running: Boolean(s.running),
        atStartup: Boolean(s.loaded) || s.status === "started",
        stop: `brew services stop ${s.name}`,
        manual: `brew services stop ${s.name}`,
        note: "after it's stopped, start it only when you need it with brew services run",
      }));
  } catch {
    return [];
  }
}

async function systemdServices(): Promise<MachineService[]> {
  const [units, files] = await Promise.all([
    exec("systemctl", ["list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"]),
    exec("systemctl", ["list-unit-files", "--type=service", "--no-legend", "--no-pager"]),
  ]);
  if (units.missing) return [];
  const enabled = new Map<string, string>();
  for (const line of files.stdout.split("\n")) {
    const [unit, state] = line.trim().split(/\s+/);
    if (unit) enabled.set(unit, state);
  }
  const out: MachineService[] = [];
  for (const line of units.stdout.split("\n")) {
    const m = /^(\S+)\.service\s+\S+\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line.trim());
    if (!m || !SERVICE_NAMES.test(m[1])) continue;
    out.push({
      name: m[1],
      display: m[4] || m[1],
      running: m[3] === "running",
      atStartup: enabled.get(`${m[1]}.service`) === "enabled",
      stop: `sudo systemctl stop ${m[1]}`,
      manual: `sudo systemctl disable ${m[1]}`,
    });
  }
  return out;
}
