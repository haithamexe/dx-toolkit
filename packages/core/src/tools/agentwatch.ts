import type { AgentNode } from "./agents.js";

/**
 * Warnings about the AI agents on this computer, made from what the Agents page reads: a session
 * that finished its turn and is waiting for your reply, and an agent stuck on one tool call.
 * Metadata only, like the page: the words carry a title, a project and a tool's name.
 */

export type AgentAlertKind = "waiting" | "stuck";

export interface AgentAlert {
  id: number;
  at: string;
  kind: AgentAlertKind;
  /** The agent's id on the Agents page. */
  agent: string;
  project?: string;
  label: string;
  minutes: number;
  title: string;
  text: string;
}

/** A session is "waiting for you" after this long without a reply from you, so a quick turn doesn't ping. */
export const WAITING_AFTER_MS = 90_000;
/** Waiting or stuck for longer than this when dx first looks: it was already there (or the session was closed), so it isn't news. */
const STALE_ON_FIRST_LOOK_MS = 10 * 60_000;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const minutesOf = (ms: number) => Math.max(1, Math.floor(ms / 60_000));

/** The sessions waiting for you now (not subagents: they hand their answer back to a session). */
export function waitingNow(agents: AgentNode[], now = Date.now()): { id: string; project?: string; label: string; minutes: number }[] {
  return agents
    .filter((a) => a.kind === "session" && a.status === "waiting" && now - Date.parse(a.lastAt) >= WAITING_AFTER_MS)
    .map((a) => ({ id: a.id, project: a.project, label: a.label, minutes: minutesOf(now - Date.parse(a.lastAt)) }))
    .sort((a, b) => a.minutes - b.minutes);
}

export function agentAlertWords(kind: AgentAlertKind, a: { project?: string; label: string; minutes: number; tool?: string }): { title: string; text: string } {
  const where = a.project ?? "An agent";
  const what = a.label ? `"${clip(a.label, 60)}"` : "It";
  if (kind === "waiting") return { title: `${where}: an agent is waiting for you`, text: `${what} has been waiting for your reply for ${a.minutes} min.` };
  return { title: `${where}: an agent may be stuck`, text: `${what} has been on ${a.tool ?? "one tool"} for ${a.minutes} min with nothing new. It may be hung, or waiting for you to approve it.` };
}

export class AgentWatcher {
  alerts: AgentAlert[] = [];
  private seq = 0;
  private told = new Set<string>();
  private looked = false;

  /**
   * Looks at the agents as they are now; returns the warnings that are new. Each is said once per
   * turn (a new reply from the agent starts a new one). The first look only remembers what has
   * waited for a long time already.
   */
  check(agents: AgentNode[], now = Date.now(), onAlert?: (a: AgentAlert) => void): AgentAlert[] {
    const live = new Set<string>();
    const fresh: AgentAlert[] = [];
    const say = (kind: AgentAlertKind, a: AgentNode, key: string, minutes: number, tool?: string, ageMs = 0) => {
      live.add(key);
      if (this.told.has(key)) return;
      this.told.add(key);
      if (!this.looked && ageMs > STALE_ON_FIRST_LOOK_MS) return;
      const alert: AgentAlert = { id: ++this.seq, at: new Date(now).toISOString(), kind, agent: a.id, project: a.project, label: a.label, minutes, ...agentAlertWords(kind, { project: a.project, label: a.label, minutes, tool }) };
      this.alerts.push(alert);
      if (this.alerts.length > 100) this.alerts.splice(0, this.alerts.length - 100);
      fresh.push(alert);
      onAlert?.(alert);
    };
    for (const a of agents) {
      const age = now - Date.parse(a.lastAt);
      if (a.kind === "session" && a.status === "waiting" && age >= WAITING_AFTER_MS) say("waiting", a, `${a.id}|waiting|${a.lastAt}`, minutesOf(age), undefined, age);
      // A session waiting on its subagent says nothing of its own when the subagent is the one that is stuck.
      const childStuck = a.kind === "session" && agents.some((k) => k.parent === a.id && k.stuck);
      if (a.stuck && a.status !== "stopped" && !childStuck) say("stuck", a, `${a.id}|stuck|${a.stuck.tool}|${a.lastAt}`, a.stuck.minutes, a.stuck.tool, age);
    }
    // What isn't waiting or stuck any more can be said again the next time.
    for (const k of [...this.told]) if (!live.has(k)) this.told.delete(k);
    this.looked = true;
    return fresh;
  }

  since(ms: number): AgentAlert[] {
    return this.alerts.filter((a) => Date.parse(a.at) > ms);
  }
}
