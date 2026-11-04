import { findBrowser, launchDxBrowser, listSites, loadConfig, siteTarget, type DxBrowser, type SiteConfig, type SiteTarget } from "@dx/core";
import { activitySettings, recordActivity } from "./activity.js";
import { listDevServers, serverForPort } from "./dev.js";

/**
 * The dashboard's dx browser: one window at a time, owned by the dashboard like its dev servers
 * (it closes when the dashboard stops). What it records goes into the activity history through
 * recordActivity, so the Activity page, the CLI and agents see it like everything else.
 */

let current: DxBrowser | undefined;
let opening: Promise<DxBrowser> | undefined;
let dashboardPort: number | undefined;
let sitesCache: { at: number; sites: SiteConfig[] } | undefined;

/** The dashboard's own address is never recorded, not even when a recorded page calls it. */
export function setDxBrowserDashboardPort(port: number | undefined): void {
  dashboardPort = port;
}

/** After the sites change: read them again on the next event. */
export function forgetSites(): void {
  sitesCache = undefined;
}

function sites(): SiteConfig[] {
  if (!sitesCache || Date.now() - sitesCache.at > 3000) {
    let list: SiteConfig[] = [];
    try {
      list = listSites(loadConfig());
    } catch {
      // an unreadable config: only addresses on this computer
    }
    sitesCache = { at: Date.now(), sites: list };
  }
  return sitesCache.sites;
}

function isDashboard(u: URL): boolean {
  if (u.hostname === "dx.localhost") return true;
  return dashboardPort !== undefined && Number(u.port) === dashboardPort && /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname);
}

/**
 * Where an address's events go. Pages served through dx's own proxy (name.localhost) or its
 * localhost door are recorded there already, so the dx browser leaves them alone; an address on
 * this computer that a dev server dx runs answers goes under that project.
 */
export function browserTargetFor(url: string): SiteTarget | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (isDashboard(u)) return undefined;
  const origin = u.origin;
  for (const s of listDevServers()) {
    for (const x of [s, ...(s.services ?? [])]) {
      if (x.localUrl && sameOrigin(x.localUrl, origin)) return undefined;
      if (x.recorded && x.url && sameOrigin(x.url, origin)) return undefined;
    }
  }
  const target = siteTarget(url, sites());
  if (!target) return undefined;
  // A configured site keeps what it says; a bare local address goes under the dev server answering there.
  if (target.env === "local" && target.dir.startsWith("site:")) {
    const configured = sites().some((s) => s.host === target.site || s.host === u.hostname);
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    const server = configured ? undefined : serverForPort(port);
    if (server) return { ...target, dir: server.dir, project: server.project, service: server.service };
  }
  return target;
}

function sameOrigin(a: string, origin: string): boolean {
  try {
    return new URL(a).origin === origin;
  } catch {
    return false;
  }
}

export interface DxBrowserStatus {
  open: boolean;
  /** Which browser would be used, or none found. */
  browser?: string;
  found: boolean;
  pid?: number;
  startedAt?: string;
  pages?: number;
  /** Whether the history is kept at all (activity on). */
  recording: boolean;
}

export function dxBrowserStatus(): DxBrowserStatus {
  const recording = activitySettings().on;
  if (current) return { open: true, browser: current.browser, found: true, pid: current.pid, startedAt: current.startedAt, pages: current.pages(), recording };
  const found = findBrowser();
  return { open: false, found: !!found, browser: found?.name, recording };
}

export function dxBrowserOpen(): boolean {
  return !!current;
}

/** Opens the dx browser, or a new tab in it when it's open already. `url` must be http(s). */
export async function openDxBrowser(url?: string, options: { profileDir?: string; headless?: boolean } = {}): Promise<DxBrowserStatus> {
  if (current) {
    if (url) await current.open(url);
    return dxBrowserStatus();
  }
  opening ??= launchDxBrowser({
    url,
    profileDir: options.profileDir,
    // Without a window, for tests and checks on machines nobody is looking at.
    headless: options.headless ?? process.env.DX_BROWSER_HEADLESS === "1",
    targetFor: browserTargetFor,
    ignore: (u) => {
      try {
        return isDashboard(new URL(u));
      } catch {
        return true;
      }
    },
    onEvent: (e) => void recordActivity(e),
  }).finally(() => (opening = undefined));
  const b = await opening;
  current = b;
  void b.closed.then(() => {
    if (current === b) current = undefined;
  });
  return dxBrowserStatus();
}

export async function closeDxBrowser(): Promise<boolean> {
  const b = current ?? (await opening?.catch(() => undefined));
  if (!b) return false;
  current = undefined;
  await b.close();
  return true;
}
