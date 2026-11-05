/**
 * Speed and accessibility of a page, measured while the visual diff captures it, so the Git page
 * can mark the commit that made checkout 400 ms slower or broke a label. Speed comes from the
 * browser's own timings (navigation, largest contentful paint, long tasks, layout shift) and the
 * scripts the page loaded; accessibility from a small audit run in the page (no library): images
 * without alt text, fields without labels, buttons and links without names, low contrast, a page
 * without a language, skipped heading levels, positive tabindex and duplicate ids.
 */

export interface PagePerf {
  /** From the start of navigation to the end of the load event. */
  loadMs?: number;
  domContentLoadedMs?: number;
  /** Largest contentful paint. */
  lcpMs?: number;
  /** Total blocking time: the sum of each long task's time over 50 ms. */
  tbtMs?: number;
  /** Cumulative layout shift. */
  cls?: number;
  /** JavaScript the page loaded, bytes over the wire (a dev build, so compare it with other commits, not with production). */
  jsBytes?: number;
  requests?: number;
}

export interface A11yIssue {
  rule: "alt" | "label" | "name" | "contrast" | "lang" | "heading" | "tabindex" | "duplicate-id";
  /** What and where, the way a person would say it: "Image without alt text: hero.png". */
  text: string;
}

/** Runs before the page's own scripts: keeps what the browser reports about paint, long tasks and layout shifts. */
export const PERF_INIT = `(() => {
  const p = (window.__dxPerf = { lcp: 0, tbt: 0, cls: 0 });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) p.lcp = Math.max(p.lcp, e.startTime); }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) p.tbt += Math.max(0, e.duration - 50); }).observe({ type: "longtask", buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) p.cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
})()`;

/** After the page settled: its timings. */
export const PERF_READ = `(() => {
  const n = performance.getEntriesByType("navigation")[0];
  const p = window.__dxPerf || {};
  const r = (x) => (x > 0 ? Math.round(x) : undefined);
  return { loadMs: n ? r(n.loadEventEnd || n.duration) : undefined, domContentLoadedMs: n ? r(n.domContentLoadedEventEnd) : undefined, lcpMs: r(p.lcp), tbtMs: Math.round(p.tbt || 0), cls: Math.round((p.cls || 0) * 1000) / 1000, requests: performance.getEntriesByType("resource").length + 1 };
})()`;

/** Runs in the page: the accessibility problems a person could check by hand, at most 60. */
export const A11Y_AUDIT = `(() => {
  const out = [];
  const add = (rule, text) => { if (out.length < 60) out.push({ rule, text: text.replace(/\\s+/g, " ").slice(0, 160) }); };
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
  const hidden = (e) => !!e.closest("[aria-hidden=true], [hidden]");
  const short = (e) => { const t = (e.innerText || e.value || e.getAttribute("placeholder") || e.getAttribute("name") || e.id || e.getAttribute("src") || "").trim(); return t ? t.slice(0, 50) : "<" + e.tagName.toLowerCase() + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\\s+/)[0] : "") + ">"; };
  const named = (e) => {
    if ((e.getAttribute("aria-label") || "").trim() || e.getAttribute("title")) return true;
    const by = e.getAttribute("aria-labelledby");
    if (by && by.split(/\\s+/).some((id) => (document.getElementById(id)?.textContent || "").trim())) return true;
    if ((e.innerText || e.textContent || "").trim()) return true;
    return [...e.querySelectorAll("img[alt], svg[aria-label], [aria-label]")].some((i) => (i.getAttribute("alt") || i.getAttribute("aria-label") || "").trim());
  };
  if (!document.documentElement.getAttribute("lang")) add("lang", "The page has no language (<html lang>), so screen readers guess how to pronounce it");
  for (const img of document.querySelectorAll("img")) {
    if (hidden(img) || !visible(img) || img.getAttribute("role") === "presentation" || img.hasAttribute("alt")) continue;
    add("alt", "Image without alt text: " + (img.getAttribute("src") || "").split("/").pop().split("?")[0].slice(0, 60));
  }
  for (const f of document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea")) {
    if (hidden(f) || !visible(f)) continue;
    const labelled = (f.id && document.querySelector("label[for=" + JSON.stringify(f.id) + "]")) || f.closest("label") || (f.getAttribute("aria-label") || "").trim() || f.getAttribute("aria-labelledby") || f.getAttribute("title");
    if (!labelled) add("label", "Field without a label" + (f.getAttribute("placeholder") ? " (a placeholder isn't one): " + f.getAttribute("placeholder") : ": " + short(f)));
  }
  for (const b of document.querySelectorAll("button, [role=button], a[href], input[type=submit], input[type=button], input[type=image]")) {
    if (hidden(b) || !visible(b)) continue;
    if (b.tagName === "INPUT" && (b.value || b.getAttribute("alt") || b.getAttribute("aria-label"))) continue;
    if (!named(b)) add("name", (b.tagName === "A" ? "Link" : "Button") + " without a name: " + (b.getAttribute("href") || "<" + b.tagName.toLowerCase() + (b.className && typeof b.className === "string" ? "." + b.className.trim().split(/\\s+/)[0] : "") + ">"));
  }
  let last = 0;
  for (const h of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (!visible(h)) continue;
    const n = Number(h.tagName[1]);
    if (last && n > last + 1) add("heading", "Heading levels skip from h" + last + " to h" + n + ": " + short(h));
    last = n;
  }
  for (const e of document.querySelectorAll("[tabindex]")) if (Number(e.getAttribute("tabindex")) > 0 && visible(e)) add("tabindex", "tabindex=" + e.getAttribute("tabindex") + " changes the tab order: " + short(e));
  const ids = {};
  for (const e of document.querySelectorAll("[id]")) ids[e.id] = (ids[e.id] || 0) + 1;
  for (const [id, n] of Object.entries(ids)) if (n > 1 && id) add("duplicate-id", "The id \\"" + id.slice(0, 40) + "\\" is used " + n + " times; labels and aria references find only the first");
  // Contrast of text against the first solid background behind it (WCAG: 4.5:1, 3:1 for large text).
  const rgb = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
  const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (e) => { for (let n = e; n; n = n.parentElement) { const s = getComputedStyle(n); if (s.backgroundImage && s.backgroundImage !== "none") return null; const c = rgb(s.backgroundColor); if (c && c.a >= 0.95) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const seen = new Set();
  let checked = 0;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t && checked < 400; t = walker.nextNode()) {
    const text = t.textContent.trim();
    const e = t.parentElement;
    if (!text || !e || seen.has(e) || hidden(e) || !visible(e) || /^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(e.tagName)) continue;
    seen.add(e);
    checked++;
    const s = getComputedStyle(e);
    const fg = rgb(s.color);
    const bg = bgOf(e);
    if (!fg || !bg || fg.a < 0.95) continue;
    const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) add("contrast", "Low contrast " + ratio.toFixed(1) + ":1 (needs " + (large ? "3" : "4.5") + "): \\"" + text.slice(0, 40) + "\\"");
  }
  return out;
})()`;

const rel = (now?: number, before?: number) => now !== undefined && before !== undefined && before > 0;

/** "Slower: largest paint 1.2 s → 1.7 s" when a page got clearly slower; dev servers are noisy, so small moves don't count. */
export function slowerThan(now: PagePerf | undefined, before: PagePerf | undefined): string | undefined {
  if (!now || !before) return undefined;
  const out: string[] = [];
  const time = (label: string, a?: number, b?: number, min = 300) => {
    if (rel(a, b) && a! - b! >= min && a! >= b! * 1.3) out.push(`${label} ${fmtMs(b!)} → ${fmtMs(a!)}`);
  };
  time("largest paint", now.lcpMs, before.lcpMs);
  if (!out.length) time("load", now.loadMs, before.loadMs);
  if (now.tbtMs !== undefined && before.tbtMs !== undefined && now.tbtMs - before.tbtMs >= 200) out.push(`main thread blocked ${fmtMs(before.tbtMs)} → ${fmtMs(now.tbtMs)}`);
  if (now.cls !== undefined && before.cls !== undefined && now.cls - before.cls >= 0.1) out.push(`layout shift ${before.cls} → ${now.cls}`);
  return out.length ? out.join(", ") : undefined;
}

/** "JavaScript 412 KB → 498 KB" when the page loads clearly more script. */
export function heavierThan(now: PagePerf | undefined, before: PagePerf | undefined): string | undefined {
  if (!now?.jsBytes || !before?.jsBytes) return undefined;
  const d = now.jsBytes - before.jsBytes;
  return d >= 20 * 1024 && now.jsBytes >= before.jsBytes * 1.1 ? `JavaScript ${fmtKb(before.jsBytes)} → ${fmtKb(now.jsBytes)}` : undefined;
}

/** Issues in `now` that `before` didn't have, by rule and text. */
export function newIssues(now: A11yIssue[] | undefined, before: A11yIssue[] | undefined): A11yIssue[] {
  if (!now || !before) return [];
  const had = new Set(before.map((i) => `${i.rule} ${i.text}`));
  return now.filter((i) => !had.has(`${i.rule} ${i.text}`));
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function fmtKb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
