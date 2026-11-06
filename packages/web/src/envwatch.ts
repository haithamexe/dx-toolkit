import { alertSettings, EnvWatcher, loadConfig, notifyOs, recordRun, scanProjects, type EnvAlert, type Project } from "@dx/core";

/**
 * The dashboard's watch on every project's .env files: changed, staged or committed. Each warning
 * is kept for the page (a toast and a sound), Floppy's line, and the system's own notification.
 * `envAlerts: false` in the config turns it all off.
 */
let watcher: EnvWatcher | undefined;

export function startEnvWatch(): () => void {
  watcher = new EnvWatcher((a) => {
    // A project can keep its warnings in dx and leave the system's notifications out.
    if (alertSettings(a.dir, loadConfig()).os) notifyOs(a.title, a.text);
    if (a.kind !== "changed") recordRun("env-alert", false, `${a.title}: ${a.files.join(", ")}`, "web", { project: a.project });
  });
  let projects: Project[] = [];
  let scannedAt = 0;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const config = loadConfig();
      if (config.envAlerts === false) return;
      if (Date.now() - scannedAt > 60_000) ((projects = scanProjects(config)), (scannedAt = Date.now()));
      // A project with its alerts off isn't watched at all; turned on again, its first look only remembers.
      const on = projects.filter((p) => alertSettings(p.dir, config).on);
      for (const p of projects) if (!on.includes(p)) watcher!.forget(p.dir);
      await watcher!.check(on);
    } catch {
      // the next look tries again
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(tick, 10_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** The warnings since a moment, oldest first. */
export function envAlertsSince(sinceMs: number): EnvAlert[] {
  return (watcher?.alerts ?? []).filter((a) => Date.parse(a.at) > sinceMs);
}
