import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dxPath } from "../config.js";
import { readActivity } from "./activity.js";
import { findBrowser, isLoopbackUrl, withBrowser, type BrowserPage } from "./browser.js";
import { gitRun } from "./git.js";

/**
 * A visual diff for every commit: the pages of the app you've been using, screenshotted at a
 * fixed size with animations off once the network is quiet, and compared with the capture of the
 * commit before. Core has no PNG decoder, so the comparison runs in the same headless browser, on
 * a canvas in a blank page.
 *
 * Stored under ~/.dx/visual/<project>-<hash>/<commit>/<path>@<viewport>.png, with index.json
 * beside the commit folders; the newest VISUAL_KEEP commits are kept.
 */

export type VisualViewport = "desktop" | "mobile";

export const VISUAL_VIEWPORTS: Record<VisualViewport, { width: number; height: number; mobile: boolean }> = {
  desktop: { width: 1280, height: 800, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
};

/** How many commits' captures are kept per project. */
export const VISUAL_KEEP = 30;
/** How many of the most visited pages are captured. */
export const VISUAL_MAX_PATHS = 4;
/** A channel may differ by this much (of 255) and still count as the same: anti-aliasing. */
export const VISUAL_TOLERANCE = 24;
/** Fewer differing pixels than this is noise, not a change. */
export const VISUAL_MIN_PIXELS = 16;

export interface VisualBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualCapture {
  /** "cart@desktop": the file's name, and how the image route names it. */
  name: string;
  /** The page's path on the dev server: "/cart". */
  path: string;
  viewport: VisualViewport;
  width: number;
  height: number;
  /** The document's HTTP status. */
  status?: number;
  /** Why this page couldn't be captured. */
  error?: string;
  /** Against the commit it was compared with; absent when there was nothing to compare with. */
  changed?: boolean;
  /** The share of pixels that differ, 0 to 1. */
  ratio?: number;
  /** Where the change is, in page pixels. */
  box?: VisualBox;
  /** What's at the change, from the page: "the Checkout button". */
  label?: string;
  /** A diff image was saved (changed pixels over a dimmed copy). */
  diff?: boolean;
  /** This page wasn't captured for the commit it's compared with. */
  isNew?: boolean;
}

export interface VisualCommit {
  commit: string;
  /** When it was captured. */
  at: string;
  subject?: string;
  /** The commit it was compared with: its parent's capture, else the newest one before it. */
  against?: string;
  /** What made it: "commit" (the Git page), "head" (HEAD moved), "manual". */
  reason?: string;
  browser?: string;
  baseUrl?: string;
  captures: VisualCapture[];
  /** Any page changed. Absent when there was nothing to compare with. */
  changed?: boolean;
  /** The largest change of any page. */
  ratio?: number;
  /** A small picture of the first page, for the graph. */
  thumb?: boolean;
}

export interface VisualIndex {
  dir: string;
  project: string;
  /** Newest first. */
  commits: VisualCommit[];
}

/** A refusal with the HTTP status the dashboard should answer with. */
export class VisualError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const CAPTURE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}@(desktop|mobile)$/;
const HEX = /^[0-9a-f]{4,64}$/;

export function isCommitHash(text: unknown): text is string {
  return typeof text === "string" && HEX.test(text);
}

export function isCaptureName(text: unknown): text is string {
  return typeof text === "string" && CAPTURE_NAME.test(text);
}

const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));

/** One project's folder: its name and a short hash of its path. */
export function visualFolder(dir: string): string {
  const name = path.basename(dir).replace(/[^\w.-]+/g, "-").slice(0, 40) || "project";
  return dxPath("visual", `${name}-${crypto.createHash("sha1").update(norm(dir)).digest("hex").slice(0, 8)}`);
}

/** "/" → "home", "/cart/items" → "cart-items", "/#/orders" → "orders". */
export function pathSlug(p: string): string {
  const slug = p
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 50);
  return slug || "home";
}

/** A name for each path and viewport, unique even when two paths make the same slug. */
export function captureNames(paths: string[], viewport: VisualViewport): { path: string; name: string }[] {
  const used = new Set<string>();
  return paths.map((p) => {
    let slug = pathSlug(p);
    for (let i = 2; used.has(slug); i++) slug = `${pathSlug(p).slice(0, 46)}-${i}`;
    used.add(slug);
    return { path: p, name: `${slug}@${viewport}` };
  });
}

export function readVisualIndex(dir: string): VisualIndex {
  const file = path.join(visualFolder(dir), "index.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as VisualIndex;
    if (raw && Array.isArray(raw.commits)) return { dir: raw.dir ?? dir, project: raw.project ?? path.basename(dir), commits: raw.commits.filter((c) => c && isCommitHash(c.commit)) };
  } catch {
    // none yet, or cut short
  }
  return { dir, project: path.basename(dir), commits: [] };
}

function writeVisualIndex(dir: string, index: VisualIndex): void {
  const folder = visualFolder(dir);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "index.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/**
 * The index with `entry` in it (replacing an earlier capture of the same commit), newest first,
 * cut to `keep` commits; and the commits that fell off, whose folders go.
 */
export function addToVisualIndex(index: VisualIndex, entry: VisualCommit, keep = VISUAL_KEEP): { index: VisualIndex; removed: string[] } {
  const rest = index.commits.filter((c) => c.commit !== entry.commit);
  const all = [entry, ...rest].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const kept = all.slice(0, Math.max(1, keep));
  return { index: { ...index, commits: kept }, removed: all.slice(kept.length).map((c) => c.commit) };
}

/** Removes commit folders the index doesn't list (pruned ones, captures cut short). */
export function pruneVisualFolders(dir: string, index: VisualIndex): string[] {
  const folder = visualFolder(dir);
  const keep = new Set(index.commits.map((c) => c.commit));
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return removed;
  }
  for (const name of names) {
    // Only folders dx made: a commit hash, or a capture on its way (hash.tmp-…) left by a crash.
    const hash = name.split(".")[0];
    if (!HEX.test(hash) || (keep.has(name) && !name.includes("."))) continue;
    if (name.includes(".tmp-")) {
      try {
        // One being written right now is younger than a few minutes.
        if (Date.now() - fs.statSync(path.join(folder, name)).mtimeMs < 10 * 60_000) continue;
      } catch {
        continue;
      }
    }
    fs.rmSync(path.join(folder, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** Captures for a project, newest commit first. */
export function listVisual(dir: string, limit = VISUAL_KEEP): VisualCommit[] {
  return readVisualIndex(dir).commits.slice(0, limit);
}

/**
 * The most visited pages of the last day, from the activity history: paths of page loads and
 * route changes on this computer (a `#/route` kept, a query string not), most visited first.
 * dx's own headless checks don't count.
 */
export function topVisitedPaths(dir: string, options: { limit?: number; now?: number; hours?: number } = {}): string[] {
  const now = options.now ?? Date.now();
  const since = now - (options.hours ?? 24) * 3_600_000;
  const counts = new Map<string, number>();
  let events: ReturnType<typeof readActivity> = [];
  try {
    events = readActivity({ dir, types: ["page", "route"], since: new Date(since), limit: 5000 });
  } catch {
    return [];
  }
  for (const e of events) {
    if (e.from === "check" || !e.url || Date.parse(e.at) < since || (e.status ?? 200) >= 400) continue;
    if (!isLoopbackUrl(e.url)) continue;
    const u = new URL(e.url);
    if (u.pathname.startsWith("/__dx/") || u.pathname === "/favicon.ico") continue;
    const key = u.pathname + (u.hash.startsWith("#/") ? u.hash : "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, options.limit ?? VISUAL_MAX_PATHS)
    .map(([p]) => p);
}

/**
 * Compares two images' RGBA pixels. A pixel differs when any channel differs by more than `tol`.
 * Writes the diff picture into `out`: differing pixels orange, the rest a washed-out grey copy of
 * `b`. It runs in the browser too (its source is sent there), so it uses nothing from outside.
 */
export function diffPixels(a: ArrayLike<number>, b: ArrayLike<number>, out: { [i: number]: number }, w: number, h: number, tol: number): { count: number; box?: VisualBox } {
  let count = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
      if (d > tol) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        out[i] = 255;
        out[i + 1] = 106;
        out[i + 2] = 0;
        out[i + 3] = 255;
      } else {
        const grey = b[i] * 0.3 + b[i + 1] * 0.59 + b[i + 2] * 0.11;
        const v = Math.round(255 - (255 - grey) * 0.25);
        out[i] = v;
        out[i + 1] = v;
        out[i + 2] = v;
        out[i + 3] = 255;
      }
    }
  }
  return count ? { count, box: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } } : { count };
}

/** Where on the page a change is, in words: "near the top left", "across most of the page". */
export function describeRegion(box: VisualBox, width: number, height: number): string {
  if (box.width * box.height > width * height * 0.6) return "across most of the page";
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const v = cy < height / 3 ? "top" : cy < (height * 2) / 3 ? "middle" : "bottom";
  const hz = box.width > width * 0.6 ? "" : cx < width / 3 ? "left" : cx < (width * 2) / 3 ? "" : "right";
  if (v === "middle") return hz ? `on the ${hz}` : "in the middle";
  return `near the ${v}${hz ? ` ${hz}` : ""}`;
}

/** "3.4%", "under 0.1%". */
export function formatRatio(ratio: number): string {
  const pct = ratio * 100;
  if (pct > 0 && pct < 0.1) return "under 0.1%";
  return pct < 10 ? `${Number(pct.toFixed(1))}%` : `${Math.round(pct)}%`;
}

/** One capture in a sentence: "12% of the page changed, around the Checkout button". */
export function describeCapture(c: VisualCapture): string {
  if (c.error) return `Couldn't capture it: ${c.error}`;
  if (c.changed === undefined) return c.isNew ? "A page that wasn't captured before" : "Nothing to compare with yet";
  if (!c.changed) return "Looks the same";
  const share = `${formatRatio(c.ratio ?? 0)} of the page changed`;
  if (!c.box) return share;
  const region = describeRegion(c.box, c.width, c.height);
  return `${share}, ${c.label && region !== "across most of the page" ? `around ${c.label}` : region}`;
}

/** A commit's captures in one line, for the CLI and agents. */
export function describeVisualCommit(e: VisualCommit): string {
  const ok = e.captures.filter((c) => !c.error);
  if (!ok.length) return "No page could be captured";
  if (e.changed === undefined) return `${ok.length} page${ok.length === 1 ? "" : "s"} captured, nothing to compare with yet`;
  if (!e.changed) return `Looks the same (${ok.length} page${ok.length === 1 ? "" : "s"})`;
  const changed = ok.filter((c) => c.changed);
  return `${changed.length} of ${ok.length} page${ok.length === 1 ? "" : "s"} changed: ${changed.map((c) => `${c.path} (${describeCapture(c)})`).join("; ")}`;
}

/**
 * The file behind one image, checked against the index: a hex commit that was captured, a capture
 * name that commit has, and a kind (the screenshot, its diff, or the commit's thumbnail). The path
 * is built here, never taken from a request.
 */
export function visualImageFile(dir: string, commit: unknown, name: unknown, kind: unknown = "shot"): string {
  if (!isCommitHash(commit)) throw new VisualError(400, "A commit is 4 to 64 hex characters.");
  if (kind !== "shot" && kind !== "diff" && kind !== "thumb") throw new VisualError(400, "The kind is shot, diff or thumb.");
  const index = readVisualIndex(dir);
  const matches = index.commits.filter((c) => c.commit === commit || (commit.length >= 7 && c.commit.startsWith(commit)));
  if (matches.length !== 1) throw new VisualError(404, "That commit has no captures.");
  const entry = matches[0];
  let file: string;
  if (kind === "thumb") {
    if (!entry.thumb) throw new VisualError(404, "That commit has no thumbnail.");
    file = "thumb.png";
  } else {
    if (!isCaptureName(name)) throw new VisualError(400, "Unknown capture name.");
    const cap = entry.captures.find((c) => c.name === name && !c.error);
    if (!cap) throw new VisualError(404, "That commit has no capture by that name.");
    if (kind === "diff" && !cap.diff) throw new VisualError(404, "That capture didn't change, so it has no diff.");
    file = kind === "diff" ? `${name}.diff.png` : `${name}.png`;
  }
  const folder = path.resolve(visualFolder(dir));
  const full = path.resolve(folder, entry.commit, file);
  if (!full.startsWith(folder + path.sep) || !fs.existsSync(full)) throw new VisualError(404, "The image isn't there any more.");
  return full;
}

export async function headCommit(dir: string): Promise<string | undefined> {
  const r = await gitRun(dir, ["rev-parse", "--verify", "--quiet", "HEAD"], { timeoutMs: 10_000 });
  const hash = r.stdout.trim().toLowerCase();
  return r.code === 0 && isCommitHash(hash) ? hash : undefined;
}

async function commitInfo(dir: string, commit: string): Promise<{ parent?: string; subject?: string }> {
  const r = await gitRun(dir, ["log", "-1", "--format=%P%x00%s", commit, "--"], { timeoutMs: 10_000 });
  if (r.code !== 0) return {};
  const [parents, subject] = r.stdout.replace(/\r?\n$/, "").split("\0");
  const parent = parents.split(" ")[0]?.toLowerCase();
  return { parent: isCommitHash(parent) ? parent : undefined, subject: subject || undefined };
}

export interface VisualCaptureOptions {
  dir: string;
  project: string;
  /** The dev server's own address on this computer: http://localhost:5173. */
  baseUrl: string;
  /** Default: HEAD. */
  commit?: string;
  /** Default: the most visited pages of the last day, else "/". */
  paths?: string[];
  /** Default: desktop. */
  viewports?: VisualViewport[];
  keep?: number;
  reason?: string;
  /** How long to wait after load for late requests (default 1s). */
  settleMs?: number;
}

/** Turns animations and transitions off and hides the caret, before the page's own scripts run. */
const FREEZE = `(() => {
  const css = "*,*::before,*::after{animation-delay:-1ms!important;animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}";
  const add = () => { if (document.querySelector("style[data-dx-visual]")) return; const s = document.createElement("style"); s.setAttribute("data-dx-visual", ""); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
  if (document.documentElement) add(); else document.addEventListener("DOMContentLoaded", add, { once: true });
  window.__dxVisualFreeze = add;
})()`;

/** After load: the freeze again (a framework may have replaced <head>), fonts, animations done, top of the page. */
const SETTLE = `(async () => {
  if (window.__dxVisualFreeze) window.__dxVisualFreeze();
  try { await document.fonts.ready; } catch {}
  for (const a of document.getAnimations ? document.getAnimations() : []) { try { a.finish(); } catch { try { a.cancel(); } catch {} } }
  window.scrollTo(0, 0);
  if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
})()`;

/** Runs in the app's page: what's at the middle of the change, named the way a person would. */
const LABEL_AT = `((x, y) => {
  const KIND = { BUTTON: "button", A: "link", H1: "heading", H2: "heading", H3: "heading", H4: "heading", INPUT: "field", SELECT: "field", TEXTAREA: "field", LABEL: "label", NAV: "navigation", HEADER: "header", FOOTER: "footer", IMG: "image", FORM: "form", TABLE: "table", ASIDE: "sidebar", DIALOG: "dialog" };
  const ROLES = { button: "button", link: "link", heading: "heading", navigation: "navigation", dialog: "dialog", tab: "tab", banner: "header" };
  const nameOf = (e) => {
    const aria = e.getAttribute("aria-label") || (e.tagName === "IMG" ? e.getAttribute("alt") : "") || e.getAttribute("placeholder") || "";
    if (aria) return aria.trim();
    const t = (e.innerText || e.value || "").trim().replace(/\\s+/g, " ");
    return t && t.length <= 40 ? t : "";
  };
  let e = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, x)), Math.max(0, Math.min(innerHeight - 1, y)));
  for (let i = 0; e && e !== document.body && e !== document.documentElement && i < 8; e = e.parentElement, i++) {
    const kind = KIND[e.tagName] || ROLES[e.getAttribute("role") || ""];
    if (!kind) continue;
    const n = nameOf(e);
    return (n ? "the " + n + " " + kind : "the " + kind).slice(0, 80);
  }
  return "";
})`;

/** Runs in the blank page: both images on canvases, compared by diffPixels, and the diff picture. */
const COMPARE = `(async (before, after, tol) => {
  const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("An image didn't decode.")); i.src = "data:image/png;base64," + src; });
  const [ia, ib] = await Promise.all([load(before), load(after)]);
  const w = Math.max(ia.width, ib.width), h = Math.max(ia.height, ib.height);
  const pixels = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
  const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  const out = ctx.createImageData(w, h);
  const r = (${diffPixels.toString()})(pixels(ia), pixels(ib), out.data, w, h, tol);
  let diff = "";
  if (r.count) { ctx.putImageData(out, 0, 0); diff = canvas.toDataURL("image/png").slice(22); }
  return { width: w, height: h, count: r.count, box: r.box, diff };
})`;

const THUMB = `(async (src, width) => {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("An image didn't decode.")); i.src = "data:image/png;base64," + src; });
  const c = document.createElement("canvas"); c.width = width; c.height = Math.round(img.height * width / img.width);
  const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/png").slice(22);
})`;

interface Compared {
  width: number;
  height: number;
  count: number;
  box?: VisualBox;
  diff: string;
}

/** Compares two PNGs (base64) in a blank page of a headless browser. */
export async function compareInBrowser(page: BrowserPage, before: string, after: string, tol = VISUAL_TOLERANCE): Promise<Compared> {
  const r = await page.evaluate<Compared>(`${COMPARE}(${JSON.stringify(before)}, ${JSON.stringify(after)}, ${tol})`, 60_000);
  if (!r) throw new Error("The browser couldn't compare the images.");
  return r;
}

/**
 * Screenshots a project's pages for a commit and compares them with the commit before's. Throws
 * when no browser is found or the address isn't the dev server's own on this computer; a page that
 * can't be loaded is kept with its error.
 */
export async function captureVisual(o: VisualCaptureOptions): Promise<VisualCommit> {
  if (!isLoopbackUrl(o.baseUrl)) throw new VisualError(400, "Only a dev server on this computer can be captured.");
  if (!findBrowser()) throw new VisualError(503, "No Chrome, Edge, Chromium or Brave was found to take the screenshots.");
  const commit = o.commit ? o.commit.toLowerCase() : await headCommit(o.dir);
  if (!isCommitHash(commit)) throw new VisualError(400, "Which commit? The project has no commits yet.");
  const base = new URL(o.baseUrl);
  const { parent, subject } = await commitInfo(o.dir, commit);
  const index = readVisualIndex(o.dir);
  const usable = (c: VisualCommit) => c.commit !== commit && c.captures.some((x) => !x.error);
  const ref = index.commits.find((c) => c.commit === parent && usable(c)) ?? index.commits.find(usable);
  const wanted = (o.paths?.length ? o.paths : topVisitedPaths(o.dir)).map((p) => (p.startsWith("/") ? p : `/${p}`));
  const paths = [...new Set(wanted.length ? wanted : ["/"])].slice(0, 8);
  const viewports = o.viewports?.length ? [...new Set(o.viewports)] : (["desktop"] as VisualViewport[]);

  const folder = visualFolder(o.dir);
  fs.mkdirSync(folder, { recursive: true });
  const work = path.join(folder, `${commit}.tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  const entry: VisualCommit = { commit, at: new Date().toISOString(), subject, against: ref?.commit, reason: o.reason, baseUrl: base.origin, captures: [] };

  try {
    await withBrowser(async (session) => {
      entry.browser = session.browser;
      const app = await session.newPage();
      const blank = await session.newPage();
      // The app's own CSP may not allow the style that turns animations off; this is its own dev server.
      await app.send("Page.setBypassCSP", { enabled: true });
      await app.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await app.send("Page.addScriptToEvaluateOnNewDocument", { source: FREEZE });
      for (const viewport of viewports) {
        const vp = VISUAL_VIEWPORTS[viewport];
        await app.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
        for (const { path: p, name } of captureNames(paths, viewport)) {
          const cap: VisualCapture = { name, path: p, viewport, width: vp.width, height: vp.height };
          entry.captures.push(cap);
          try {
            const url = new URL(p, base);
            if (url.origin !== base.origin || !isLoopbackUrl(url.href)) throw new Error("Only pages of the dev server itself are captured.");
            await app.send("Page.bringToFront");
            cap.status = await app.navigate(url.href, { settleMs: o.settleMs ?? 1000 });
            await app.evaluate(SETTLE, 15_000);
            const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
            fs.writeFileSync(path.join(work, `${name}.png`), Buffer.from(shot.data, "base64"));
            const prev = ref?.captures.find((c) => c.name === name && !c.error);
            if (!prev) {
              if (ref) cap.isNew = true;
              continue;
            }
            const before = fs.readFileSync(path.join(folder, ref!.commit, `${name}.png`)).toString("base64");
            await blank.send("Page.bringToFront");
            const r = await compareInBrowser(blank, before, shot.data);
            cap.ratio = r.count / Math.max(1, r.width * r.height);
            cap.changed = r.count >= VISUAL_MIN_PIXELS;
            if (cap.changed && r.box) {
              cap.box = r.box;
              if (r.diff) {
                fs.writeFileSync(path.join(work, `${name}.diff.png`), Buffer.from(r.diff, "base64"));
                cap.diff = true;
              }
              await app.send("Page.bringToFront");
              const label = await app.evaluate<string>(`${LABEL_AT}(${r.box.x + r.box.width / 2}, ${r.box.y + r.box.height / 2})`, 5000);
              if (label) cap.label = label;
            }
          } catch (err) {
            cap.error = (err as Error).message.split("\n")[0].slice(0, 300);
          }
        }
      }
      const first = entry.captures.find((c) => !c.error);
      if (first) {
        try {
          await blank.send("Page.bringToFront");
          const thumb = await blank.evaluate<string>(`${THUMB}(${JSON.stringify(fs.readFileSync(path.join(work, `${first.name}.png`)).toString("base64"))}, 240)`, 30_000);
          if (thumb) {
            fs.writeFileSync(path.join(work, "thumb.png"), Buffer.from(thumb, "base64"));
            entry.thumb = true;
          }
        } catch {
          // the graph shows an icon instead
        }
      }
    }, VISUAL_VIEWPORTS[viewports[0]]);
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true });
    throw err;
  }

  const compared = entry.captures.filter((c) => c.changed !== undefined);
  if (compared.length) {
    entry.changed = compared.some((c) => c.changed);
    entry.ratio = Math.max(...compared.map((c) => c.ratio ?? 0));
  }
  // Swap the new captures in, then keep the newest few.
  const dest = path.join(folder, commit);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(work, dest);
  const fresh = readVisualIndex(o.dir);
  const { index: next } = addToVisualIndex({ ...fresh, dir: o.dir, project: o.project }, entry, o.keep ?? VISUAL_KEEP);
  writeVisualIndex(o.dir, next);
  pruneVisualFolders(o.dir, next);
  return entry;
}
