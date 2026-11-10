import fs from "node:fs";
import { autoFixConfig, autoSetupTick, buildSummary, dxPath, formatSummary, loadConfig, recordRun, saveSummary, scanProjectsCached, writeFileAtomic, type AutoNotice } from "@dx/core";

/**
 * The dashboard's own look at the projects, every minute: a project dx hasn't seen before is set up
 * (core/autosetup.ts) and the page says so afterwards. It's quiet under a test's or a demo's
 * DX_HOME, since it writes into projects; tests call `lookAtProjects` with their own list.
 */
const notices: AutoNotice[] = [];
let busy = false;

/** One look at a list of projects; what dx did is kept for the page. */
export async function lookAtProjects(projects: { dir: string; name: string }[]): Promise<AutoNotice[]> {
  if (busy) return [];
  busy = true;
  try {
    const done = await autoSetupTick(projects);
    notices.push(...done);
    // The page only needs the latest few.
    if (notices.length > 50) notices.splice(0, notices.length - 50);
    return done;
  } catch {
    return [];
  } finally {
    busy = false;
  }
}

/** "2026-W46": the ISO week a date is in, so a summary is saved once a week. */
export function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - first.getTime()) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
}

/**
 * Saves the last seven days' summary once a week, from Monday on, without GitHub (no network and no
 * token): the file is in ~/.dx/summaries like one you saved yourself. `build`, `save` and `format` are for tests.
 */
export async function saveWeeklySummary(now = new Date(), build: typeof buildSummary = buildSummary, save: typeof saveSummary = saveSummary, format: typeof formatSummary = formatSummary): Promise<AutoNotice | undefined> {
  if (now.getDay() === 0) return undefined; // Sunday: wait for Monday, so a week is whole
  const marker = dxPath("weekly.json");
  const week = weekKey(now);
  try {
    if ((JSON.parse(fs.readFileSync(marker, "utf8")) as { week?: string }).week === week) return undefined;
  } catch {
    // never saved
  }
  const summary = await build({ days: 7, allAuthors: false, github: false });
  const file = save(format(summary), summary);
  fs.mkdirSync(dxPath(), { recursive: true });
  writeFileAtomic(marker, JSON.stringify({ week, file }), { mode: 0o600 });
  recordRun("summary", true, `saved on its own: ${file}`, "web");
  const notice = { id: fixId++, at: now.toISOString(), project: "dx", text: "Saved your last 7 days' summary to ~/.dx/summaries" };
  notices.push(notice);
  return notice;
}

let fixId = 1_000_000;
/** Doctor findings dx fixes itself (a missing editor, no projects folder); said once, like the rest. */
export async function healConfig(): Promise<AutoNotice[]> {
  try {
    const done = (await autoFixConfig()).map((text) => ({ id: fixId++, at: new Date().toISOString(), project: "dx", text }));
    notices.push(...done);
    return done;
  } catch {
    return [];
  }
}

export function startAutoSetup(): () => void {
  if (process.env.DX_HOME) return () => undefined;
  let n = 0;
  const tick = () => {
    void lookAtProjects(scanProjectsCached(loadConfig()));
    // The config is looked at less often: every ten minutes.
    if (n++ % 10 === 0) void healConfig();
    if (n % 30 === 1) void saveWeeklySummary().catch(() => undefined);
  };
  // A first look a little after start, so it doesn't compete with the dashboard coming up.
  const first = setTimeout(tick, 15_000);
  const timer = setInterval(tick, 60_000);
  first.unref();
  timer.unref();
  return () => (clearTimeout(first), clearInterval(timer));
}

/** What dx did by itself since a moment, oldest first. */
export function autoNoticesSince(sinceMs: number): AutoNotice[] {
  return notices.filter((n) => Date.parse(n.at) > sinceMs);
}
