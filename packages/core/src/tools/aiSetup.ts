import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, stripBom } from "../config.js";
import { commandExists } from "./doctor.js";

/**
 * Connects dx's MCP server to the AI tools installed on this computer, so nobody has to edit a
 * config file: Claude Code, Claude Desktop, Cursor, Windsurf and VS Code. Each tool keeps its MCP
 * servers in its own file; dx adds a "dx" entry there (with a backup of the file the first time)
 * and can remove it again.
 */

export type AiToolId = "claude-code" | "claude-desktop" | "cursor" | "windsurf" | "vscode";

export interface AiToolStatus {
  id: AiToolId;
  name: string;
  /** The tool seems to be installed. */
  installed: boolean;
  /** It has a "dx" MCP server entry. */
  connected: boolean;
  /** The entry points at this copy of dx and a Node that exists. */
  current: boolean;
  configFile?: string;
  /** What to do after connecting, e.g. restart the app. */
  note?: string;
}

export interface AiToolResult {
  id: AiToolId;
  name: string;
  ok: boolean;
  message: string;
}

/** Where things live; tests pass their own. */
export interface AiEnv {
  home: string;
  /** %APPDATA% on Windows, ~/Library/Application Support on macOS, ~/.config on Linux. */
  appData: string;
  platform: NodeJS.Platform;
  /** Node to run the server with, and the server script. */
  node: string;
  script: string;
  /** Runs `claude mcp …`; tests replace it. */
  claudeCli?: (args: string[]) => Promise<{ ok: boolean; output: string }>;
  hasClaudeCli?: () => Promise<boolean>;
}

/** The MCP server's entry point in this checkout: packages/mcp/dist/index.js. */
export function mcpServerScript(): string {
  // This file is packages/core/dist/tools/aiSetup.js.
  return path.resolve(fileURLToPath(new URL("../../../mcp/dist/index.js", import.meta.url)));
}

export function defaultAiEnv(): AiEnv {
  const home = os.homedir();
  const platform = process.platform;
  const appData =
    platform === "win32"
      ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming"))
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : (process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"));
  return { home, appData, platform, node: process.execPath, script: mcpServerScript() };
}

interface FileTool {
  id: AiToolId;
  name: string;
  /** A folder whose existence means the tool is installed. */
  marker: (env: AiEnv) => string;
  file: (env: AiEnv) => string;
  /** The key that holds the servers: "mcpServers", or "servers" for VS Code. */
  key: string;
  entry: (env: AiEnv) => Record<string, unknown>;
  note?: string;
}

const FILE_TOOLS: FileTool[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    marker: (e) => path.join(e.appData, "Claude"),
    file: (e) => path.join(e.appData, "Claude", "claude_desktop_config.json"),
    key: "mcpServers",
    entry: (e) => ({ command: e.node, args: [e.script] }),
    note: "Restart Claude Desktop to load it.",
  },
  {
    id: "cursor",
    name: "Cursor",
    marker: (e) => path.join(e.home, ".cursor"),
    file: (e) => path.join(e.home, ".cursor", "mcp.json"),
    key: "mcpServers",
    entry: (e) => ({ command: e.node, args: [e.script] }),
  },
  {
    id: "windsurf",
    name: "Windsurf",
    marker: (e) => path.join(e.home, ".codeium", "windsurf"),
    file: (e) => path.join(e.home, ".codeium", "windsurf", "mcp_config.json"),
    key: "mcpServers",
    entry: (e) => ({ command: e.node, args: [e.script] }),
  },
  {
    id: "vscode",
    name: "VS Code",
    marker: (e) => path.join(e.appData, "Code", "User"),
    file: (e) => path.join(e.appData, "Code", "User", "mcp.json"),
    key: "servers",
    entry: (e) => ({ type: "stdio", command: e.node, args: [e.script] }),
    note: "In Copilot Chat's agent mode, the dx tools appear under Tools.",
  },
];

const SERVER_NAME = "dx";

export async function listAiTools(env: AiEnv = defaultAiEnv()): Promise<AiToolStatus[]> {
  const out: AiToolStatus[] = [await claudeCodeStatus(env)];
  for (const tool of FILE_TOOLS) {
    const file = tool.file(env);
    const entry = readEntry(file, tool.key);
    out.push({
      id: tool.id,
      name: tool.name,
      installed: fs.existsSync(tool.marker(env)),
      connected: !!entry,
      current: !!entry && entryIsCurrent(entry, env),
      configFile: file,
      note: tool.note,
    });
  }
  return out;
}

/** Adds dx to the given tools, or to every installed one. An outdated entry is replaced. */
export async function connectAiTools(ids?: AiToolId[], env: AiEnv = defaultAiEnv()): Promise<AiToolResult[]> {
  if (!fs.existsSync(env.script)) {
    return [{ id: "claude-code", name: "dx", ok: false, message: `The MCP server isn't built yet (${env.script}). Run npm run build in the dx folder.` }];
  }
  const statuses = await listAiTools(env);
  const wanted = statuses.filter((s) => (ids ? ids.includes(s.id) : s.installed));
  const results: AiToolResult[] = [];
  for (const s of wanted) {
    if (s.connected && s.current) {
      results.push({ id: s.id, name: s.name, ok: true, message: "already connected" });
      continue;
    }
    try {
      if (s.id === "claude-code") {
        const cli = env.claudeCli ?? runClaude;
        if (s.connected) await cli(["mcp", "remove", "-s", "user", SERVER_NAME]);
        const r = await cli(["mcp", "add", "-s", "user", SERVER_NAME, "--", env.node, env.script]);
        if (!r.ok) throw new Error(r.output.trim() || "claude mcp add failed");
      } else {
        const tool = FILE_TOOLS.find((t) => t.id === s.id)!;
        writeEntry(tool.file(env), tool.key, tool.entry(env));
      }
      results.push({ id: s.id, name: s.name, ok: true, message: s.connected ? "updated to this copy of dx" : `connected${s.note ? `. ${s.note}` : ""}` });
    } catch (err) {
      results.push({ id: s.id, name: s.name, ok: false, message: (err as Error).message });
    }
  }
  return results;
}

/** Removes dx from the given tools, or from every tool it's in. */
export async function disconnectAiTools(ids?: AiToolId[], env: AiEnv = defaultAiEnv()): Promise<AiToolResult[]> {
  const statuses = await listAiTools(env);
  const results: AiToolResult[] = [];
  for (const s of statuses.filter((x) => x.connected && (!ids || ids.includes(x.id)))) {
    try {
      if (s.id === "claude-code") {
        const r = await (env.claudeCli ?? runClaude)(["mcp", "remove", "-s", "user", SERVER_NAME]);
        if (!r.ok) throw new Error(r.output.trim() || "claude mcp remove failed");
      } else {
        const tool = FILE_TOOLS.find((t) => t.id === s.id)!;
        removeEntry(tool.file(env), tool.key);
      }
      results.push({ id: s.id, name: s.name, ok: true, message: "disconnected" });
    } catch (err) {
      results.push({ id: s.id, name: s.name, ok: false, message: (err as Error).message });
    }
  }
  return results;
}

/**
 * The no-setup step, run on dx's first use and whenever the dashboard starts: connects dx to AI
 * tools it hasn't seen before, and repoints entries that point at an old copy of dx or an old
 * Node. A tool the user disconnected by hand stays disconnected (it's been seen), and
 * `autoConnectAi: false` in the config turns this off.
 */
export async function autoConnectAiTools(env: AiEnv = defaultAiEnv()): Promise<AiToolResult[]> {
  const config = loadConfig();
  if (config.autoConnectAi === false || !fs.existsSync(env.script)) return [];
  const seen = new Set(config.aiToolsSeen ?? []);
  const statuses = await listAiTools(env);
  const todo = statuses.filter((s) => s.installed && ((!seen.has(s.id) && !s.connected) || (s.connected && !s.current)));
  const results = todo.length ? await connectAiTools(todo.map((s) => s.id), env) : [];
  const installed = statuses.filter((s) => s.installed).map((s) => s.id);
  if (config.aiToolsSeen === undefined || installed.some((id) => !seen.has(id))) {
    saveConfig({ ...loadConfig(), aiToolsSeen: [...new Set([...seen, ...installed])] });
  }
  return results;
}

// ------------------------------------------------------------ Claude Code

async function claudeCodeStatus(env: AiEnv): Promise<AiToolStatus> {
  const installed = env.hasClaudeCli ? await env.hasClaudeCli() : !!(await commandExists("claude"));
  // Claude Code keeps user-scope MCP servers at the top level of ~/.claude.json.
  const file = path.join(env.home, ".claude.json");
  const entry = readEntry(file, "mcpServers");
  return {
    id: "claude-code",
    name: "Claude Code",
    installed,
    connected: !!entry,
    current: !!entry && entryIsCurrent(entry, env),
    configFile: file,
    note: "New Claude Code sessions have the dx tools.",
  };
}

function runClaude(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    // claude is a .cmd shim when installed with npm on Windows, so it goes through the shell there.
    const cmd = isWin ? `claude ${args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ")}` : "claude";
    execFile(isWin ? "cmd.exe" : cmd, isWin ? ["/d", "/s", "/c", cmd] : args, { windowsHide: true, timeout: 30_000, windowsVerbatimArguments: isWin }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: `${stdout}${stderr}` }),
    );
  });
}

// ------------------------------------------------------------ JSON files

function entryIsCurrent(entry: Record<string, unknown>, env: AiEnv): boolean {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const command = String(entry.command ?? "");
  const same = (a: string, b: string) => (env.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  const scriptOk = args.some((a) => same(a, env.script));
  const nodeOk = command === "node" || fs.existsSync(command);
  return scriptOk && nodeOk;
}

function readJsonc(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return undefined;
  const raw = stripBom(fs.readFileSync(file, "utf8"));
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // VS Code's files may have comments and trailing commas.
    const cleaned = raw
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} isn't valid JSON, so dx left it alone. Fix or delete it, then try again.`);
    }
  }
}

function readEntry(file: string, key: string): Record<string, unknown> | undefined {
  try {
    const json = readJsonc(file);
    const servers = json?.[key];
    if (!servers || typeof servers !== "object") return undefined;
    const entry = (servers as Record<string, unknown>)[SERVER_NAME];
    return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function writeEntry(file: string, key: string, entry: Record<string, unknown>): void {
  const json = readJsonc(file) ?? {};
  backupOnce(file);
  const servers = json[key] && typeof json[key] === "object" ? (json[key] as Record<string, unknown>) : {};
  json[key] = { ...servers, [SERVER_NAME]: entry };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
}

function removeEntry(file: string, key: string): void {
  const json = readJsonc(file);
  if (!json || !json[key] || typeof json[key] !== "object") return;
  backupOnce(file);
  delete (json[key] as Record<string, unknown>)[SERVER_NAME];
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
}

function backupOnce(file: string): void {
  const backup = `${file}.dx-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
}
