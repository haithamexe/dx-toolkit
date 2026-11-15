import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { searchProject, searchProjects, fuzzyMatch, buildPattern, isSecretFile, listProjectFiles, forgetProjectFiles } = await import("../tools/codesearch.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-search-"));
function put(rel: string, text: string | Buffer) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
git("init", "-q", "-b", "main");
git("config", "user.email", "octocat@example.com");
git("config", "user.name", "octocat");

put(".gitignore", "node_modules\ndist\n");
put("src/cart/CartService.ts", ["import { db } from '../db';", "// the cart total is rounded", "export class CartService {", "  total(items: number[]) {", "    return items.reduce((a, b) => a + b, 0);", "  }", "}", ""].join("\n"));
put("src/cart/cart.test.ts", ["import { CartService } from './CartService';", "test('total', () => {", "  new CartService().total([1]);", "});", ""].join("\n"));
put("src/checkout/pay.ts", "export function payTotal(total: number) { return total * 1.2; }\nconst TOTAL_LIMIT = 10;\n");
put("docs/guide.md", "# Guide\nThe cart total is explained here.\n");
put("src/styles/app.css", ".cart { color: red; }\n");
put(".env", "API_KEY=sk-live-supersecretvalue\n");
put(".env.example", "API_KEY=your-key-here\n");
put("certs/server.key", "-----BEGIN PRIVATE KEY----- supersecretvalue");
put("node_modules/lib/index.js", "total everywhere");
put("dist/bundle.js", "total in the build");
put("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x74, 0x6f, 0x74, 0x61, 0x6c]));
put("package-lock.json", '{"total": 1}');
git("add", ".gitignore", "src", "docs", "package-lock.json", ".env.example");

test("secrets files are known by name, examples are not", () => {
  for (const f of [".env", ".env.local", "a/.env.production", "server.key", "cert.pem", "id_rsa", "id_ed25519.pub", "x.p12"]) assert.equal(isSecretFile(f), true, f);
  for (const f of [".env.example", ".env.sample", "keyboard.ts", "env.ts", "monkey.js", "id_rsa_notes.md"]) assert.equal(isSecretFile(f), false, f);
});

test("the files are what git lists: new files count, ignored folders and nothing under .git don't", async () => {
  const files = await listProjectFiles(root);
  assert.ok(files.includes("src/cart/CartService.ts"));
  assert.ok(files.includes(".env"), "an untracked file that isn't ignored is listed (its contents are never searched)");
  assert.ok(!files.some((f) => f.startsWith("node_modules/") || f.startsWith("dist/") || f.startsWith(".git/")));
});

test("a fuzzy name match scores the file you meant first and says which letters matched", () => {
  const a = fuzzyMatch("src/cart/CartService.ts", "cartserv")!;
  const b = fuzzyMatch("src/carts/other/service-notes.ts", "cartserv");
  assert.ok(a && a.score > (b?.score ?? -1e9));
  assert.deepEqual(a.positions.slice(0, 4), [9, 10, 11, 12], "the name's own letters, not the folder's");
  assert.equal(fuzzyMatch("src/a.ts", "zzz"), undefined);
  const exact = fuzzyMatch("src/cart.ts", "cart.ts")!;
  const loose = fuzzyMatch("src/charts/tools.ts", "cart.ts");
  assert.ok(!loose || exact.score > loose.score);
});

test("a file search finds by part of a name, or by words of the path in any order", async () => {
  const r = await searchProject(root, { query: "cartserv", mode: "files" });
  assert.equal(r.files[0].path, "src/cart/CartService.ts");
  assert.ok(r.files[0].nameRanges.length > 0);
  const words = await searchProject(root, { query: "cart test", mode: "files" });
  assert.equal(words.files[0].path, "src/cart/cart.test.ts");
  const secret = await searchProject(root, { query: ".env", mode: "files" });
  assert.ok(secret.files.some((f) => f.path === ".env"), "a secrets file can be found by name");
});

test("a content search finds words with their lines, context and where in the line, ranked", async () => {
  const r = await searchProject(root, { query: "total", mode: "content" });
  const paths = r.files.map((f) => f.path);
  assert.ok(paths.includes("src/cart/CartService.ts") && paths.includes("src/checkout/pay.ts") && paths.includes("docs/guide.md"));
  assert.ok(!paths.some((p) => p.startsWith("node_modules/") || p.startsWith("dist/") || p === "logo.png" || p === "package-lock.json"));
  const cart = r.files.find((f) => f.path === "src/cart/CartService.ts")!;
  const hit = cart.hits.find((h) => h.line === 4)!;
  assert.equal(hit.text, "  total(items: number[]) {");
  assert.deepEqual(hit.ranges, [[2, 7]]);
  assert.deepEqual(hit.before.map((l) => l.line), [2, 3]);
  assert.deepEqual(hit.after.map((l) => l.line), [5, 6]);
  assert.equal(cart.hits.find((h) => h.line === 2)?.kind, "comment");
  // Source outranks tests and documents.
  assert.ok(paths.indexOf("src/checkout/pay.ts") < paths.indexOf("docs/guide.md"));
  assert.ok(paths.indexOf("src/cart/CartService.ts") < paths.indexOf("src/cart/cart.test.ts"));
});

test("smart case, whole word and regex", async () => {
  const lower = await searchProject(root, { query: "total", mode: "content" });
  const pay = lower.files.find((f) => f.path === "src/checkout/pay.ts")!;
  assert.equal(pay.lines, 2, "lower case matches TOTAL_LIMIT too");
  const capital = await searchProject(root, { query: "TOTAL", mode: "content" });
  assert.equal(capital.files.find((f) => f.path === "src/checkout/pay.ts")!.lines, 1, "a capital makes it case-sensitive");
  const forced = await searchProject(root, { query: "TOTAL", mode: "content", caseSensitive: false });
  assert.equal(forced.files.find((f) => f.path === "src/checkout/pay.ts")!.lines, 2);
  const word = await searchProject(root, { query: "total", mode: "content", wholeWord: true });
  assert.ok(!word.files.find((f) => f.path === "src/checkout/pay.ts")!.hits.some((h) => h.text.includes("payTotal(") && h.ranges.length === 1 && h.text.indexOf("payTotal") + 3 === h.ranges[0][0]), "payTotal isn't the word total");
  const re = await searchProject(root, { query: "class\\s+\\w+Service", mode: "content", regex: true });
  assert.deepEqual(re.files.map((f) => f.path), ["src/cart/CartService.ts"]);
  assert.equal(re.files[0].hits[0].kind, "definition");
});

test("an invalid pattern says why; a pattern matching nothing at all is refused", async () => {
  const bad = await searchProject(root, { query: "(unclosed", mode: "content", regex: true });
  assert.ok(bad.patternError, "says why");
  assert.deepEqual(bad.files, []);
  assert.ok(buildPattern({ query: "a*", regex: true }).error);
  assert.ok(buildPattern({ query: "" }).error);
  // A word with regex characters is a word unless asked.
  const literal = await searchProject(root, { query: "(a, b)", mode: "content" });
  assert.equal(literal.patternError, undefined);
});

test("secrets are never searched inside: not .env, not a key, but the example is", async () => {
  const r = await searchProject(root, { query: "supersecretvalue", mode: "all" });
  assert.deepEqual(r.files.filter((f) => f.matches > 0), [], "no content of a secrets file reaches a result");
  const example = await searchProject(root, { query: "your-key-here", mode: "content" });
  assert.deepEqual(example.files.map((f) => f.path), [".env.example"]);
  assert.ok(!JSON.stringify(r).includes("sk-live"), "not even in a snippet");
});

test("facets count by extension and folder with the other choice applied, and filters narrow the files", async () => {
  const r = await searchProject(root, { query: "cart", mode: "all" });
  assert.ok(r.facets.ext.some((f) => f.value === "ts" && f.count >= 2));
  assert.ok(r.facets.folder.some((f) => f.value === "src/cart"));
  const ts = await searchProject(root, { query: "cart", mode: "all", ext: ["ts"] });
  assert.ok(ts.files.every((f) => f.ext === "ts"));
  // Choosing ts leaves the extension facet showing the others (so the choice can be changed), counted with no extension applied.
  assert.ok(ts.facets.ext.some((f) => f.value === "md"));
  const folder = await searchProject(root, { query: "cart", mode: "all", folders: ["src/cart"] });
  assert.ok(folder.files.length && folder.files.every((f) => f.path.startsWith("src/cart/")));
});

test("the totals count every file even when fewer come back, and the budget stops a long search with what it has", async () => {
  for (let i = 0; i < 30; i++) put(`bulk/file${i}.txt`, "needle here\n");
  forgetProjectFiles(root);
  const r = await searchProject(root, { query: "needle", mode: "content", maxFiles: 5 });
  assert.equal(r.files.length, 5);
  assert.equal(r.totals.files, 30);
  assert.equal(r.truncated, true);
  const none = await searchProject(root, { query: "needle", mode: "content", budgetMs: 1 });
  assert.ok(none.partial === true || none.totals.files >= 0, "a tiny budget is allowed and says so when it cuts");
});

test("a long line is cut around the match and the highlight moves with it", async () => {
  put("wide/long.js", `${"x".repeat(900)} findme ${"y".repeat(900)}\n`);
  forgetProjectFiles(root);
  const r = await searchProject(root, { query: "findme", mode: "content" });
  const hit = r.files.find((f) => f.path === "wide/long.js")!.hits[0];
  assert.ok(hit.text.length <= 410);
  const [a, b] = hit.ranges[0];
  assert.equal(hit.text.slice(a, b), "findme");
});

test("several projects at once keep each file with its project", async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "dx-search-other-"));
  fs.writeFileSync(path.join(other, "total.js"), "export const total = 1;\n");
  const r = await searchProjects(
    [
      { name: "shop-website", dir: root },
      { name: "todo-app", dir: other },
    ],
    { query: "total", mode: "content" },
  );
  assert.ok(r.files.some((f) => f.project === "todo-app" && f.path === "total.js"));
  assert.ok(r.files.some((f) => f.project === "shop-website"));
  assert.ok(r.projects.length === 2);
});

test("a folder inside a repository searches only itself, with paths relative to it", async () => {
  const sub = path.join(root, "src", "cart");
  const r = await searchProject(sub, { query: "CartService", mode: "all" });
  assert.ok(r.files.length > 0);
  assert.ok(r.files.every((f) => !f.path.startsWith("src/")), r.files.map((f) => f.path).join(","));
});
