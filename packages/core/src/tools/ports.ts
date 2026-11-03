import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface PortEntry {
  port: number;
  pid: number;
  /** Every local address this process listens on for the port, e.g. ["0.0.0.0", "::"]. */
  addresses: string[];
  processName?: string;
  commandLine?: string;
  /** True for the OS itself (PID 0 / 4 on Windows, 0 / 1 elsewhere). These are never killed. */
  system: boolean;
}

/** Lists TCP ports that are listening, optionally only one port. Sorted by port. */
export async function listListeningPorts(port?: number): Promise<PortEntry[]> {
  if (port !== undefined) assertPort(port);
  const raw = process.platform === "win32" ? await listWindows(port) : await listUnix(port);
  return mergeEntries(raw);
}

export interface KillResult {
  pid: number;
  ok: boolean;
  message: string;
}

/** Kills a process and its children. Refuses to touch system processes or dx itself. */
export async function killProcess(pid: number): Promise<KillResult> {
  if (!Number.isInteger(pid) || pid <= 0) return { pid, ok: false, message: `Not a valid PID: ${pid}` };
  if (isSystemPid(pid)) return { pid, ok: false, message: `PID ${pid} belongs to the operating system; dx won't kill it.` };
  if (pid === process.pid) return { pid, ok: false, message: "That's dx itself." };

  if (process.platform === "win32") {
    try {
      await run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      return { pid, ok: true, message: `Killed PID ${pid} and its child processes.` };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message: string };
      const detail = (e.stderr || e.stdout || e.message).trim();
      const hint = /denied|access/i.test(detail)
        ? " The process may belong to another user or need admin rights: try again from a terminal opened as administrator."
        : "";
      return { pid, ok: false, message: `Couldn't kill PID ${pid}: ${detail}${hint}` };
    }
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    return { pid, ok: false, message: `Couldn't kill PID ${pid}: ${(err as Error).message}` };
  }
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!isAlive(pid)) return { pid, ok: true, message: `Stopped PID ${pid}.` };
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  await sleep(100);
  return isAlive(pid)
    ? { pid, ok: false, message: `PID ${pid} is still running after SIGKILL.` }
    : { pid, ok: true, message: `Force-killed PID ${pid}.` };
}

/** Kills everything listening on a port. */
export async function killPort(port: number): Promise<{ entries: PortEntry[]; results: KillResult[] }> {
  const entries = await listListeningPorts(port);
  const pids = [...new Set(entries.filter((e) => !e.system).map((e) => e.pid))];
  const results: KillResult[] = [];
  for (const pid of pids) results.push(await killProcess(pid));
  for (const e of entries.filter((x) => x.system)) {
    results.push({ pid: e.pid, ok: false, message: `PID ${e.pid} belongs to the operating system; dx won't kill it.` });
  }
  return { entries, results };
}

export function isSystemPid(pid: number): boolean {
  return process.platform === "win32" ? pid === 0 || pid === 4 : pid === 0 || pid === 1;
}

// ---------------------------------------------------------------- Windows

/**
 * Uses Get-NetTCPConnection rather than parsing `netstat`, because netstat's state column is
 * translated on non-English Windows. Process names and command lines come from one CIM query.
 */
export function windowsPortScript(port?: number): string {
  const filter = port !== undefined ? ` -LocalPort ${port}` : "";
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$conns = @(Get-NetTCPConnection -State Listen${filter})
$ids = @($conns | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
$procs = @{}
if ($ids.Count -gt 0) {
  $f = ($ids | ForEach-Object { "ProcessId=$_" }) -join ' OR '
  Get-CimInstance Win32_Process -Filter $f | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }
}
$list = New-Object System.Collections.Generic.List[object]
foreach ($c in $conns) {
  $p = $procs[[int]$c.OwningProcess]
  $list.Add([pscustomobject]@{
    port = [int]$c.LocalPort
    address = [string]$c.LocalAddress
    pid = [int]$c.OwningProcess
    name = $p.Name
    cmd = $p.CommandLine
  })
}
if ($list.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $list.ToArray() -Compress -Depth 3 }
`;
}

interface RawEntry {
  port: number;
  address: string;
  pid: number;
  name?: string | null;
  cmd?: string | null;
}

async function listWindows(port?: number): Promise<RawEntry[]> {
  const encoded = Buffer.from(windowsPortScript(port), "utf16le").toString("base64");
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
  );
  return parseWindowsJson(stdout);
}

export function parseWindowsJson(stdout: string): RawEntry[] {
  const text = stdout.replace(/^﻿/, "").trim();
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .map((r) => ({
      port: Number(r.port),
      address: String(r.address ?? ""),
      pid: Number(r.pid),
      name: typeof r.name === "string" ? r.name : null,
      cmd: typeof r.cmd === "string" ? r.cmd : null,
    }))
    .filter((r) => Number.isFinite(r.port) && Number.isFinite(r.pid));
}

// ---------------------------------------------------------------- macOS / Linux

async function listUnix(port?: number): Promise<RawEntry[]> {
  const args = ["-nP", port !== undefined ? `-iTCP:${port}` : "-iTCP", "-sTCP:LISTEN", "-Fpcn"];
  let stdout = "";
  try {
    ({ stdout } = await run("lsof", args, { maxBuffer: 16 * 1024 * 1024 }));
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string };
    if (e.code === "ENOENT") throw new Error("lsof isn't installed, so dx can't list ports on this system.");
    stdout = e.stdout ?? ""; // lsof exits 1 when nothing matches
  }
  const rows = parseLsof(stdout);
  const cmds = await unixCommandLines([...new Set(rows.map((r) => r.pid))]);
  return rows.map((r) => ({ ...r, cmd: cmds.get(r.pid) ?? null }));
}

export function parseLsof(stdout: string): RawEntry[] {
  const rows: RawEntry[] = [];
  let pid = 0;
  let name: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number(value);
      name = undefined;
    } else if (tag === "c") {
      name = value;
    } else if (tag === "n") {
      const m = /^(.*):(\d+)$/.exec(value);
      if (!m) continue;
      rows.push({ port: Number(m[2]), address: m[1].replace(/^\[|\]$/g, ""), pid, name: name ?? null });
    }
  }
  return rows;
}

async function unixCommandLines(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (pids.length === 0) return map;
  try {
    const { stdout } = await run("ps", ["-o", "pid=,command=", "-p", pids.join(",")]);
    for (const line of stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m) map.set(Number(m[1]), m[2]);
    }
  } catch {
    // command lines are a nice-to-have
  }
  return map;
}

// ---------------------------------------------------------------- shared

export function mergeEntries(rows: RawEntry[]): PortEntry[] {
  const byKey = new Map<string, PortEntry>();
  for (const r of rows) {
    const key = `${r.port}:${r.pid}`;
    const existing = byKey.get(key);
    if (existing) {
      if (r.address && !existing.addresses.includes(r.address)) existing.addresses.push(r.address);
      continue;
    }
    byKey.set(key, {
      port: r.port,
      pid: r.pid,
      addresses: r.address ? [r.address] : [],
      processName: r.name ?? undefined,
      commandLine: r.cmd ?? undefined,
      system: isSystemPid(r.pid),
    });
  }
  return [...byKey.values()].sort((a, b) => a.port - b.port || a.pid - b.pid);
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Not a valid port: ${port}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
