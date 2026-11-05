import { isLoopbackUrl, withBrowser, type PageStep } from "./browser.js";
import { applyEmulation, PHONE, type Emulation } from "./emulation.js";

/**
 * Gremlins: a headless browser goes through an app on this computer by itself, the way an
 * impatient and careless person would: clicking whatever it finds, typing nonsense into fields,
 * double-clicking submit, pressing Enter, going back halfway. Seeded, so the same run does the
 * same things; every problem comes with the steps that led to it, as a page check can replay
 * them. Only pages on this computer; it goes back to the start when a link leads elsewhere.
 */

export interface GremlinOptions {
  /** Where to start: an address on this computer (the project's .localhost address, so it's recorded). */
  url: string;
  /** How many things to do (default 40, at most 300). */
  actions?: number;
  seed?: number;
  emulate?: Emulation;
  /** Also click controls that look destructive (delete, sign out, reset…). Off by default: they'd wipe the data the rest of the run needs. */
  bold?: boolean;
  /** Called after each action, for progress. */
  progress?: (done: number, total: number, step: PageStep) => void;
  /** Stop early. */
  signal?: AbortSignal;
}

export type GremlinKind = "exception" | "console" | "server" | "network" | "blank" | "overlay";

export interface GremlinFinding {
  kind: GremlinKind;
  text: string;
  /** Which action it came after (1 is the first). */
  step: number;
  /** The page it was on. */
  url?: string;
  /** How many times it came up. */
  count: number;
  /** The steps from the start up to and including the one that caused it. */
  steps: PageStep[];
}

export interface GremlinRun {
  url: string;
  seed: number;
  browser: string;
  actions: number;
  steps: PageStep[];
  findings: GremlinFinding[];
  /** Controls left alone because they look destructive. */
  skipped: string[];
  /** Pages it went through. */
  pages: string[];
  ms: number;
  stopped?: boolean;
}

/** Text no form expects. */
export const JUNK = [
  "",
  "   ",
  "x".repeat(5000),
  "😀🎉👍🏽 ñ ü 中文 العربية",
  "<script>alert(1)</script>",
  "'; DROP TABLE users; --",
  "-1",
  "0",
  "99999999999999999999",
  "3.14159",
  "NaN",
  "null",
  "undefined",
  "2026-02-30",
  "not-an-email",
  "a@b",
  "../../etc/passwd",
  "%s%s%s%n",
  "{{7*7}}",
  "‮reversed",
];

const DESTRUCTIVE = /\b(delete|remove|destroy|erase|drop|reset|wipe|clear all|log ?out|sign ?out|deactivate|unsubscribe|close (my )?account|uninstall)\b/i;

/** A small seeded random number generator (mulberry32): the same seed gives the same run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Candidate {
  target: string;
  kind: "click" | "submit" | "field";
  label: string;
}

// Runs in the page: what can be clicked or typed into, each with a way to find it again
// (data-testid, a unique id or name, its text, its aria-label, or its place in the page).
const CANDIDATES = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && r.bottom > 0 && r.right > 0; };
  const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
  const sel = (e) => {
    const t = e.getAttribute("data-testid");
    if (t && unique("[data-testid=" + JSON.stringify(t) + "]")) return "[data-testid=" + JSON.stringify(t) + "]";
    if (e.id && unique("#" + CSS.escape(e.id))) return "#" + CSS.escape(e.id);
    const name = e.getAttribute("name");
    if (name) { const s = e.tagName.toLowerCase() + "[name=" + JSON.stringify(name) + "]"; if (unique(s)) return s; }
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName);
    const label = (e.innerText || "").trim().replace(/\\s+/g, " ");
    if (!field && label && label.length <= 40) return "text=" + label;
    const aria = e.getAttribute("aria-label");
    if (aria) { const s = "[aria-label=" + JSON.stringify(aria) + "]"; if (unique(s)) return s; }
    const parts = [];
    let n = e;
    while (n && n !== document.body && parts.length < 10) {
      let i = 1, s = n;
      while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
      n = n.parentElement;
    }
    return "body > " + parts.join(" > ");
  };
  const out = [];
  for (const e of document.querySelectorAll("button, a[href], [role=button], [role=tab], [role=menuitem], [role=link], [role=checkbox], [role=switch], input[type=submit], input[type=button], input[type=checkbox], input[type=radio], select, summary, [onclick]")) {
    if (out.length >= 150) break;
    if (!vis(e) || e.disabled || e.getAttribute("aria-disabled") === "true") continue;
    if (e.tagName === "A") {
      const href = e.getAttribute("href") || "";
      if (/^(mailto|tel|javascript|data|blob):/i.test(href) || e.target === "_blank" || e.hasAttribute("download")) continue;
      try { if (new URL(e.href, location.href).origin !== location.origin) continue; } catch { continue; }
    }
    const submit = (e.tagName === "INPUT" && e.type === "submit") || (e.tagName === "BUTTON" && !!e.form && (e.getAttribute("type") || "submit") === "submit");
    out.push({ target: sel(e), kind: submit ? "submit" : "click", label: (e.innerText || e.value || e.getAttribute("aria-label") || e.getAttribute("title") || "").trim().replace(/\\s+/g, " ").slice(0, 60) });
  }
  for (const e of document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=color]), textarea, [contenteditable=true], [contenteditable=\\"\\"]")) {
    if (out.length >= 200) break;
    if (!vis(e) || e.disabled || e.readOnly) continue;
    out.push({ target: sel(e), kind: "field", label: (e.getAttribute("aria-label") || e.placeholder || e.name || e.id || "").slice(0, 60) });
  }
  return out;
})()`;

const BLANK = `(() => {
  if (!document.body || (document.body.innerText || "").trim()) return false;
  for (const e of document.body.querySelectorAll("img, svg, canvas, video, iframe, input, button, select, textarea, vite-error-overlay, nextjs-portal")) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return false; }
  return true;
})()`;

const OVERLAY = `(() => {
  const v = document.querySelector("vite-error-overlay");
  if (v && v.shadowRoot) return v.shadowRoot.textContent.replace(/\\s+/g, " ").trim().slice(0, 500);
  const n = document.querySelector("nextjs-portal");
  const d = n && n.shadowRoot && n.shadowRoot.querySelector("[data-nextjs-dialog], [data-nextjs-error-overlay]");
  if (d) return d.textContent.replace(/\\s+/g, " ").trim().slice(0, 500);
  const w = document.getElementById("webpack-dev-server-client-overlay");
  return w && w.contentDocument ? w.contentDocument.body.innerText.slice(0, 500) : "";
})()`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n)}…` : s);
const shape = (s: string) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 200);

export async function runGremlins(options: GremlinOptions): Promise<GremlinRun> {
  if (!isLoopbackUrl(options.url)) throw new Error("Gremlins only run on pages on this computer (localhost, 127.0.0.1, *.localhost).");
  const total = Math.max(1, Math.min(300, Math.round(options.actions ?? 40)));
  const seed = options.seed ?? Math.floor(Math.random() * 9000) + 1000;
  const random = seeded(seed);
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];
  const started = Date.now();
  const phone = !!options.emulate?.phone;
  return withBrowser(
    async (session) => {
      const page = await session.newPage();
      const run: GremlinRun = { url: options.url, seed, browser: session.browser, actions: 0, steps: [], findings: [], skipped: [], pages: [], ms: 0 };
      const found = new Map<string, GremlinFinding>();
      /** The action being carried out now: a problem it causes counts it among its steps. */
      let current: PageStep | undefined;
      let inflight = 0;
      let lastNetwork = Date.now();
      const requests = new Map<string, { url: string; method: string; type?: string }>();
      const note = (kind: GremlinKind, text: string, url?: string) => {
        const key = `${kind} ${shape(text)}`;
        const f = found.get(key);
        if (f) return void f.count++;
        if (found.size >= 100) return;
        const steps = [...run.steps, ...(current ? [current] : [])];
        found.set(key, { kind, text: clip(text), step: steps.length, url, count: 1, steps: steps.map((s) => ({ ...s })) });
      };
      page.onEvent((method, p) => {
        if (method === "Runtime.exceptionThrown") {
          const d = p.exceptionDetails as { text?: string; url?: string; exception?: { description?: string } };
          note("exception", d.exception?.description?.split("\n")[0] ?? d.text ?? "Uncaught exception", d.url);
        } else if (method === "Runtime.consoleAPICalled" && p.type === "error") {
          const args = (p.args as Array<{ value?: unknown; description?: string }>).map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ");
          if (!/\[dx\]/.test(args)) note("console", args.split("\n")[0]);
        } else if (method === "Network.requestWillBeSent") {
          const r = p.request as { url: string; method: string };
          if (!requests.has(p.requestId as string)) inflight++;
          requests.set(p.requestId as string, { url: r.url, method: r.method, type: p.type as string | undefined });
          lastNetwork = Date.now();
        } else if (method === "Network.responseReceived") {
          const r = p.response as { status: number; url: string };
          const req = requests.get(p.requestId as string);
          if (r.status >= 500) note("server", `${req?.method ?? "GET"} ${new URL(r.url).pathname} → ${r.status}`, r.url);
        } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
          const req = requests.get(p.requestId as string);
          if (requests.delete(p.requestId as string)) inflight = Math.max(0, inflight - 1);
          lastNetwork = Date.now();
          if (method === "Network.loadingFailed" && !p.canceled && p.errorText !== "net::ERR_ABORTED" && req && /^(XHR|Fetch)$/.test(String(req.type))) {
            note("network", `${req.method} ${new URL(req.url).pathname} failed (${p.errorText as string})`, req.url);
          }
        }
      });
      await page.send("Log.enable").catch(() => undefined);
      if (options.emulate) await applyEmulation((m, p) => page.send(m, p), options.emulate);
      const idle = async (max: number) => {
        const end = Date.now() + max;
        await sleep(150);
        while (Date.now() < end && (inflight > 0 || Date.now() - lastNetwork < 300)) await sleep(100);
      };
      await page.navigate(options.url, { timeoutMs: 45_000, settleMs: 1000 });

      const click = async (target: string, double = false) => {
        const box = await page.evaluate<{ x: number; y: number } | null>(
          `(() => { const el = (${FIND_LITE})(${JSON.stringify(target)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
        );
        if (!box) return false;
        if (phone) {
          await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
          await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        }
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
        if (double) for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 2 });
        return true;
      };
      const press = async (key: "Enter" | "Escape") => {
        const k = key === "Enter" ? { key, code: key, windowsVirtualKeyCode: 13, text: "\r" } : { key, code: key, windowsVirtualKeyCode: 27 };
        await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
      };

      for (let i = 0; i < total; i++) {
        if (options.signal?.aborted) {
          run.stopped = true;
          break;
        }
        const href = (await page.evaluate<string>("location.href").catch(() => undefined)) ?? "";
        if (href && !run.pages.includes(href.split("#")[0]) && run.pages.length < 100) run.pages.push(href.split("#")[0]);
        if (!href || !isLoopbackUrl(href)) {
          // Wandered off this computer (or the tab is gone): back to the start.
          await page.navigate(options.url, { timeoutMs: 30_000 }).catch(() => undefined);
          run.steps.push({ goto: new URL(options.url).pathname + new URL(options.url).search });
          continue;
        }
        const all = (await page.evaluate<Candidate[]>(CANDIDATES).catch(() => undefined)) ?? [];
        const usable = all.filter((c) => {
          if (options.bold || c.kind === "field" || !DESTRUCTIVE.test(c.label)) return true;
          if (!run.skipped.includes(c.label) && run.skipped.length < 30) run.skipped.push(c.label);
          return false;
        });
        const fields = usable.filter((c) => c.kind === "field");
        const submits = usable.filter((c) => c.kind === "submit");
        const clicks = usable.filter((c) => c.kind !== "field");
        const r = random();
        // Decided first, so a problem the action causes while it runs counts it among its steps.
        let step: PageStep | undefined;
        let field: Candidate | undefined;
        if (r < 0.22 && fields.length) {
          field = pick(fields);
          step = { type: pick(JUNK), into: field.target };
        } else if (r < 0.32 && submits.length) step = { click: pick(submits).target, double: true };
        else if (r < 0.37) step = { press: "Enter" };
        else if (r < 0.42 && run.steps.length) step = { back: true };
        else if (r < 0.45) step = { press: "Escape" };
        else if (clicks.length) step = { click: pick(clicks).target };
        else if (run.steps.length) step = { back: true };
        if (!step) break;
        current = step;
        try {
          if (step.type !== undefined) {
            await page.evaluate(`(() => { const el = (${FIND_LITE})(${JSON.stringify(step.into)}); if (!el) return false; el.focus(); if (el.select) el.select(); return true; })()`);
            await page.send("Input.insertText", { text: step.type });
          } else if (step.click) {
            if (!(await click(step.click, step.double))) {
              current = undefined;
              continue;
            }
          } else if (step.press) await press(step.press as "Enter" | "Escape");
          else if (step.back) await page.evaluate("history.back()");
        } catch {
          current = undefined;
          continue;
        }
        await idle(2500);
        run.steps.push(step);
        current = undefined;
        run.actions++;
        if (await page.evaluate<boolean>(BLANK).catch(() => false)) {
          note("blank", "The page went blank", href);
          await page.navigate(options.url, { timeoutMs: 30_000 }).catch(() => undefined);
          run.steps.push({ goto: new URL(options.url).pathname });
        }
        const overlay = await page.evaluate<string>(OVERLAY).catch(() => "");
        if (overlay) note("overlay", overlay, href);
        options.progress?.(run.actions, total, step);
      }
      run.findings = [...found.values()].sort((a, b) => a.step - b.step);
      run.ms = Date.now() - started;
      return run;
    },
    phone ? { width: PHONE.width, height: PHONE.height } : {},
  );
}

// The same lookup a page check uses: a CSS selector, or "text=…" for buttons and links by their text.
const FIND_LITE = `(sel) => {
  if (!sel.startsWith("text=")) { try { return document.querySelector(sel); } catch { return null; } }
  const want = sel.slice(5).trim().toLowerCase();
  const textOf = (e) => (e.innerText || e.value || e.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").toLowerCase();
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const list = [...document.querySelectorAll("button, a, [role=button], [role=link], [role=tab], [role=menuitem], input[type=submit], input[type=button], label, summary")];
  return list.find((e) => visible(e) && textOf(e) === want) || list.find((e) => visible(e) && textOf(e).includes(want)) || null;
}`;

