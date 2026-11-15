import fs from "node:fs";
import { writeFileAtomic } from "../atomic.js";
import { dxPath, ensureDxHome } from "../config.js";

/**
 * What the last checks of a site found, kept so the next one can say how it compares: "slower than last
 * time". Numbers and counts only, never an address, a header, a cookie or a page's text. Newest first,
 * a dozen per kind of check per site, for 200 sites at most; 0600 under ~/.dx.
 */

export type SiteCheckKind = "status" | "page" | "audit";

export interface SiteCheckRecord {
  at: string;
  what: SiteCheckKind;
  ok: boolean;
  /** Status check: the HTTP status, how long it took, and how many findings were problems or warnings. */
  status?: number;
  ms?: number;
  bad?: number;
  warn?: number;
  /** Page check: errors, failed requests and requests made. */
  problems?: number;
  requests?: number;
  /** Speed and accessibility. */
  loadMs?: number;
  lcpMs?: number;
  tbtMs?: number;
  cls?: number;
  jsBytes?: number;
  a11y?: number;
  /** Which deployment answered, when it said. */
  commit?: string;
}

interface Store {
  format: "dx-site-checks";
  version: 1;
  sites: Record<string, SiteCheckRecord[]>;
}

const PER_KIND = 12;
const MAX_SITES = 200;
const file = () => dxPath("sitechecks.json");
const keyOf = (dir: string, host: string) => `${dir.toLowerCase()}|${host.toLowerCase()}`;

function read(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<Store>;
    if (raw.format === "dx-site-checks" && raw.sites && typeof raw.sites === "object") return { format: "dx-site-checks", version: 1, sites: raw.sites };
  } catch {
    // none yet, or unreadable: start again
  }
  return { format: "dx-site-checks", version: 1, sites: {} };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined);

/** Only the fields a record has, each a plain number or short word. */
function clean(r: SiteCheckRecord): SiteCheckRecord {
  const out: SiteCheckRecord = { at: r.at, what: r.what, ok: !!r.ok };
  for (const k of ["status", "ms", "bad", "warn", "problems", "requests", "loadMs", "lcpMs", "tbtMs", "cls", "jsBytes", "a11y"] as const) {
    const v = num(r[k]);
    if (v !== undefined) out[k] = v;
  }
  if (typeof r.commit === "string" && /^[0-9a-f]{7,40}$/i.test(r.commit)) out.commit = r.commit.toLowerCase();
  return out;
}

export function recordSiteCheck(dir: string, host: string, record: Omit<SiteCheckRecord, "at"> & { at?: string }): void {
  try {
    const store = read();
    const key = keyOf(dir, host);
    const all = store.sites[key] ?? [];
    const rec = clean({ ...record, at: record.at ?? new Date().toISOString() });
    const same = all.filter((x) => x.what === rec.what);
    const others = all.filter((x) => x.what !== rec.what);
    store.sites[key] = [rec, ...same].slice(0, PER_KIND).concat(others);
    const keys = Object.keys(store.sites);
    if (keys.length > MAX_SITES) for (const k of keys.slice(0, keys.length - MAX_SITES)) delete store.sites[k];
    ensureDxHome();
    writeFileAtomic(file(), JSON.stringify(store), { mode: 0o600 });
  } catch {
    // a history that can't be kept never fails a check
  }
}

/** The latest of each kind with the one before it, for "slower than last time". */
export function lastSiteChecks(dir: string, host: string): Partial<Record<SiteCheckKind, { latest: SiteCheckRecord; previous?: SiteCheckRecord }>> {
  const all = read().sites[keyOf(dir, host)] ?? [];
  const out: Partial<Record<SiteCheckKind, { latest: SiteCheckRecord; previous?: SiteCheckRecord }>> = {};
  for (const kind of ["status", "page", "audit"] as const) {
    const of = all.filter((x) => x.what === kind);
    if (of[0]) out[kind] = { latest: of[0], previous: of[1] };
  }
  return out;
}

/** All of a site's records of one kind, newest first (for a trend). */
export function siteCheckHistory(dir: string, host: string, kind: SiteCheckKind): SiteCheckRecord[] {
  return (read().sites[keyOf(dir, host)] ?? []).filter((x) => x.what === kind);
}
