import { agentAlertWords, agentsReadable, alertSettings, AgentWatcher, loadConfig, notifyOs, readAgents, recordRun, scanProjects, waitingNow, type AgentAlert, type AgentNode, type Project } from "@dx/core";

/**
 * The dashboard's watch on the AI agents: a session waiting for your reply, or an agent stuck on one
 * tool call. Read from the same session files as the Agents page (metadata only), every 10 s, with
 * the page's own cache so a look costs a few milliseconds. Each warning is kept for the page (a
 * toast and a sound), Floppy's line, and the system's notification. `agentAlerts: false` in the
 * config turns it off, and a project's own alert switches (off, or without the system's) apply.
 */
const watcher = new AgentWatcher();
let latest: AgentNode[] = [];

export function startAgentWatch(): () => void {
  // Tests set DX_HOME; unless they also give a Claude folder of their own, the real one isn't read.
  if (!agentsReadable()) return () => undefined;
  let projects: Project[] = [];
  let scannedAt = 0;
  const tick = () => {
    try {
      const config = loadConfig();
      if (config.agentAlerts === false) {
        latest = [];
        return;
      }
      if (Date.now() - scannedAt > 60_000) ((projects = scanProjects(config)), (scannedAt = Date.now()));
      const dirOf = (name?: string) => projects.find((p) => p.name === name)?.dir;
      // A project with its alerts off isn't watched for agents either.
      latest = readAgents({ sinceHours: 1, projects: projects.map((p) => ({ name: p.name, dir: p.dir })) }).filter((a) => {
        const dir = dirOf(a.project);
        return !dir || alertSettings(dir, config).on;
      });
      watcher.check(latest, Date.now(), (a) => {
        const dir = dirOf(a.project);
        if (!dir || alertSettings(dir, config).os) notifyOs(a.title, a.text);
        recordRun("agent-alert", a.kind === "waiting", `${a.title}: ${a.text}`, "web", a.project ? { project: a.project } : undefined);
      });
    } catch {
      // the next look tries again
    }
  };
  tick();
  const timer = setInterval(tick, 10_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** The warnings since a moment, oldest first. */
export function agentAlertsSince(sinceMs: number): AgentAlert[] {
  return watcher.since(sinceMs);
}

/** The sessions waiting for you right now, for Floppy's line. */
export function agentsWaiting(): ReturnType<typeof waitingNow> {
  return waitingNow(latest);
}

export { agentAlertWords };
