import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dxPath } from "../config.js";

/**
 * Loads a page in a headless Chrome, Edge, Chromium or Brave already on this computer and reports
 * what went wrong in the browser: console errors, uncaught exceptions, failed requests and a
 * framework error overlay. It talks to the browser over the DevTools protocol with Node's own
 * WebSocket, so nothing is installed.
 */

export interface BrowserMessage {
  text: string;
  /** Where it came from: a script URL with its line. */
  source?: string;
  /** The step it happened in (1-based); absent for the first page load. */
  step?: number;
}

export interface FailedRequest {
  url: string;
  method?: string;
  status?: number;
  /** Why it failed without a response: net::ERR_CONNECTION_REFUSED, … */
  error?: string;
  type?: string;
  step?: number;
}

export interface PageCheck {
  url: string;
  /** Loaded with no exceptions, console errors, failed requests or error overlay. */
  ok: boolean;
  /** The main document's HTTP status. */
  status?: number;
  title?: string;
  /** The page's visible text, shortened. */
  text?: string;
  ms: number;
  /** Why the page couldn't be loaded at all. */
  error?: string;
  exceptions: BrowserMessage[];
  consoleErrors: BrowserMessage[];
  consoleWarnings: BrowserMessage[];
  failedRequests: FailedRequest[];
  /** The text of a dev server's error overlay (Vite, Next.js, webpack), when one is showing. */
  overlay?: string;
  /** A PNG of the page, when asked for. */
  screenshot?: string;
  /** Which browser ran it. */
  browser: string;
  /** What each step did, when steps were given. */
  steps?: StepResult[];
  /** The address the page ended on, after steps. */
  finalUrl?: string;
}

/**
 * One thing to do on the page, like a person would. Elements are found by CSS selector, or by
 * their text with "text=Sign in" (buttons and links first).
 */
export interface PageStep {
  /** Go to a path on the same site, or another address on this computer. */
  goto?: string;
  /** Click an element. */
  click?: string;
  /** Type this text… */
  type?: string;
  /** …into this field (otherwise into the focused one). */
  into?: string;
  /** Press a key: Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp. */
  press?: string;
  /** Wait until an element shows, its text shows ("text=Order placed"), or the address contains something ("url=/dashboard"). */
  waitFor?: string;
  /** Take a screenshot after this step. */
  screenshot?: boolean;
  /** How long this step may take (default 10s). */
  timeoutMs?: number;
}

export interface StepResult {
  index: number;
  /** "click text=Sign in", in words. */
  action: string;
  ok: boolean;
  error?: string;
  /** Where the page was after the step. */
  url?: string;
  ms: number;
  /** Exceptions, console errors and failed requests that happened during this step. */
  problems: number;
  screenshot?: string;
}

export interface PageCheckOptions {
  url: string;
  /** Things to do after the page loads: fill a form, click through a flow. */
  steps?: PageStep[];
  /** Take a screenshot and save it under ~/.dx/screenshots. */
  screenshot?: boolean;
  width?: number;
  height?: number;
  /** Give up loading after this long (default 30s). */
  timeoutMs?: number;
  /** How long to keep listening after the page has loaded, for errors that come late (default 1.5s). */
  settleMs?: number;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|[\w.-]+\.localhost)$/i;

/** Only http(s) addresses on this computer: localhost, 127.x, [::1] and *.localhost. */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.test(u.hostname);
  } catch {
    return false;
  }
}

export interface FoundBrowser {
  name: string;
  path: string;
}

/** The first Chromium-based browser installed here. DX_BROWSER points at another one. */
export function findBrowser(): FoundBrowser | undefined {
  const override = process.env.DX_BROWSER || process.env.CHROME_PATH;
  if (override && fs.existsSync(override)) return { name: path.basename(override), path: override };
  for (const [name, file] of browserCandidates()) {
    if (path.isAbsolute(file)) {
      if (fs.existsSync(file)) return { name, path: file };
    } else {
      const r = spawnSync("which", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const found = r.status === 0 ? r.stdout.trim().split("\n")[0] : "";
      if (found) return { name, path: found };
    }
  }
  return undefined;
}

function browserCandidates(): [string, string][] {
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    const rel: [string, string][] = [
      ["Chrome", "Google\\Chrome\\Application\\chrome.exe"],
      ["Edge", "Microsoft\\Edge\\Application\\msedge.exe"],
      ["Brave", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
      ["Chromium", "Chromium\\Application\\chrome.exe"],
    ];
    return rel.flatMap(([name, r]) => roots.map((root) => [name, path.join(root, r)] as [string, string]));
  }
  if (process.platform === "darwin") {
    const apps: [string, string][] = [
      ["Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"],
      ["Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      ["Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"],
      ["Chromium", "Chromium.app/Contents/MacOS/Chromium"],
    ];
    return apps.flatMap(([name, a]) => [
      [name, path.join("/Applications", a)] as [string, string],
      [name, path.join(os.homedir(), "Applications", a)] as [string, string],
    ]);
  }
  return [
    ["Chrome", "google-chrome"],
    ["Chrome", "google-chrome-stable"],
    ["Chromium", "chromium"],
    ["Chromium", "chromium-browser"],
    ["Edge", "microsoft-edge"],
    ["Brave", "brave-browser"],
  ];
}

/** How to install a browser dx can use, for `dx doctor`. */
export function browserInstallFix(): string {
  if (process.platform === "win32") return "winget install Google.Chrome (Edge, which comes with Windows, works too)";
  if (process.platform === "darwin") return "brew install --cask google-chrome";
  return "sudo apt install -y chromium   (Fedora: sudo dnf install -y chromium; Arch: sudo pacman -S chromium)";
}

const MAX_ITEMS = 40;
const MAX_TEXT = 1500;

export async function checkPage(options: PageCheckOptions): Promise<PageCheck> {
  if (!isLoopbackUrl(options.url)) throw new Error("Only pages on this computer (localhost, 127.0.0.1, *.localhost) can be checked.");
  const found = findBrowser();
  if (!found) throw new Error(`No Chrome, Edge, Chromium or Brave was found to load the page in. Install one: ${browserInstallFix()}`);

  const result: PageCheck = {
    url: options.url,
    ok: false,
    ms: 0,
    browser: found.name,
    exceptions: [],
    consoleErrors: [],
    consoleWarnings: [],
    failedRequests: [],
  };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const started = Date.now();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dx-browser-"));
  let proc: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    // Some systems (newer Ubuntu, containers) don't let Chrome set up its sandbox; it quits at once
    // saying so. The page is on this computer and a dev server's own, so run it without one then.
    let launched: { proc: ChildProcess; ws: string };
    try {
      launched = await launch(found.path, profile, options.width ?? 1280, options.height ?? 800, false);
    } catch (err) {
      if (!/sandbox/i.test((err as Error).message)) throw err;
      launched = await launch(found.path, profile, options.width ?? 1280, options.height ?? 800, true);
    }
    proc = launched.proc;
    cdp = await Cdp.connect(launched.ws);
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const page = (method: string, params: object = {}) => cdp!.send(method, params, sessionId);

    const requests = new Map<string, { url: string; method: string; type?: string }>();
    let inflight = 0;
    let lastNetwork = Date.now();
    let loaded = false;
    let loading = false;
    let documentStatus: number | undefined;
    let step = 0;
    let problems = 0;
    const push = <T extends object>(list: T[], item: T) => {
      if (list === (result.exceptions as unknown) || list === (result.consoleErrors as unknown) || list === (result.failedRequests as unknown)) problems++;
      if (list.length < MAX_ITEMS) list.push(step ? { ...item, step } : item);
    };

    cdp.on(sessionId, (method, p) => {
      switch (method) {
        case "Runtime.exceptionThrown": {
          const d = p.exceptionDetails as ExceptionDetails;
          push(result.exceptions, { text: clip(d.exception?.description ?? d.text ?? "Uncaught exception"), source: where(d.url, d.lineNumber, d.stackTrace) });
          break;
        }
        case "Runtime.consoleAPICalled": {
          const type = p.type as string;
          if (type !== "error" && type !== "warning" && type !== "assert") break;
          const args = (p.args as RemoteObject[]).map(remoteText).join(" ");
          const msg = { text: clip(args), source: where(undefined, undefined, p.stackTrace as StackTrace) };
          push(type === "warning" ? result.consoleWarnings : result.consoleErrors, msg);
          break;
        }
        case "Log.entryAdded": {
          const e = p.entry as { level: string; text: string; source: string; url?: string; lineNumber?: number };
          // Network failures are reported from the Network events, with their status.
          if (e.source === "network" || (e.level !== "error" && e.level !== "warning")) break;
          push(e.level === "error" ? result.consoleErrors : result.consoleWarnings, { text: clip(e.text), source: where(e.url, e.lineNumber) });
          break;
        }
        case "Network.requestWillBeSent": {
          const r = p.request as { url: string; method: string };
          if (!requests.has(p.requestId as string)) inflight++;
          requests.set(p.requestId as string, { url: r.url, method: r.method, type: p.type as string | undefined });
          lastNetwork = Date.now();
          break;
        }
        case "Network.responseReceived": {
          const r = p.response as { status: number; url: string };
          if (p.type === "Document" && documentStatus === undefined) documentStatus = r.status;
          // The browser asks for /favicon.ico by itself; a missing one isn't the page's fault.
          if (r.status >= 400 && !(p.type === "Other" && new URL(r.url).pathname === "/favicon.ico")) {
            const req = requests.get(p.requestId as string);
            push(result.failedRequests, { url: r.url, method: req?.method, status: r.status, type: p.type as string | undefined });
          }
          break;
        }
        case "Network.loadingFinished":
        case "Network.loadingFailed": {
          const req = requests.get(p.requestId as string);
          if (requests.delete(p.requestId as string)) inflight = Math.max(0, inflight - 1);
          lastNetwork = Date.now();
          if (method === "Network.loadingFailed") {
            const text = p.errorText as string;
            if (p.canceled || text === "net::ERR_ABORTED") break;
            push(result.failedRequests, { url: req?.url ?? "", method: req?.method, error: text, type: p.type as string | undefined });
          }
          break;
        }
        case "Page.frameStartedLoading":
          // The main frame's id is the target's id.
          if (p.frameId === targetId) loading = true;
          break;
        case "Page.loadEventFired":
          loaded = true;
          loading = false;
          break;
      }
    });

    await Promise.all([page("Runtime.enable"), page("Log.enable"), page("Network.enable"), page("Page.enable")]);
    const nav = (await page("Page.navigate", { url: options.url })) as { errorText?: string };
    if (nav.errorText) {
      result.error = nav.errorText === "net::ERR_CONNECTION_REFUSED" ? "Nothing is listening at that address. Is the dev server running?" : nav.errorText;
    } else {
      // The page's own time starts once the browser is up: a slow first start isn't the page's fault.
      const deadline = Date.now() + timeoutMs;
      while (!loaded && Date.now() < deadline) await sleep(100);
      if (!loaded) result.error = `The page didn't finish loading within ${Math.round(timeoutMs / 1000)}s.`;
      // Then wait for late errors: hydration, data fetched after load. Stop once the network is quiet.
      const settle = options.settleMs ?? 1500;
      const settleEnd = Math.min(deadline, Date.now() + settle + 3000);
      const quietFrom = Date.now() + settle;
      while (Date.now() < settleEnd && !(Date.now() >= quietFrom && inflight === 0 && Date.now() - lastNetwork > 300)) await sleep(100);

      // Steps, like a person clicking through the page. Each waits for what it caused to finish.
      if (options.steps?.length && !result.error) {
        const idle = async (max: number) => {
          const end = Date.now() + max;
          await sleep(150);
          while (Date.now() < end && (loading || inflight > 0 || Date.now() - lastNetwork < 300)) await sleep(100);
        };
        const evaluate = async <T>(expression: string): Promise<T | undefined> => {
          const r = (await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result: { value?: T }; exceptionDetails?: unknown };
          return r.exceptionDetails ? undefined : r.result.value;
        };
        const findBox = (target: string) =>
          evaluate<{ x: number; y: number } | null>(
            `(() => { const el = (${FIND})(${JSON.stringify(target)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`,
          );
        const waitUntil = async <T>(check: () => Promise<T | null | undefined | false>, max: number): Promise<T | undefined> => {
          const end = Date.now() + max;
          for (;;) {
            const v = await check();
            if (v) return v;
            if (Date.now() > end) return undefined;
            await sleep(100);
          }
        };
        result.steps = [];
        for (const [i, s] of options.steps.entries()) {
          step = i + 1;
          const before = problems;
          const t0 = Date.now();
          const max = s.timeoutMs ?? 10_000;
          const sr: StepResult = { index: step, action: describeStep(s), ok: true, ms: 0, problems: 0 };
          try {
            if (s.goto) {
              const current = (await evaluate<string>("location.href")) ?? options.url;
              const next = new URL(s.goto, current).href;
              if (!isLoopbackUrl(next)) throw new Error("goto only goes to addresses on this computer.");
              loaded = false;
              const nav = (await page("Page.navigate", { url: next })) as { errorText?: string };
              if (nav.errorText) throw new Error(nav.errorText);
              await waitUntil(async () => loaded, max);
              await idle(3000);
            } else if (s.click) {
              const box = await waitUntil(() => findBox(s.click!), max);
              if (!box) throw new Error(`Nothing to click matches ${s.click}.`);
              for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
                await page("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
              }
              await idle(Math.max(3000, max / 2));
            } else if (s.type !== undefined) {
              if (s.into) {
                const ok = await waitUntil(() => evaluate<boolean>(`(() => { const el = (${FIND})(${JSON.stringify(s.into)}); if (!el) return false; el.focus(); if (el.select) el.select(); return true; })()`), max);
                if (!ok) throw new Error(`No field matches ${s.into}.`);
              }
              await page("Input.insertText", { text: s.type });
              await idle(1500);
            } else if (s.press) {
              const k = KEYS[s.press.toLowerCase()];
              if (!k) throw new Error(`Unknown key ${s.press}. Use Enter, Tab, Escape, Backspace, ArrowDown or ArrowUp.`);
              await page("Input.dispatchKeyEvent", { type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, ...(k.text ? { text: k.text } : {}) });
              await page("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
              await idle(Math.max(3000, max / 2));
            } else if (s.waitFor) {
              const w = s.waitFor;
              const check = w.startsWith("url=")
                ? () => evaluate<boolean>(`location.href.includes(${JSON.stringify(w.slice(4))})`)
                : () => findBox(w).then((b) => !!b);
              if (!(await waitUntil(check, max))) throw new Error(`${w} didn't show within ${Math.round(max / 1000)}s.`);
            } else if (!s.screenshot) {
              throw new Error("A step needs one of goto, click, type, press, waitFor or screenshot.");
            }
          } catch (err) {
            sr.ok = false;
            sr.error = (err as Error).message;
          }
          sr.url = await evaluate<string>("location.href");
          if (s.screenshot) {
            const shot = (await page("Page.captureScreenshot", { format: "png" })) as { data: string };
            sr.screenshot = saveScreenshot(sr.url ?? options.url, shot.data);
          }
          sr.ms = Date.now() - t0;
          sr.problems = problems - before;
          result.steps.push(sr);
          if (!sr.ok) break; // later steps depend on this one
        }
        result.finalUrl = await evaluate<string>("location.href");
      }

      const info =(await page("Runtime.evaluate", { expression: PAGE_INFO, returnByValue: true })) as { result: { value?: { title: string; text: string; overlay: string } } };
      const v = info.result.value;
      if (v) {
        result.title = v.title || undefined;
        result.text = v.text ? clip(v.text) : undefined;
        result.overlay = v.overlay ? clip(v.overlay) : undefined;
      }
      if (options.screenshot) {
        const shot = (await page("Page.captureScreenshot", { format: "png" })) as { data: string };
        result.screenshot = saveScreenshot(options.url, shot.data);
      }
    }
    result.status = documentStatus;
  } catch (err) {
    result.error ??= (err as Error).message;
  } finally {
    result.ms = Date.now() - started;
    try {
      await cdp?.send("Browser.close", {}, undefined, 2000);
    } catch {
      // closing below anyway
    }
    cdp?.close();
    if (proc && proc.exitCode === null) proc.kill();
    removeLater(profile);
  }
  result.ok =
    !result.error &&
    (result.status ?? 200) < 400 &&
    !result.overlay &&
    result.exceptions.length === 0 &&
    result.consoleErrors.length === 0 &&
    result.failedRequests.length === 0 &&
    (result.steps ?? []).every((s) => s.ok);
  return result;
}

/** One tab in a headless browser session (`withBrowser`). */
export interface BrowserPage {
  /** A DevTools protocol command to this tab. */
  send<T = unknown>(method: string, params?: object, timeoutMs?: number): Promise<T>;
  /** Runs an expression in the page and returns its value (promises are awaited); undefined when it threw. */
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T | undefined>;
  /**
   * Loads an address and waits for the load event, then for a quiet network (nothing in flight
   * for 300 ms, at most `settleMs` + 3 s). Resolves to the document's status, or throws with why
   * it couldn't load.
   */
  navigate(url: string, options?: { timeoutMs?: number; settleMs?: number }): Promise<number | undefined>;
}

export interface BrowserSession {
  /** Which browser runs it. */
  browser: string;
  newPage(): Promise<BrowserPage>;
}

/**
 * Runs `fn` with a headless browser that's closed afterwards, whatever happens. For tools that
 * drive pages themselves (visual diffs); `checkPage` is the one for errors on a page.
 */
export async function withBrowser<T>(fn: (session: BrowserSession) => Promise<T>, options: { width?: number; height?: number } = {}): Promise<T> {
  const found = findBrowser();
  if (!found) throw new Error(`No Chrome, Edge, Chromium or Brave was found. Install one: ${browserInstallFix()}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dx-browser-"));
  let proc: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    const width = options.width ?? 1280;
    const height = options.height ?? 800;
    let launched: { proc: ChildProcess; ws: string };
    try {
      launched = await launch(found.path, profile, width, height, false);
    } catch (err) {
      if (!/sandbox/i.test((err as Error).message)) throw err;
      launched = await launch(found.path, profile, width, height, true);
    }
    proc = launched.proc;
    const conn = await Cdp.connect(launched.ws);
    cdp = conn;
    const newPage = async (): Promise<BrowserPage> => {
      const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      const send = <R = unknown>(method: string, params: object = {}, timeoutMs?: number) => conn.send<R>(method, params, sessionId, timeoutMs);
      const inflight = new Set<string>();
      let lastNetwork = Date.now();
      let loaded = false;
      let status: number | undefined;
      conn.on(sessionId, (method, p) => {
        if (method === "Network.requestWillBeSent") {
          inflight.add(p.requestId as string);
          lastNetwork = Date.now();
        } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
          inflight.delete(p.requestId as string);
          lastNetwork = Date.now();
        } else if (method === "Network.responseReceived") {
          if (p.type === "Document" && status === undefined) status = (p.response as { status: number }).status;
        } else if (method === "Page.loadEventFired") loaded = true;
      });
      await Promise.all([send("Page.enable"), send("Network.enable"), send("Runtime.enable")]);
      const evaluate = async <R>(expression: string, timeoutMs?: number): Promise<R | undefined> => {
        const r = await send<{ result: { value?: R }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
        return r.exceptionDetails ? undefined : r.result.value;
      };
      const navigate = async (url: string, o: { timeoutMs?: number; settleMs?: number } = {}) => {
        loaded = false;
        status = undefined;
        inflight.clear();
        const nav = await send<{ errorText?: string }>("Page.navigate", { url });
        if (nav.errorText) throw new Error(nav.errorText === "net::ERR_CONNECTION_REFUSED" ? "Nothing is listening at that address. Is the dev server running?" : nav.errorText);
        const deadline = Date.now() + (o.timeoutMs ?? 30_000);
        while (!loaded && Date.now() < deadline) await sleep(100);
        if (!loaded) throw new Error(`The page didn't finish loading within ${Math.round((o.timeoutMs ?? 30_000) / 1000)}s.`);
        const settle = o.settleMs ?? 1000;
        const end = Math.min(deadline, Date.now() + settle + 3000);
        const quietFrom = Date.now() + settle;
        while (Date.now() < end && !(Date.now() >= quietFrom && inflight.size === 0 && Date.now() - lastNetwork > 300)) await sleep(100);
        return status;
      };
      return { send, evaluate, navigate };
    };
    return await fn({ browser: found.name, newPage });
  } finally {
    try {
      await cdp?.send("Browser.close", {}, undefined, 2000);
    } catch {
      // closing below anyway
    }
    cdp?.close();
    if (proc && proc.exitCode === null) proc.kill();
    removeLater(profile);
  }
}

// Runs in the page: an element by CSS selector, or by its text with "text=…" (buttons and links
// first, then any element whose own text matches, exactly before partly).
const FIND = `(sel) => {
  if (!sel.startsWith("text=")) { try { return document.querySelector(sel); } catch { return null; } }
  const want = sel.slice(5).trim().toLowerCase();
  const textOf = (e) => (e.innerText || e.value || e.getAttribute("aria-label") || "").trim().toLowerCase();
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const pick = (list) => list.find((e) => visible(e) && textOf(e) === want) || list.find((e) => visible(e) && textOf(e).includes(want));
  const actions = [...document.querySelectorAll("button, a, [role=button], [role=link], [role=tab], [role=menuitem], input[type=submit], input[type=button], label, summary")];
  const leaves = [...document.querySelectorAll("body *")].filter((e) => !e.children.length);
  return pick(actions) || pick(leaves) || null;
}`;

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
};

export function describeStep(s: PageStep): string {
  if (s.goto) return `go to ${s.goto}`;
  if (s.click) return `click ${s.click}`;
  if (s.type !== undefined) return `type "${s.type.length > 40 ? `${s.type.slice(0, 40)}…` : s.type}"${s.into ? ` into ${s.into}` : ""}`;
  if (s.press) return `press ${s.press}`;
  if (s.waitFor) return `wait for ${s.waitFor}`;
  return "screenshot";
}

// Runs in the page: its title, visible text, and the text of a dev server's error overlay.
const PAGE_INFO = `(() => {
  const shadowText = (sel) => { const el = document.querySelector(sel); return el && el.shadowRoot ? el.shadowRoot.textContent : ""; };
  let overlay = shadowText("vite-error-overlay");
  if (!overlay) {
    const next = document.querySelector("nextjs-portal");
    const root = next && next.shadowRoot;
    const dialog = root && root.querySelector("[data-nextjs-dialog], [data-nextjs-error-overlay], .nextjs-container-errors-header");
    overlay = dialog ? dialog.textContent : "";
  }
  if (!overlay) { const wp = document.getElementById("webpack-dev-server-client-overlay"); overlay = wp && wp.contentDocument ? wp.contentDocument.body.innerText : ""; }
  return { title: document.title, text: document.body ? document.body.innerText : "", overlay: (overlay || "").replace(/\\s+/g, " ").trim() };
})()`;

interface StackTrace {
  callFrames: { url: string; lineNumber: number; columnNumber: number }[];
}
interface ExceptionDetails {
  text?: string;
  url?: string;
  lineNumber?: number;
  stackTrace?: StackTrace;
  exception?: { description?: string };
}
interface RemoteObject {
  type: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
}

function remoteText(o: RemoteObject): string {
  if (o.type === "string") return String(o.value);
  if (o.value !== undefined) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  return o.unserializableValue ?? o.description ?? o.type;
}

function where(url?: string, line?: number, stack?: StackTrace): string | undefined {
  const frame = stack?.callFrames.find((f) => f.url);
  const u = frame?.url ?? url;
  if (!u) return undefined;
  const l = frame ? frame.lineNumber : line;
  return l !== undefined ? `${u}:${l + 1}` : u;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const START_TIMEOUT_MS = 60_000;

function launch(exe: string, profile: string, width: number, height: number, noSandbox: boolean): Promise<{ proc: ChildProcess; ws: string }> {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--mute-audio",
    "--hide-scrollbars",
    // Chrome refuses to start as root (in a container, say) unless its sandbox is off.
    ...(noSandbox || process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    // What it printed, without the D-Bus complaints headless Chrome makes on Linux: they're harmless.
    const said = () => {
      const text = err.split("\n").filter((l) => l.trim() && !/dbus|Could not parse server address/i.test(l)).join("\n");
      return text ? ` It said: ${text.slice(-300)}` : "";
    };
    // A browser's very first start on a machine (fresh profile, font cache built) can take a while.
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`The browser didn't start within ${START_TIMEOUT_MS / 1000}s.${said()}`));
    }, START_TIMEOUT_MS);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't start the browser: ${e.message}`));
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The browser quit straight away (code ${code}).${said()}`));
    });
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (chunk: string) => {
      err += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        proc.removeAllListeners("exit");
        proc.stderr!.removeAllListeners("data");
        proc.stderr!.resume();
        resolve({ proc, ws: m[1] });
      }
    });
  });
}

type Handler = (method: string, params: Record<string, unknown>) => void;

/** A minimal DevTools protocol client: commands with replies, and events per session. */
class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, Handler>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else if (msg.method) {
        this.handlers.get(msg.sessionId ?? "")?.(msg.method, msg.params ?? {});
      }
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("The browser closed the connection."));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error("Couldn't connect to the browser.")), { once: true });
    });
  }

  on(sessionId: string, handler: Handler): void {
    this.handlers.set(sessionId, handler);
  }

  send<T = unknown>(method: string, params: object = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser didn't answer ${method}.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

const MAX_SCREENSHOTS = 30;

function saveScreenshot(url: string, base64: string): string {
  const dir = dxPath("screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const u = new URL(url);
  const slug = `${u.hostname}${u.port ? `-${u.port}` : ""}${u.pathname}`.replace(/[^\w.-]+/g, "-").replace(/-+$/, "");
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}.png`);
  fs.writeFileSync(file, Buffer.from(base64, "base64"));
  // Keep the newest few.
  const all = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - MAX_SCREENSHOTS))) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

/** The browser holds files in its profile for a moment after it quits, on Windows especially. */
function removeLater(dir: string, tries = 10): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    if (tries > 0) setTimeout(() => removeLater(dir, tries - 1), 500).unref();
  }
}
