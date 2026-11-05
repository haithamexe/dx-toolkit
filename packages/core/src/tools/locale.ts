import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dxPath } from "../config.js";
import { isLoopbackUrl, withBrowser, type BrowserPage } from "./browser.js";
import { parseYaml } from "./yaml.js";

/**
 * The translation check: how a page holds up in other languages, before anyone translates it.
 *
 * - **Pseudo text**: every piece of text on the page is made longer and accented, the way German
 *   or Finnish run longer than English ("Save" → "[Šàṽé ~~~~]"), so text that gets cut off or
 *   spills out of its box shows up, and a missing "]" says something cut the end off.
 * - **Right to left**: the page is flipped (dir="rtl"), as Arabic and Hebrew readers see it.
 * - **Written into the code**: the page's text compared with the project's translation files;
 *   what isn't in them (and isn't data from the app's own API answers) would never be translated.
 *
 * Live, through the recorder script (a switch on the Chaos page), or as a headless check of the
 * project's pages on its own dev server.
 */

export interface LocaleSettings {
  /** Longer, accented text. */
  pseudo?: boolean;
  /** The page flipped right to left. */
  rtl?: boolean;
}

export type LocaleProblemKind = "cut-off" | "spills" | "hard-coded";

export interface LocaleProblem {
  kind: LocaleProblemKind;
  /** The text as the app wrote it. */
  text: string;
  /** "the Checkout button". */
  where?: string;
  /** The page's path. */
  path: string;
  /** Seen with the page flipped right to left. */
  rtl?: boolean;
  /** Where the text is in the project's code: "src/App.tsx:42". */
  file?: string;
}

export interface LocalePage {
  path: string;
  status?: number;
  error?: string;
  /** Pictures saved (pseudo, and rtl when checked), named for `localeImageFile`. */
  shots: string[];
  /** How many pieces of text the page showed. */
  texts: number;
}

export interface LocaleReport {
  project: string;
  browser?: string;
  pages: LocalePage[];
  problems: LocaleProblem[];
  /** Translation files found, relative to the project. */
  files: string[];
  /** The translation library in package.json, when there is one. */
  library?: string;
  /** How many pieces of text came from the app's own data (API answers), so they weren't counted. */
  fromData: number;
  /** How many were found in the translation files. */
  translated: number;
  ms: number;
  at: string;
}

const LIBRARIES = ["i18next", "react-i18next", "next-i18next", "next-intl", "react-intl", "vue-i18n", "@lingui/core", "@lingui/react", "svelte-i18n", "@ngx-translate/core", "@angular/localize", "typesafe-i18n", "@inlang/paraglide-js", "rosetta", "i18n-js", "@formatjs/intl", "nuxt-i18n", "@nuxtjs/i18n", "react-native-localize", "polyglot", "node-polyglot"];
const LOCALE_DIRS = /^(locales?|i18n|lang|langs|languages|translations?|messages|intl|l10n)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".output", "out", "coverage", ".turbo", ".cache", "vendor", ".venv", "venv", "target"]);
const MAX_FILE = 2 * 1024 * 1024;

/**
 * Runs in the page (the recorder adds it when the switch is on; the check adds it itself). Text
 * nodes and a few attributes are changed in place and changed again when the app updates them;
 * the originals are kept, so a problem can be named by the text the app wrote.
 */
export const PSEUDO_SCRIPT = String.raw`(function () {
  if (window.__dxPseudo) return;
  var opts = window.__dxLocale || {};
  var MAP = { a: "à", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ", n: "ñ", o: "ö", p: "þ", q: "ǫ", r: "ŕ", s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
    A: "À", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž" };
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|KBD|SAMP|TEMPLATE|svg|SVG|MATH)$/;
  var ATTRS = ["placeholder", "title", "aria-label", "alt"];
  var texts = new WeakMap();
  var attrs = new WeakMap();
  var busy = false;
  function pseudo(s) {
    var core = s.trim();
    if (!/[A-Za-z]{2}/.test(core) || /^\S+@\S+\.\S+$/.test(core) || /^(https?:|www\.)/i.test(core)) return s;
    var lead = s.slice(0, s.length - s.replace(/^\s+/, "").length);
    var trail = s.slice(s.replace(/\s+$/, "").length);
    var out = "";
    for (var i = 0; i < core.length; i++) out += MAP[core[i]] || core[i];
    var n = core.length;
    var extra = Math.ceil(n * (n <= 10 ? 1 : n <= 20 ? 0.8 : n <= 50 ? 0.5 : 0.3));
    return lead + "[" + out + " " + new Array(extra + 1).join("~") + "]" + trail;
  }
  function skipped(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (SKIP.test(e.tagName) || e.isContentEditable || e.getAttribute("translate") === "no" || (e.classList && e.classList.contains("notranslate"))) return true;
    }
    return false;
  }
  function doText(node) {
    var parent = node.parentElement;
    if (!parent || skipped(parent)) return;
    var known = texts.get(node);
    var now = node.nodeValue || "";
    if (known && now === known.shown) return;
    var shown = pseudo(now);
    texts.set(node, { orig: now, shown: shown });
    if (shown !== now) node.nodeValue = shown;
  }
  function doAttrs(el) {
    if (skipped(el)) return;
    var kept = attrs.get(el) || {};
    var list = ATTRS.slice();
    if (el.tagName === "INPUT" && /^(submit|button|reset)$/i.test(el.type)) list.push("value");
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var v = el.getAttribute(a);
      if (v == null || (kept[a] && kept[a].shown === v)) continue;
      var shown = pseudo(v);
      kept[a] = { orig: v, shown: shown };
      if (shown !== v) el.setAttribute(a, shown);
    }
    attrs.set(el, kept);
  }
  function walk(root) {
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) doAttrs(root);
    var w = document.createTreeWalker(root, 5);
    var n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) doText(n);
      else doAttrs(n);
    }
  }
  function flip() {
    if (opts.rtl && document.documentElement.getAttribute("dir") !== "rtl") document.documentElement.setAttribute("dir", "rtl");
  }
  function apply(fn) {
    busy = true;
    try { fn(); } finally { busy = false; }
  }
  var started = false;
  function start() {
    if (started) return;
    started = true;
    flip();
    if (!opts.pseudo) return;
    apply(function () { walk(document.body || document.documentElement); });
    new MutationObserver(function (records) {
      if (busy) return;
      apply(function () {
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (r.type === "characterData") doText(r.target);
          else if (r.type === "attributes") doAttrs(r.target);
          else for (var j = 0; j < r.addedNodes.length; j++) walk(r.addedNodes[j]);
        }
      });
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(["value"]) });
  }
  // The text the app wrote, for an element: its own text nodes as they were before pseudo text.
  function original(el) {
    var out = "";
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) { var t = texts.get(c); out += t ? t.orig : c.nodeValue; }
    return out.replace(/\s+/g, " ").trim();
  }
  window.__dxPseudo = { start: start, original: original, pseudo: pseudo };
  if (opts.manual) return;
  // After the page has started (and a server-rendered page has hydrated), so the framework
  // doesn't see different text from what it rendered.
  var later = function () { setTimeout(start, 400); };
  if (document.readyState === "complete") later();
  else window.addEventListener("load", later, { once: true });
})();`;

/** Runs in the page after pseudo text: text that's cut off or spills out of its box, outlined for the picture. */
const PROBLEMS = String.raw`(() => {
  const KIND = { BUTTON: "button", A: "link", H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", LABEL: "label", TH: "column heading", TD: "cell", LI: "item", OPTION: "option", SUMMARY: "summary", LEGEND: "legend", CAPTION: "caption", P: "paragraph", NAV: "navigation" };
  const ROLES = { button: "button", link: "link", tab: "tab", menuitem: "menu item", heading: "heading", option: "option", columnheader: "column heading", cell: "cell" };
  const own = (e) => { for (let c = e.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && /[A-Za-zÀ-ž]{2}/.test(c.nodeValue || "")) return true; return false; };
  const orig = (e) => (window.__dxPseudo ? window.__dxPseudo.original(e) : (e.innerText || "").trim()).slice(0, 160);
  const nameOf = (e) => {
    for (let x = e, i = 0; x && x !== document.body && i < 5; x = x.parentElement, i++) {
      const k = KIND[x.tagName] || ROLES[x.getAttribute("role") || ""];
      if (k) { const t = orig(x) || orig(e); return ("the " + (t && t.length <= 40 ? t + " " : "") + k).slice(0, 90); }
    }
    const t = orig(e);
    return t ? ("the text “" + t.slice(0, 40) + "”") : "";
  };
  const clips = (s, axis) => /hidden|clip|scroll|auto/.test(axis === "x" ? s.overflowX : s.overflowY);
  const out = [];
  const style = document.createElement("style");
  style.textContent = "[data-dx-problem]{outline:2px solid #e5484d!important;outline-offset:1px!important}";
  (document.head || document.documentElement).appendChild(style);
  const els = document.body ? document.body.querySelectorAll("*") : [];
  for (const e of els) {
    if (out.length >= 80) break;
    if (!own(e)) continue;
    const s = getComputedStyle(e);
    if (s.display === "none" || s.visibility === "hidden" || s.display === "contents") continue;
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const inline = s.display === "inline";
    let kind = "";
    if (!inline && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1) kind = clips(s, "x") || s.textOverflow === "ellipsis" ? "cut-off" : "spills";
    else if (!inline && e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 2 && clips(s, "y")) kind = "cut-off";
    else {
      for (let p = e.parentElement, i = 0; p && p !== document.body && i < 4; p = p.parentElement, i++) {
        const ps = getComputedStyle(p);
        if (!clips(ps, "x") && !clips(ps, "y")) continue;
        const pr = p.getBoundingClientRect();
        if (r.right > pr.right + 2 || r.left < pr.left - 2 || (clips(ps, "y") && r.bottom > pr.bottom + 2)) kind = "cut-off";
        break;
      }
    }
    if (!kind) continue;
    e.setAttribute("data-dx-problem", "");
    out.push({ kind, text: orig(e), where: nameOf(e) });
  }
  return out;
})()`;

/** Runs in the page as the app wrote it: the visible text, and the JSON data the page carries. */
const TEXTS = String.raw`(() => {
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|KBD|SAMP|TEMPLATE|svg|SVG)$/;
  const seen = new Map();
  const add = (t, where) => { t = (t || "").replace(/\s+/g, " ").trim(); if (t.length < 2 || t.length > 300 || !/[A-Za-zÀ-ž]{2}/.test(t) || seen.has(t)) return; seen.set(t, where); };
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const w = document.body ? document.createTreeWalker(document.body, 1) : null;
  let e;
  while (w && (e = w.nextNode()) && seen.size < 400) {
    if (SKIP.test(e.tagName) || e.getAttribute("translate") === "no" || e.classList.contains("notranslate") || !visible(e)) continue;
    let own = "";
    for (let c = e.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) own += c.nodeValue;
    add(own, e.tagName.toLowerCase());
    for (const a of ["placeholder", "aria-label", "alt", "title"]) if (e.hasAttribute(a)) add(e.getAttribute(a), e.tagName.toLowerCase() + " " + a);
    if (e.tagName === "INPUT" && /^(submit|button|reset)$/i.test(e.type)) add(e.value, "button");
  }
  let data = "";
  for (const s of document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]')) { data += (s.textContent || "") + "\n"; if (data.length > 2e6) break; }
  return { texts: [...seen.entries()].map(([text, where]) => ({ text, where })), data: data.slice(0, 2e6) };
})()`;

// ------------------------------------------------------------------ translation files

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

/** The translation library the project uses, from package.json. */
export function translationLibrary(dir: string): string | undefined {
  const pkg = readJson(path.join(dir, "package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return LIBRARIES.find((l) => l in deps);
}

/** JSON, YAML and .po files in folders named like locales/, i18n/, messages/ (not node_modules or builds). */
export function findTranslationFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string, depth: number, inLocale: boolean) => {
    if (depth > 6 || out.length >= 200) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        visit(p, depth + 1, inLocale || LOCALE_DIRS.test(e.name));
      } else if (e.isFile() && inLocale && /\.(json|ya?ml|po)$/i.test(e.name)) {
        try {
          if (fs.statSync(p).size <= MAX_FILE) out.push(p);
        } catch {
          // gone
        }
      }
    }
  };
  visit(dir, 0, false);
  return out.sort();
}

function leaves(value: unknown, out: string[], depth = 0): void {
  if (depth > 12 || out.length > 50_000) return;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) leaves(v, out, depth + 1);
  else if (value && typeof value === "object") for (const v of Object.values(value)) leaves(v, out, depth + 1);
}

/** Every translated string in the files. */
export function readTranslations(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8").replace(/^﻿/, "");
    } catch {
      continue;
    }
    if (/\.po$/i.test(f)) {
      // msgid and msgstr lines, both: the source text is what the page shows before translation.
      for (const m of text.matchAll(/^(?:msgid|msgstr(?:\[\d+\])?)\s+"((?:[^"\\]|\\.)*)"/gm)) if (m[1]) out.push(m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
      continue;
    }
    try {
      leaves(/\.json$/i.test(f) ? JSON.parse(text) : parseYaml(text), out);
    } catch {
      // a file that doesn't parse is left out
    }
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Tells whether a page's text comes from the translations: the same text, or a translation with
 * its placeholders filled in ({{name}}, {name}, {0}, %s, :name, <0>…</0> tags, ICU plurals).
 */
export function translationMatcher(values: string[]): (text: string) => boolean {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  const HOLE = /\{\{[^}]*\}\}|\{[^{}]*\}|%\d*\$?[sdif@]|<\/?\d+>|<\/?[a-z][\w-]*\/?>|(?<![\w:]):[a-z]\w*/gi;
  // ICU plurals and selects: each option is a text of its own ("# items"), and the whole a hole.
  const ICU = /\{\s*\w+\s*,\s*(?:plural|select|selectordinal)\s*,((?:[^{}]|\{[^{}]*\})*)\}/i;
  const all: string[] = [];
  for (const v of values) {
    let rest = v;
    for (let i = 0, m = ICU.exec(rest); m && i < 20; i++, m = ICU.exec(rest)) {
      for (const o of m[1].matchAll(/\{([^{}]*)\}/g)) all.push(o[1].replace(/#/g, "{n}"));
      rest = rest.replace(m[0], "{x}");
    }
    all.push(rest);
  }
  for (const v of all) {
    const n = norm(v);
    if (!n || !/[a-z]{2}/i.test(n)) continue;
    exact.add(n);
    HOLE.lastIndex = 0;
    if (HOLE.test(n) && patterns.length < 5000) {
      const parts = n.split(HOLE).map((p) => escape(p));
      const re = parts.join(".*?");
      if (re.replace(/\.\*\?/g, "").trim().length >= 2) patterns.push(new RegExp(`^${re}$`, "s"));
      // The fixed parts on their own: an ICU plural's "items" shown next to its number.
      for (const p of n.split(HOLE)) if (/[a-z]{3}/i.test(p)) exact.add(p.trim());
    }
  }
  return (text: string) => {
    const n = norm(text);
    if (exact.has(n)) return true;
    // A translation with a number or a symbol next to it: "Total: 40 €", "3 items".
    const bare = n.replace(/[\d.,:;!?()[\]%€$£¥+\-–—/*#@|·•…"'“”‘’«»]+/g, " ").replace(/\s+/g, " ").trim();
    if (bare && exact.has(bare)) return true;
    return patterns.some((re) => re.test(n));
  };
}

/** Text that is data, not words to translate: numbers, dates, prices, codes, emails, addresses. */
export function looksLikeData(text: string): boolean {
  const t = text.trim();
  if (!/[A-Za-zÀ-ž]{2}/.test(t)) return true;
  if (/^\S+@\S+\.\S+$/.test(t) || /^(https?:\/\/|www\.)/i.test(t) || /^[\w./-]+\.(js|ts|tsx|css|png|jpe?g|svg|json)$/i.test(t)) return true;
  // An id or code: one word with digits in it, or all capitals and digits.
  if (/^[A-Z0-9_-]{2,}$/.test(t) && /\d/.test(t)) return true;
  if (/^#?[A-Za-z]*\d[\w-]*$/.test(t)) return true;
  return false;
}

// ------------------------------------------------------------------ pictures

/** Where a project's pictures go: ~/.dx/locale/<project>-<hash>, never the project itself. */
export function localeFolder(dir: string): string {
  const r = path.resolve(dir);
  const key = process.platform === "linux" ? r : r.toLowerCase();
  const name = path.basename(r).replace(/[^\w.-]+/g, "-").slice(0, 40) || "project";
  return dxPath("locale", `${name}-${crypto.createHash("sha1").update(key).digest("hex").slice(0, 8)}`);
}

/** The picture's file, from a checked name only. */
export function localeImageFile(dir: string, name: unknown): string {
  if (!isLocaleShotName(name)) throw new Error("That isn't one of the check's pictures.");
  return path.join(localeFolder(dir), `${name}.png`);
}

/** "checkout@rtl" style names only: what `localeImageFile` accepts. */
export function isLocaleShotName(name: unknown): name is string {
  return typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,80}@(pseudo|rtl)$/.test(name);
}

function slug(p: string): string {
  const s = p.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (s || "home").slice(0, 60);
}

// ------------------------------------------------------------------ the check

export interface LocaleCheckOptions {
  dir: string;
  project: string;
  /** The dev server's own address on this computer. */
  baseUrl: string;
  /** Pages to check (default "/"). */
  paths?: string[];
  /** Also check the pages right to left (default true). */
  rtl?: boolean;
  /** Where pictures go (default ~/.dx/locale/<project>-<hash>). */
  shotsDir?: string;
  progress?: (step: string, done: number, total: number) => void;
  signal?: AbortSignal;
}

async function load(page: BrowserPage, url: string): Promise<number | undefined> {
  return page.navigate(url, { settleMs: 800, timeoutMs: 45_000 });
}

/** Loads each page as it is, with pseudo text, and right to left; reports what doesn't fit and what isn't translated. */
export async function checkTranslation(o: LocaleCheckOptions): Promise<LocaleReport> {
  if (!isLoopbackUrl(o.baseUrl)) throw new Error("Only a dev server on this computer can be checked.");
  const started = Date.now();
  const base = new URL(o.baseUrl);
  const paths = [...new Set((o.paths?.length ? o.paths : ["/"]).map((p) => (p.startsWith("/") ? p : `/${p}`)))].slice(0, 6);
  const rtl = o.rtl !== false;
  const files = findTranslationFiles(o.dir);
  const isTranslated = translationMatcher(readTranslations(files));
  const report: LocaleReport = { project: o.project, pages: [], problems: [], files: files.map((f) => path.relative(o.dir, f).split(path.sep).join("/")), library: translationLibrary(o.dir), fromData: 0, translated: 0, ms: 0, at: new Date().toISOString() };
  const shotsDir = o.shotsDir ?? localeFolder(o.dir);
  fs.mkdirSync(shotsDir, { recursive: true, mode: 0o700 });
  const hardCoded = new Map<string, LocaleProblem>();
  const total = paths.length * (rtl ? 3 : 2);
  let done = 0;
  const step = (s: string) => o.progress?.(s, done, total);

  await withBrowser(async (session) => {
    report.browser = session.browser;
    for (const p of paths) {
      if (o.signal?.aborted) break;
      const url = new URL(p, base);
      if (url.origin !== base.origin || !isLoopbackUrl(url.href)) continue;
      const entry: LocalePage = { path: p, shots: [], texts: 0 };
      report.pages.push(entry);
      try {
        // 1. As the app wrote it: its text, and the API answers it loaded (data, not words to translate).
        step(`${p}: reading the text`);
        const plain = await session.newPage();
        // With pseudo text switched on for your browser, dx's recorder would change this page too:
        // a stand-in that does nothing goes first, so the page shows the app's own text.
        await plain.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__dxPseudo = { start() {}, original() { return ''; }, pseudo(s) { return s; } };" });
        const bodies: string[] = [];
        const apiCalls = new Set<string>();
        plain.onEvent((method, ev) => {
          if (method === "Network.responseReceived" && /^(XHR|Fetch)$/.test(String(ev.type)) && /json|text/.test(String((ev.response as { mimeType?: string })?.mimeType))) apiCalls.add(ev.requestId as string);
          else if (method === "Network.loadingFinished" && apiCalls.has(ev.requestId as string)) {
            apiCalls.delete(ev.requestId as string);
            plain
              .send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId: ev.requestId }, 5000)
              .then((r) => void (!r.base64Encoded && bodies.push(r.body.slice(0, 1_000_000))))
              .catch(() => undefined);
          }
        });
        entry.status = await load(plain, url.href);
        await new Promise((r) => setTimeout(r, 300));
        const seen = await plain.evaluate<{ texts: { text: string; where: string }[]; data: string }>(TEXTS, 15_000);
        done++;
        const data = norm(`${bodies.join("\n")}\n${seen?.data ?? ""}`.replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\"/g, '"'));
        entry.texts = seen?.texts.length ?? 0;
        for (const t of seen?.texts ?? []) {
          if (looksLikeData(t.text)) continue;
          const n = norm(t.text);
          // Short words are only data when they're a whole value: "ok" is inside "token" too.
          if (n.length >= 8 ? data.includes(n) : data.includes(`"${n}"`) || data.includes(`>${n}<`)) {
            report.fromData++;
            continue;
          }
          if (isTranslated(t.text)) {
            report.translated++;
            continue;
          }
          if (!hardCoded.has(t.text)) hardCoded.set(t.text, { kind: "hard-coded", text: t.text, where: tagWords(t.where), path: p });
        }

        // 2. Pseudo text, then 3. right to left: what doesn't fit, outlined in the picture.
        for (const mode of rtl ? (["pseudo", "rtl"] as const) : (["pseudo"] as const)) {
          if (o.signal?.aborted) break;
          step(`${p}: ${mode === "rtl" ? "right to left" : "longer text"}`);
          const page = await session.newPage();
          await page.send("Page.setBypassCSP", { enabled: true });
          const settings = { pseudo: true, rtl: mode === "rtl", manual: true };
          await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__dxLocale = ${JSON.stringify(settings)};\n${PSEUDO_SCRIPT}` });
          await load(page, url.href);
          await page.evaluate("window.__dxPseudo && window.__dxPseudo.start()", 10_000);
          await new Promise((r) => setTimeout(r, 400));
          const found = (await page.evaluate<{ kind: LocaleProblemKind; text: string; where: string }[]>(PROBLEMS, 20_000)) ?? [];
          for (const f of found) {
            if (!f.text) continue;
            // In rtl only what pseudo text didn't already show.
            // Once per text: a header on every page is one problem; in rtl only what pseudo text didn't show.
            if (report.problems.some((x) => x.text === f.text && x.kind === f.kind)) continue;
            report.problems.push({ kind: f.kind, text: f.text, where: f.where || undefined, path: p, ...(mode === "rtl" ? { rtl: true } : {}) });
          }
          {
            const shot = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
            const name = `${slug(p)}@${mode}`;
            fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(shot.data, "base64"), { mode: 0o600 });
            entry.shots.push(name);
          }
          await page.send("Page.close").catch(() => undefined);
          done++;
        }
        await plain.send("Page.close").catch(() => undefined);
      } catch (err) {
        entry.error = (err as Error).message.split("\n")[0].slice(0, 300);
      }
    }
  });

  // Where the hard-coded text is in the code (tracked and new files, not the translation files).
  const list = [...hardCoded.values()];
  const places = await findInCode(o.dir, list.slice(0, 40).map((h) => h.text), new Set(report.files));
  for (const h of list) {
    const at = places.get(h.text);
    if (at) h.file = at;
  }
  // With translation files, everything not in them; without, the same list says the project isn't set up yet.
  report.problems.push(...list.slice(0, 150));
  report.ms = Date.now() - started;
  return report;
}

/** file:line of each text in the project's own code, with `git grep -F` (one run for all). */
export function findInCode(dir: string, texts: string[], skip: Set<string> = new Set()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = texts.filter((t) => t.length >= 3 && t.length <= 200 && !/[\r\n]/.test(t));
  if (!wanted.length) return Promise.resolve(out);
  const args = ["-c", "core.quotePath=false", "grep", "--untracked", "-n", "-I", "-F", "-o", "--full-name", ...wanted.flatMap((t) => ["-e", t])];
  return new Promise((resolve) => {
    execFile("git", args, { cwd: dir, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 20_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout) => {
      if (err && !stdout) return resolve(out);
      const prefix = gitPrefix(dir);
      for (const line of String(stdout).split("\n")) {
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        const [, file, lineNo, match] = m;
        const rel = prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file;
        if (skip.has(rel) || /(^|\/)(node_modules|dist|build|\.next)\//.test(rel) || /\.(md|lock|snap|map)$/i.test(rel) || /(^|\/)(locales?|i18n|translations?|messages|lang)\//i.test(rel)) continue;
        if (!out.has(match)) out.set(match, `${rel}:${lineNo}`);
      }
      resolve(out);
    });
  });
}

/** The project's folder inside its repository ("apps/web/"), so git's paths can be made the project's. */
function gitPrefix(dir: string): string {
  let d = path.resolve(dir);
  const parts: string[] = [];
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(d, ".git"))) return parts.length ? `${parts.reverse().join("/")}/` : "";
    const up = path.dirname(d);
    if (up === d) break;
    parts.push(path.basename(d));
    d = up;
  }
  return "";
}

const TAGS: Record<string, string> = { img: "an image", a: "a link", button: "a button", label: "a label", p: "a paragraph", li: "a list item", td: "a table cell", th: "a column heading", option: "an option", span: "a text", div: "a text", title: "the title", nav: "the navigation", summary: "a summary", legend: "a legend", caption: "a caption", small: "a small print", strong: "a bold text", em: "an emphasis" };

/** "h1" → "a heading", "input placeholder" → "a field's placeholder". */
function tagWords(where: string): string {
  const [tag, attr] = where.split(" ");
  const what = /^h[1-6]$/.test(tag) ? "a heading" : /^(input|textarea|select)$/.test(tag) ? "a field" : (TAGS[tag] ?? `a ${tag}`);
  if (!attr) return what;
  return `${what}'s ${attr === "aria-label" ? "label for screen readers" : attr === "alt" ? "description" : attr}`;
}

/** One line per problem, for the CLI and agents. */
export function describeLocaleProblem(p: LocaleProblem): string {
  const what = p.kind === "cut-off" ? "Cut off" : p.kind === "spills" ? "Spills out of its box" : "Written into the code";
  return `${what}${p.rtl ? " (right to left)" : ""}: "${p.text.slice(0, 80)}"${p.where ? ` — ${p.where}` : ""} on ${p.path}${p.file ? ` (${p.file})` : ""}`;
}
