import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-visual-test-"));
const {
  addToVisualIndex,
  appendActivity,
  captureNames,
  captureVisual,
  describeCapture,
  describeRegion,
  diffPixels,
  findBrowser,
  formatRatio,
  listVisual,
  nextActivityId,
  pathSlug,
  pruneVisualFolders,
  readVisualIndex,
  topVisitedPaths,
  visualFolder,
  visualImageFile,
  VisualError,
} = await import("../index.js");
type VisualCommit = import("../index.js").VisualCommit;

const hex = (n: number) => n.toString(16).padStart(40, "0");
const entry = (n: number, at: number, extra: Partial<VisualCommit> = {}): VisualCommit => ({
  commit: hex(n),
  at: new Date(at).toISOString(),
  captures: [{ name: "home@desktop", path: "/", viewport: "desktop", width: 1280, height: 800 }],
  ...extra,
});

test("paths become file names, unique per viewport", () => {
  assert.equal(pathSlug("/"), "home");
  assert.equal(pathSlug("/cart/items"), "cart-items");
  assert.equal(pathSlug("/#/orders"), "orders");
  assert.equal(pathSlug("/../../etc"), "etc");
  const names = captureNames(["/cart", "/Cart", "/"], "mobile").map((n) => n.name);
  assert.deepEqual(names, ["cart@mobile", "cart-2@mobile", "home@mobile"]);
});

test("the index keeps the newest commits, replaces a recapture, and the rest's folders go", () => {
  const dir = path.join(os.tmpdir(), "shop-website");
  let index = readVisualIndex(dir);
  assert.deepEqual(index.commits, []);
  const removedAll: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const r = addToVisualIndex(index, entry(i, Date.UTC(2026, 0, i)), 3);
    index = r.index;
    removedAll.push(...r.removed);
  }
  assert.deepEqual(index.commits.map((c) => c.commit), [hex(5), hex(4), hex(3)], "newest first, three kept");
  assert.deepEqual(removedAll, [hex(1), hex(2)]);
  // Capturing a commit again replaces its entry rather than adding one.
  index = addToVisualIndex(index, entry(4, Date.UTC(2026, 0, 9)), 3).index;
  assert.deepEqual(index.commits.map((c) => c.commit), [hex(4), hex(5), hex(3)]);

  const folder = visualFolder(dir);
  for (const n of [1, 2, 3, 4, 5]) fs.mkdirSync(path.join(folder, hex(n)), { recursive: true });
  fs.mkdirSync(path.join(folder, "notes"), { recursive: true });
  const removed = pruneVisualFolders(dir, index);
  assert.deepEqual(removed.sort(), [hex(1), hex(2)]);
  assert.ok(fs.existsSync(path.join(folder, "notes")), "a folder dx didn't make is left alone");
  assert.ok(fs.existsSync(path.join(folder, hex(3))));
});

test("an image is found only by a captured commit, a name it has and a known kind", () => {
  const dir = path.join(os.tmpdir(), "todo-app");
  const folder = visualFolder(dir);
  const commit = hex(0xabc);
  fs.mkdirSync(path.join(folder, commit), { recursive: true });
  fs.writeFileSync(path.join(folder, commit, "home@desktop.png"), "png");
  fs.writeFileSync(path.join(folder, commit, "home@desktop.diff.png"), "png");
  fs.writeFileSync(path.join(folder, commit, "thumb.png"), "png");
  const index = addToVisualIndex(readVisualIndex(dir), entry(0xabc, Date.now(), {
    thumb: true,
    captures: [
      { name: "home@desktop", path: "/", viewport: "desktop", width: 1280, height: 800, changed: true, diff: true, ratio: 0.1 },
      { name: "cart@desktop", path: "/cart", viewport: "desktop", width: 1280, height: 800, changed: false, ratio: 0 },
    ],
  })).index;
  fs.writeFileSync(path.join(folder, "index.json"), JSON.stringify(index));

  assert.equal(visualImageFile(dir, commit, "home@desktop"), path.join(folder, commit, "home@desktop.png"));
  assert.equal(visualImageFile(dir, commit.slice(0, 12), "home@desktop", "diff"), path.join(folder, commit, "home@desktop.diff.png"));
  assert.equal(visualImageFile(dir, commit, undefined, "thumb"), path.join(folder, commit, "thumb.png"));

  const refused = (fn: () => unknown, status: number, what: string) =>
    assert.throws(fn, (err: unknown) => err instanceof VisualError && err.status === status, what);
  refused(() => visualImageFile(dir, "HEAD", "home@desktop"), 400, "a commit that isn't hex");
  refused(() => visualImageFile(dir, "--output=x", "home@desktop"), 400, "an option as a commit");
  refused(() => visualImageFile(dir, `${commit}/..`, "home@desktop"), 400, "a path as a commit");
  refused(() => visualImageFile(dir, commit, "../index.json"), 400, "a path with ..");
  refused(() => visualImageFile(dir, commit, "..\\..\\config"), 400, "a Windows path with ..");
  refused(() => visualImageFile(dir, commit, "home@desktop.png"), 400, "a file name, not a capture name");
  refused(() => visualImageFile(dir, commit, "orders@desktop"), 404, "a capture the commit doesn't have");
  refused(() => visualImageFile(dir, commit, "cart@desktop", "diff"), 404, "a diff for a page that didn't change");
  refused(() => visualImageFile(dir, commit, "home@desktop", "source"), 400, "an unknown kind");
  refused(() => visualImageFile(dir, hex(0xdef), "home@desktop"), 404, "a commit that wasn't captured");
});

test("pixels are compared with a tolerance, giving the box of the change", () => {
  const w = 4;
  const h = 3;
  const a = new Uint8ClampedArray(w * h * 4).fill(200);
  const b = new Uint8ClampedArray(a);
  b[(1 * w + 2) * 4] = 210; // within the tolerance
  assert.equal(diffPixels(a, b, new Uint8ClampedArray(a.length), w, h, 24).count, 0);
  b[(1 * w + 1) * 4 + 2] = 0;
  b[(2 * w + 3) * 4 + 1] = 0;
  const out = new Uint8ClampedArray(a.length);
  const r = diffPixels(a, b, out, w, h, 24);
  assert.equal(r.count, 2);
  assert.deepEqual(r.box, { x: 1, y: 1, width: 3, height: 2 });
  assert.deepEqual([...out.slice((1 * w + 1) * 4, (1 * w + 1) * 4 + 4)], [255, 106, 0, 255], "a changed pixel is highlighted");
});

test("a change is described in words", () => {
  assert.equal(describeRegion({ x: 0, y: 0, width: 1280, height: 800 }, 1280, 800), "across most of the page");
  assert.equal(describeRegion({ x: 10, y: 10, width: 100, height: 40 }, 1280, 800), "near the top left");
  assert.equal(describeRegion({ x: 600, y: 700, width: 80, height: 40 }, 1280, 800), "near the bottom");
  assert.equal(formatRatio(0.1234), "12%");
  assert.equal(formatRatio(0.034), "3.4%");
  assert.equal(formatRatio(0.00001), "under 0.1%");
  const base = { name: "home@desktop", path: "/", viewport: "desktop" as const, width: 1280, height: 800 };
  assert.equal(describeCapture({ ...base, changed: true, ratio: 0.12, box: { x: 900, y: 600, width: 200, height: 60 }, label: "the Checkout button" }), "12% of the page changed, around the Checkout button");
  assert.equal(describeCapture({ ...base, changed: false, ratio: 0 }), "Looks the same");
  assert.equal(describeCapture(base), "Nothing to compare with yet");
});

test("the pages captured are the most visited of the last day, on this computer, not dx's own checks", () => {
  const dir = path.join(os.tmpdir(), "api-gateway");
  const now = Date.now();
  const ev = (url: string, extra: object = {}) => ({ id: nextActivityId(), at: new Date(now - 60_000).toISOString(), dir, project: "api-gateway", type: "page" as const, text: url, url, from: "proxy" as const, ...extra });
  appendActivity([
    ev("http://api-gateway.localhost/cart"),
    ev("http://api-gateway.localhost/cart?id=7"),
    ev("http://localhost:5173/cart"),
    ev("http://localhost:5173/"),
    ev("http://localhost:5173/#/orders", { type: "route" }),
    ev("http://localhost:5173/admin", { from: "check" }),
    ev("http://localhost:5173/admin", { from: "check" }),
    ev("http://localhost:5173/missing", { status: 404 }),
    ev("https://example.com/elsewhere"),
  ]);
  assert.deepEqual(topVisitedPaths(dir, { now }), ["/cart", "/", "/#/orders"]);
  assert.deepEqual(topVisitedPaths(dir, { now, limit: 1 }), ["/cart"]);
  assert.deepEqual(topVisitedPaths(path.join(os.tmpdir(), "no-history")), []);
});

// ---------------------------------------------------------------- a real browser

const browser = findBrowser();
const opts = { skip: browser ? false : "no Chrome, Edge, Chromium or Brave here" };

let colour = "#2a9d8f";
let server: http.Server;
let base = "";
before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Shop</title>
<style>body{margin:0;font:16px sans-serif;background:#fff} h1{margin:24px} button{position:absolute;left:900px;top:600px;width:200px;height:60px;border:0;background:${colour};color:#fff;font-size:20px;transition:background 3s;animation:pulse 1s infinite}
@keyframes pulse{from{opacity:.2}to{opacity:1}}</style>
<h1>${req.url === "/cart" ? "Your cart" : "Shop"}</h1><button>Checkout</button>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("a page captured twice without a change looks the same; a changed colour is found with its box", { ...opts, timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-visual-shop-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "commit.gpgsign", "false");
  const commit = (msg: string) => {
    fs.writeFileSync(path.join(dir, "notes.txt"), msg);
    git("add", "notes.txt");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const capture = (hash: string) => captureVisual({ dir, project: "shop-website", baseUrl: base, commit: hash, paths: ["/", "/cart"], settleMs: 200 });

  const first = await capture(commit("first"));
  assert.equal(first.captures.length, 2);
  assert.ok(first.captures.every((c) => !c.error), JSON.stringify(first.captures));
  assert.equal(first.changed, undefined, "nothing to compare the first capture with");
  assert.equal(first.thumb, true);

  const same = await capture(commit("no visible change"));
  assert.equal(same.against, first.commit, "compared with its parent's capture");
  assert.equal(same.changed, false, JSON.stringify(same.captures));
  assert.ok(same.captures.every((c) => c.changed === false && !c.diff));

  colour = "#e76f51";
  const changed = await capture(commit("orange checkout"));
  assert.equal(changed.changed, true);
  const home = changed.captures.find((c) => c.path === "/")!;
  assert.equal(home.changed, true);
  assert.ok(home.ratio! > 0.005 && home.ratio! < 0.03, `about 200×60 of 1280×800: ${home.ratio}`);
  const box = home.box!;
  assert.ok(Math.abs(box.x - 900) <= 2 && Math.abs(box.y - 600) <= 2 && Math.abs(box.width - 200) <= 4 && Math.abs(box.height - 60) <= 4, JSON.stringify(box));
  assert.equal(home.label, "the Checkout button");
  assert.match(describeCapture(home), /of the page changed, around the Checkout button/);
  assert.ok(fs.statSync(visualImageFile(dir, changed.commit, home.name, "diff")).size > 100, "a diff image was saved");

  assert.deepEqual(listVisual(dir).map((c) => c.commit), [changed.commit, same.commit, first.commit]);
});
