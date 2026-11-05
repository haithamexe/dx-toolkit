import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The translation check: matching page text to translation files, telling data from words, the
// pictures' names, the setting, and a headless run against a made-up page. Temp folders only.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-locale-home-"));
process.env.DX_HOME = home;
const { translationMatcher, looksLikeData, readTranslations, findTranslationFiles, translationLibrary, isLocaleShotName, localeImageFile, checkTranslation, PSEUDO_SCRIPT, describeLocaleProblem } = await import("../tools/locale.js");
const { cleanChaos } = await import("../tools/chaos.js");
const { findBrowser } = await import("../tools/browser.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-locale-app-"));
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("translation files are found in locale folders, never node_modules, and read as JSON, YAML and .po", () => {
  fs.mkdirSync(path.join(dir, "src", "locales"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "lib", "locales"), { recursive: true });
  fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "locales", "en.json"), JSON.stringify({ nav: { orders: "Your orders" }, cart: { items: "{count, plural, one {# item} other {# items}}", total: "Total: {{amount}}" }, hi: "Hello, {name}!" }));
  fs.writeFileSync(path.join(dir, "messages", "de.yml"), "save: Speichern\nnested:\n  cancel: Abbrechen\n");
  fs.writeFileSync(path.join(dir, "messages", "fr.po"), 'msgid "Sign in"\nmsgstr "Se connecter"\n');
  fs.writeFileSync(path.join(dir, "node_modules", "lib", "locales", "en.json"), JSON.stringify({ x: "From a library" }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "react-i18next": "^14.0.0" } }));
  const files = findTranslationFiles(dir).map((f) => path.relative(dir, f).split(path.sep).join("/"));
  assert.deepEqual(files, ["messages/de.yml", "messages/fr.po", "src/locales/en.json"]);
  const values = readTranslations(findTranslationFiles(dir));
  for (const v of ["Your orders", "Speichern", "Abbrechen", "Sign in", "Se connecter"]) assert.ok(values.includes(v), v);
  assert.ok(!values.includes("From a library"));
  assert.equal(translationLibrary(dir), "react-i18next");
});

test("page text matches translations with their placeholders filled in", () => {
  const match = translationMatcher(readTranslations(findTranslationFiles(dir)));
  assert.equal(match("Your orders"), true);
  assert.equal(match("  your   ORDERS "), true);
  assert.equal(match("Total: 40 €"), true);
  assert.equal(match("Hello, Ada!"), true);
  assert.equal(match("3 items"), true);
  assert.equal(match("Speichern"), true);
  assert.equal(match("Welcome back to the shop"), false);
  assert.equal(match("Your ordering history"), false);
});

test("numbers, codes, emails and addresses are data, not words to translate", () => {
  for (const t of ["42", "€ 12.50", "2026-11-05", "ORD-2041", "a1b2c3", "ada@example.com", "https://example.com/x", "logo.svg"]) assert.equal(looksLikeData(t), true, t);
  for (const t of ["Save changes", "Orders", "No results"]) assert.equal(looksLikeData(t), false, t);
});

test("pictures are named by a checked name and live under dx's own folder", () => {
  assert.equal(isLocaleShotName("checkout@pseudo"), true);
  assert.equal(isLocaleShotName("home@rtl"), true);
  for (const bad of ["../x@rtl", "home@other", "home", "a/b@rtl", "", 5]) assert.equal(isLocaleShotName(bad), false, String(bad));
  const file = localeImageFile(dir, "home@rtl");
  assert.ok(file.startsWith(path.join(home, "locale")), file);
  assert.throws(() => localeImageFile(dir, "..\\..\\x@rtl"));
});

test("the setting takes flags only, and off clears it", () => {
  assert.deepEqual(cleanChaos({ locale: { pseudo: true, rtl: "yes", extra: 1 } }), { locale: { pseudo: true } });
  assert.deepEqual(cleanChaos({ locale: { rtl: true } }), { locale: { rtl: true } });
  assert.deepEqual(cleanChaos({ locale: null }), { locale: undefined });
  assert.deepEqual(cleanChaos({ locale: { pseudo: false } }), { locale: undefined });
  assert.throws(() => cleanChaos({ locale: "rtl" }));
});

test("the page script makes text longer and accented, and leaves data alone", () => {
  // The script's own pseudo() through a stand-in window.
  const win: Record<string, unknown> = { __dxLocale: { manual: true } };
  new Function("window", "document", PSEUDO_SCRIPT)(win, { readyState: "loading" });
  const pseudo = (win.__dxPseudo as { pseudo: (s: string) => string }).pseudo;
  const out = pseudo("Save");
  assert.match(out, /^\[Šàṽé ~+\]$/);
  assert.ok(out.length >= "Save".length * 2);
  assert.equal(pseudo("  Orders "), `  ${pseudo("Orders")} `);
  assert.equal(pseudo("42"), "42");
  assert.equal(pseudo("ada@example.com"), "ada@example.com");
  assert.equal(describeLocaleProblem({ kind: "cut-off", text: "Your orders", where: "the Your orders link", path: "/" }), 'Cut off: "Your orders" — the Your orders link on /');
});

// A real page in a headless browser: every CI runner has Chrome.
const browser = findBrowser();
test("a headless check finds cut-off text, overflow and text written into the code", { skip: browser ? false : "no Chrome, Edge, Chromium or Brave here" }, async () => {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    nav a{display:inline-block;width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .save{width:90px;white-space:nowrap}</style></head><body>
    <nav><a href="/">Your orders</a></nav><h1>Welcome back to the shop</h1><button class="save">Speichern</button>
    <div id="list"></div><p>Total: 40 €</p>
    <script>fetch("/api/items").then(r=>r.json()).then(l=>{document.getElementById("list").textContent=l[0].name;});</script></body></html>`;
  fs.writeFileSync(path.join(dir, "src", "index.html"), html);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  const server = http.createServer((q, r) => {
    if (q.url === "/api/items") return r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ name: "Wireless mouse" }]));
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  try {
    const port = (server.address() as { port: number }).port;
    const r = await checkTranslation({ dir, project: "shop-website", baseUrl: `http://127.0.0.1:${port}`, paths: ["/"] });
    const said = r.problems.map((p) => `${p.kind}:${p.text}`);
    assert.ok(said.includes("cut-off:Your orders"), said.join(" | "));
    assert.ok(said.includes("spills:Speichern"), said.join(" | "));
    assert.ok(said.includes("hard-coded:Welcome back to the shop"), said.join(" | "));
    assert.ok(!said.some((s) => s.includes("Wireless mouse")), "API data isn't text to translate");
    assert.ok(!said.some((s) => s.startsWith("hard-coded:Total")), "a filled-in translation is translated");
    assert.equal(r.problems.find((p) => p.text === "Welcome back to the shop")?.file, "src/index.html:4");
    assert.ok(r.fromData >= 1);
    assert.deepEqual(r.pages[0].shots, ["home@pseudo", "home@rtl"]);
    assert.ok(fs.existsSync(localeImageFile(dir, "home@rtl")));
  } finally {
    server.close();
  }
});
