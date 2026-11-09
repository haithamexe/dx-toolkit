import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The AI agents running on this computer, read from Claude Code's own session files
 * (`~/.claude/projects/<project>/<session>.jsonl`, and a `subagents` folder next to each with one
 * transcript and one `.meta.json` per subagent): which sessions and subagents there are, how they
 * relate, what model and effort they run at, what they're doing now, and how often they used each
 * tool.
 *
 * Read-only, and metadata only: a fixed list of fields (names of tools, model, effort, times,
 * titles, the folder it works in), never a message, a prompt, a tool's input or result, or a
 * file's contents. A session's file can be hundreds of megabytes, so only its start and its last
 * megabyte are read, and what was read is kept until the file changes.
 */

export type AgentStatus = "working" | "waiting" | "idle" | "done" | "stopped";

export interface AgentNode {
  /** "s:<session>" or "a:<session>:<agent>". */
  id: string;
  kind: "session" | "subagent";
  parent?: string;
  /** The session's title, or the subagent's task as it was named. */
  label: string;
  /** For a subagent: its type (general-purpose, Explore…). */
  agentType?: string;
  model?: string;
  effort?: string;
  /** What runs it: claude-desktop, cli, sdk-ts… */
  app?: string;
  permissionMode?: string;
  /** The folder it works in, and the dx project that holds it when there is one. */
  cwd?: string;
  project?: string;
  branch?: string;
  status: AgentStatus;
  /** The tool it's running now (its name only). */
  tool?: string;
  startedAt?: string;
  lastAt: string;
  /** Calls per tool in the part of the transcript that was read, and how many were dx's own. */
  tools: Record<string, number>;
  calls: number;
  dxCalls: number;
  depth: number;
}

/** Claude Code's folder for its sessions (`CLAUDE_CONFIG_DIR` moves it, as it does for Claude Code). */
export function claudeProjectsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 1024 * 1024;
const SESSIONS_MAX = 40;
const SUBAGENTS_MAX = 80;
const clip = (s: unknown, n: number): string | undefined => (typeof s === "string" && s.trim() ? s.trim().replace(/\s+/g, " ").slice(0, n) : undefined);
const str = (s: unknown, n = 80): string | undefined => (typeof s === "string" && /^[\w .:@/+~#-]{1,200}$/.test(s) ? s.slice(0, n) : undefined);

interface Read {
  sessionId?: string;
  cwd?: string;
  branch?: string;
  app?: string;
  startedAt?: string;
  title?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  lastEvent?: string;
  stop?: string;
  pending?: string;
  tools: Record<string, number>;
  /** Ids of the Agent/Task calls in what was read: the subagents this transcript started. */
  spawned: string[];
}

const cache = new Map<string, { mtime: number; size: number; read: Read }>();

function lines(file: string, from: number, bytes: number, dropFirst: boolean): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, from);
    const out = buf.subarray(0, n).toString("utf8").split("\n");
    if (dropFirst) out.shift();
    return out.filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** What a transcript says about its agent, from its start and its last megabyte; kept until the file changes. */
function readTranscript(file: string): Read | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return undefined;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.read;
  const read: Read = { tools: Object.create(null) as Record<string, number>, spawned: [] };
  const take = (o: Record<string, unknown>, tail: boolean) => {
    if (typeof o.sessionId === "string" && !read.sessionId) read.sessionId = str(o.sessionId, 64);
    if (o.cwd !== undefined && (tail || !read.cwd) && typeof o.cwd === "string") read.cwd = o.cwd.slice(0, 500);
    if (o.gitBranch !== undefined && (tail || !read.branch)) read.branch = str(o.gitBranch, 100) ?? read.branch;
    if (o.entrypoint !== undefined && (tail || !read.app)) read.app = str(o.entrypoint, 40) ?? read.app;
    if (typeof o.timestamp === "string" && !read.startedAt && !tail) read.startedAt = o.timestamp;
    if (o.type === "custom-title") read.title = clip(o.customTitle, 80) ?? read.title;
    if (o.type === "agent-name" && !read.title) read.title = clip(o.agentName, 80);
    if (typeof o.permissionMode === "string") read.permissionMode = str(o.permissionMode, 30) ?? read.permissionMode;
    if (typeof o.effort === "string") read.effort = str(o.effort, 20) ?? read.effort;
    if (!tail) return;
    const message = o.message as Record<string, unknown> | undefined;
    if (o.type === "assistant" && message) {
      if (typeof message.model === "string") read.model = str(message.model, 60) ?? read.model;
      read.stop = typeof message.stop_reason === "string" ? message.stop_reason : undefined;
      read.lastEvent = "assistant";
      for (const part of Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []) {
        if (part.type !== "tool_use" || typeof part.name !== "string") continue;
        const name = part.name.slice(0, 80);
        read.tools[name] = (read.tools[name] ?? 0) + 1;
        if (typeof part.id === "string") {
          pending.set(part.id, name);
          if (name === "Agent" || name === "Task") read.spawned.push(part.id);
        }
      }
    } else if (o.type === "user" && message && Array.isArray(message.content)) {
      read.lastEvent = "user";
      for (const part of message.content as Record<string, unknown>[]) if (part.type === "tool_result" && typeof part.tool_use_id === "string") pending.delete(part.tool_use_id);
    }
  };
  const pending = new Map<string, string>();
  for (const line of lines(file, 0, Math.min(st.size, HEAD_BYTES), false)) {
    try {
      take(JSON.parse(line) as Record<string, unknown>, false);
    } catch {
      // a line cut off by the size we read, or not JSON
    }
  }
  const from = Math.max(0, st.size - TAIL_BYTES);
  for (const line of lines(file, from, Math.min(st.size, TAIL_BYTES), from > 0)) {
    try {
      take(JSON.parse(line) as Record<string, unknown>, true);
    } catch {
      // not JSON
    }
  }
  // The newest call still waiting for its result is what it's doing now.
  const last = [...pending.values()].pop();
  if (last) read.pending = last;
  cache.set(file, { mtime: st.mtimeMs, size: st.size, read });
  if (cache.size > SESSIONS_MAX * (SUBAGENTS_MAX + 1)) cache.delete(cache.keys().next().value as string);
  return read;
}

interface Meta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  depth: number;
  stopped: boolean;
  model?: string;
}

function readMeta(file: string): Meta {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8").slice(0, 100_000)) as Record<string, unknown>;
    return {
      agentType: str(o.agentType, 60),
      description: clip(o.description, 80),
      toolUseId: typeof o.toolUseId === "string" ? o.toolUseId.slice(0, 80) : undefined,
      depth: typeof o.spawnDepth === "number" && o.spawnDepth >= 1 && o.spawnDepth <= 8 ? Math.floor(o.spawnDepth) : 1,
      stopped: o.stoppedByUser === true,
      model: str(o.pickedEffortModel, 60),
    };
  } catch {
    return { depth: 1, stopped: false };
  }
}

/** Working while its file moves or a tool call waits for its result; waiting for you when a session's turn ended. */
export function agentStatus(r: { ageMs: number; pending?: string; stop?: string; lastEvent?: string; stopped?: boolean }, kind: "session" | "subagent"): AgentStatus {
  if (r.stopped) return "stopped";
  if (r.ageMs < 45_000) return "working";
  if (r.pending && r.ageMs < 30 * 60_000) return "working";
  // Its last word was a finished turn: a session waits for you, a subagent has handed its answer back.
  if (r.stop === "end_turn" && r.lastEvent === "assistant") return kind === "session" ? (r.ageMs < 60 * 60_000 ? "waiting" : "idle") : "done";
  // Stopped mid-way and quiet: a subagent that nobody is waiting on any more counts as done after a while.
  return kind === "subagent" && r.ageMs > 10 * 60_000 ? "done" : "idle";
}

const countTools = (tools: Record<string, number>) => ({ calls: Object.values(tools).reduce((a, b) => a + b, 0), dxCalls: Object.entries(tools).reduce((n, [k, v]) => n + (k.startsWith("mcp__dx__") ? v : 0), 0) });

/** The top tools by use, so a node stays small. */
function top(tools: Record<string, number>, n = 8): Record<string, number> {
  return Object.fromEntries(Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, n));
}

/**
 * Every session touched in the last `sinceHours` (default 24), newest first, each followed by its
 * subagents as a tree: `parent` is the session, or the subagent that started it. `projects` names
 * the dx project a folder belongs to.
 */
export function readAgents(options: { sinceHours?: number; now?: number; projects?: { name: string; dir: string }[] } = {}): AgentNode[] {
  const now = options.now ?? Date.now();
  const since = now - (options.sinceHours ?? 24) * 3_600_000;
  const base = claudeProjectsDir();
  const sessions: { file: string; dir: string; id: string; mtime: number }[] = [];
  let folders: string[] = [];
  try {
    folders = fs.readdirSync(base);
  } catch {
    return [];
  }
  for (const f of folders) {
    const dir = path.join(base, f);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/^[0-9a-f-]{8,64}\.jsonl$/i.test(n)) continue;
      try {
        const mtime = fs.statSync(path.join(dir, n)).mtimeMs;
        // A session also counts while one of its subagents is still going.
        let latest = mtime;
        const sub = path.join(dir, n.slice(0, -6), "subagents");
        if (fs.existsSync(sub)) for (const s of fs.readdirSync(sub)) if (s.endsWith(".jsonl")) latest = Math.max(latest, fs.statSync(path.join(sub, s)).mtimeMs);
        if (latest >= since) sessions.push({ file: path.join(dir, n), dir, id: n.slice(0, -6), mtime: latest });
      } catch {
        // gone while listing
      }
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  const projectOf = (cwd?: string) => {
    if (!cwd || !options.projects) return undefined;
    const c = path.resolve(cwd).toLowerCase();
    return options.projects.filter((p) => c === path.resolve(p.dir).toLowerCase() || c.startsWith(path.resolve(p.dir).toLowerCase() + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0]?.name;
  };

  const out: AgentNode[] = [];
  for (const s of sessions.slice(0, SESSIONS_MAX)) {
    const r = readTranscript(s.file);
    if (!r) continue;
    let mtime: number;
    try {
      mtime = fs.statSync(s.file).mtimeMs;
    } catch {
      continue;
    }
    const sid = `s:${s.id}`;
    const { calls, dxCalls } = countTools(r.tools);
    const project = projectOf(r.cwd);
    out.push({
      id: sid,
      kind: "session",
      label: r.title ?? project ?? (r.cwd ? path.basename(r.cwd) : "Session"),
      model: r.model,
      effort: r.effort,
      app: r.app,
      permissionMode: r.permissionMode,
      cwd: r.cwd,
      project,
      branch: r.branch,
      // A session whose subagent is still going is still going.
      status: agentStatus({ ageMs: now - s.mtime, pending: r.pending, stop: r.stop, lastEvent: r.lastEvent }, "session"),
      tool: r.pending,
      startedAt: r.startedAt,
      lastAt: new Date(mtime).toISOString(),
      tools: top(r.tools),
      calls,
      dxCalls,
      depth: 0,
    });

    // Its subagents: one transcript and one meta file each.
    const sub = path.join(s.dir, s.id, "subagents");
    let files: string[] = [];
    try {
      files = fs.readdirSync(sub).filter((f) => /^agent-[\w-]+\.jsonl$/.test(f));
    } catch {
      continue;
    }
    const agents = files
      .map((f) => {
        const file = path.join(sub, f);
        try {
          return { f, file, mtime: fs.statSync(file).mtimeMs, id: f.slice(6, -6) };
        } catch {
          return undefined;
        }
      })
      .filter((x): x is NonNullable<typeof x> => !!x && x.mtime >= since)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, SUBAGENTS_MAX);
    const spawnedBy = new Map<string, string>(r.spawned.map((id) => [id, sid]));
    const items = agents.map((a) => ({ a, meta: readMeta(path.join(sub, a.f.replace(/\.jsonl$/, ".meta.json"))), read: readTranscript(a.file) }));
    for (const it of items) for (const id of it.read?.spawned ?? []) spawnedBy.set(id, `a:${s.id}:${it.a.id}`);
    for (const { a, meta, read } of items) {
      if (!read) continue;
      const { calls: c, dxCalls: d } = countTools(read.tools);
      // Started by the transcript that has the call that named it; else the session (or the last one above it).
      const parent = (meta.toolUseId ? spawnedBy.get(meta.toolUseId) : undefined) ?? sid;
      out.push({
        id: `a:${s.id}:${a.id}`,
        kind: "subagent",
        parent: parent === `a:${s.id}:${a.id}` ? sid : parent,
        label: meta.description ?? meta.agentType ?? "Subagent",
        agentType: meta.agentType,
        model: read.model ?? meta.model,
        effort: read.effort,
        app: read.app,
        permissionMode: read.permissionMode,
        cwd: read.cwd,
        project: projectOf(read.cwd) ?? project,
        branch: read.branch,
        status: agentStatus({ ageMs: now - a.mtime, pending: read.pending, stop: read.stop, lastEvent: read.lastEvent, stopped: meta.stopped }, "subagent"),
        tool: read.pending,
        startedAt: read.startedAt,
        lastAt: new Date(a.mtime).toISOString(),
        tools: top(read.tools),
        calls: c,
        dxCalls: d,
        depth: meta.depth,
      });
    }
  }
  return out;
}

/** Counts for a line: "2 working, 1 waiting". */
export function agentSummary(agents: AgentNode[]): string {
  const n = (s: AgentStatus) => agents.filter((a) => a.status === s).length;
  const parts = (["working", "waiting", "idle", "done", "stopped"] as AgentStatus[]).filter((s) => n(s)).map((s) => `${n(s)} ${s}`);
  return parts.join(", ") || "none";
}
