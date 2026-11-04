import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-bug-home-"));
const { appendActivity, buildBugBundle, bundleUrl, compareReplay, exportBugBundle, nextActivityId, readBugBundle, BugBundleError, BUG_MAX_BYTES } = await import("../index.js");
type ActivityEvent = import("../index.js").ActivityEvent;

// A made-up user's machine: the paths a stack would carry there.
const winProject = "C:\\Users\\octocat\\code\\shop-website";
const winHome = "C:\\Users\\octocat";

function event(over: Partial<ActivityEvent>): ActivityEvent {
  return { id: nextActivityId(), at: new Date().toISOString(), dir: winProject, project: "shop-website", type: "console", text: "", from: "browser", ...over };
}

test("a bundle keeps no host, no credentials and no folder of this computer", () => {
  const target = event({
    type: "error",
    text: "TypeError: cart.items is undefined",
    page: "http://shop-website.localhost:1355/cart?token=abc123secret",
    source: "http://localhost:5173/src/cart.js:12:5",
    stack: [
      "TypeError: cart.items is undefined",
      "    at total (http://localhost:5173/src/cart.js:12:5)",
      `    at load (${winProject}\\src\\load.js:3:1)`,
      `    at node (file:///C:/Users/octocat/code/shop-website/server/index.js:9:2)`,
      `    at other (${winHome}\\AppData\\npm\\cli.js:1:1)`,
      "    at mac (/Users/someone/elsewhere/x.js:2:2)",
    ].join("\n"),
    visit: "v1",
  });
  const request = event({
    type: "request",
    from: "proxy",
    text: "POST /api/cart → 500",
    url: "/api/cart?session_id=s3cr3t",
    method: "POST",
    status: 500,
    requestHeaders: { "content-type": "application/json", cookie: "sid=abc", authorization: "Bearer abcdefghijklmnop", host: "shop-website.localhost:1355", referer: "http://shop-website.localhost:1355/cart" },
    responseHeaders: { "content-type": "application/json", "set-cookie": "sid=abc" },
    requestBody: JSON.stringify({ id: 7, password: "hunter2", path: `${winProject}\\data.json` }),
    responseBody: JSON.stringify({ error: "out of stock" }),
  });
  const b = buildBugBundle(target, [request], { projectName: "shop-website", projectDir: winProject, home: winHome, steps: [{ click: "#add" }, { goto: "http://shop-website.localhost:1355/checkout" }], start: "http://shop-website.localhost:1355/" });
  const text = JSON.stringify(b);
  for (const bad of ["octocat", "someone", "hunter2", "abc123secret", "s3cr3t", "sid=abc", "abcdefghijklmnop", "1355", "5173", "localhost"]) assert.ok(!text.includes(bad), `${bad} is in the bundle: ${text}`);
  assert.equal(b.format, "dx-bug");
  assert.equal(b.version, 1);
  assert.equal(b.dev.start, "/");
  assert.match(b.dev.page ?? "", /^\/cart\?token=/);
  assert.equal(b.error.source, "/src/cart.js:12:5");
  assert.match(b.error.stack ?? "", /at load \(src\\load\.js:3:1\)/);
  assert.match(b.error.stack ?? "", /at node \(server\/index\.js:9:2\)/);
  assert.match(b.error.stack ?? "", /at other \(~\\AppData/);
  assert.deepEqual(b.steps, [{ click: "#add" }, { goto: "/checkout" }]);
  const req = b.events.find((e) => e.type === "request")!;
  assert.deepEqual(req.requestHeaders, { "content-type": "application/json" }, "only plain headers: no cookie, authorization, host or referer");
  assert.deepEqual(JSON.parse(req.requestBody!), { id: 7, password: "•••", path: "data.json" });
  assert.ok(!("dir" in req) && !("project" in req), "events carry no folder");
  // What it wrote, it reads back.
  assert.deepEqual(readBugBundle(text).steps, b.steps);
});

test("a bundle from a file is checked strictly", () => {
  const good = buildBugBundle(event({ type: "error", text: "Boom" }), [], { projectName: "shop-website", projectDir: winProject, home: winHome, steps: [{ click: "text=Pay" }], git: { commit: "a".repeat(40), dirty: false, from: "reflog" } });
  const with_ = (patch: Record<string, unknown>) => JSON.stringify({ ...good, ...patch });
  const refuses = (raw: unknown, re: RegExp, status = 400) =>
    assert.throws(
      () => readBugBundle(raw),
      (err: unknown) => err instanceof BugBundleError && err.status === status && re.test(err.message),
    );
  assert.equal(readBugBundle(JSON.stringify(good)).git?.commit, "a".repeat(40));
  refuses("not json", /isn't JSON/);
  refuses(with_({ format: "something-else" }), /isn't a dx bug bundle/);
  refuses(with_({ version: 2 }), /version 2/);
  refuses(with_({ extra: 1 }), /no field "extra"/);
  refuses(with_({ git: { commit: "not-hex!", dirty: false } }), /isn't a commit hash/);
  refuses(with_({ git: { commit: "--upload-pack=x", dirty: false } }), /isn't a commit hash/);
  refuses(with_({ steps: [{ goto: "https://evil.example/steal" }] }), /another computer/);
  refuses(with_({ steps: [{ goto: "//evil.example/x" }] }), /another computer/);
  refuses(with_({ steps: [{ click: "#a", evaluate: "alert(1)" }] }), /doesn't take: "evaluate"/);
  refuses(with_({ steps: [{}] }), /doesn't say what to do/);
  refuses(with_({ dev: { start: "https://evil.example/" } }), /another computer/);
  refuses(with_({ steps: Array.from({ length: 51 }, () => ({ click: "#a" })) }), /at most 50/);
  refuses(with_({ error: { type: "nonsense", text: "x" } }), /isn't a kind of event/);
  refuses("x".repeat(BUG_MAX_BYTES + 1), /too large/, 413);
  refuses(with_({ events: [{ type: "console", text: "x".repeat(BUG_MAX_BYTES) }] }), /too large/, 413);
  // A loopback address keeps only its path: the importer's own server is what's reached.
  assert.deepEqual(readBugBundle(with_({ steps: [{ goto: "http://localhost:9999/orders" }] })).steps, [{ goto: "/orders" }]);
  // Bodies are masked again on the way in, whatever the file says; unknown headers are dropped.
  const masked = readBugBundle(with_({ events: [{ type: "request", text: "POST /login", requestHeaders: { "content-type": "application/json", cookie: "a=b" }, requestBody: '{"password":"hunter2"}' }] }));
  assert.equal(masked.events[0].requestBody, '{"password":"•••"}');
  assert.deepEqual(masked.events[0].requestHeaders, { "content-type": "application/json" });
  assert.equal(bundleUrl("http://shop-website.localhost:1355", { dev: { start: "/cart?x=1" } }), "http://shop-website.localhost:1355/cart?x=1");
});

test("exporting from the history: the visit's steps, the commit at that moment, and dirty", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dx-bug-")), "shop-website");
  fs.mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "octocat@example.com");
  git("config", "user.name", "octocat");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "cart.js"), "export {};\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Cart");
  const head = git("rev-parse", "HEAD");
  await new Promise((r) => setTimeout(r, 1100)); // the reflog counts in seconds

  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  const base = { dir, project: "shop-website", visit: "visit-01" + now.toString(36) } as const;
  const events: ActivityEvent[] = [
    { ...base, id: nextActivityId(now), at: at(0), type: "page", text: "GET / → 200", from: "proxy", url: "/", visit: undefined },
    { ...base, id: nextActivityId(now + 1), at: at(10), type: "action", text: "Clicked button “Add”", target: "#add", from: "browser", page: "http://shop-website.localhost/" },
    { ...base, id: nextActivityId(now + 2), at: at(20), type: "console", level: "error", text: "Cart failed: 500", from: "browser", page: "http://shop-website.localhost/", source: `${dir}${path.sep}cart.js:3:1` },
  ];
  appendActivity(events);
  fs.writeFileSync(path.join(dir, "cart.js"), "export const changed = 1;\n");
  const b = await exportBugBundle({ name: "shop-website", dir, hasGit: true }, events[2].id);
  assert.equal(b.git?.commit, head);
  assert.equal(b.git?.branch, "main");
  assert.equal(b.git?.dirty, true);
  assert.deepEqual(b.steps, [{ click: "#add" }]);
  assert.equal(b.dev.start, "/");
  assert.equal(b.error.text, "Cart failed: 500");
  assert.equal(b.error.source, "cart.js:3:1", "the project's folder is gone from the path");
  assert.ok(b.notes.some((n) => /weren't committed/.test(n)));
  assert.ok(!JSON.stringify(b).includes(dir) && !JSON.stringify(b).includes(dir.replace(/\\/g, "/")));
  await assert.rejects(exportBugBundle({ name: "shop-website", dir }, 12345), /isn't in the history/);
});

test("comparing a replay with the original error", () => {
  const original = { id: 1, at: new Date().toISOString(), type: "error" as const, text: "Uncaught TypeError: cart.items is undefined (line 12)", source: "/src/cart.js:12:5" };
  const page = (over: object) => ({ url: "", ok: false, ms: 1, exceptions: [], consoleErrors: [], consoleWarnings: [], failedRequests: [], browser: "chrome", ...over });
  const same = compareReplay(original, page({ exceptions: [{ text: "TypeError: cart.items is undefined (line 13)\n    at total", source: "http://localhost:4100/src/cart.js:12:9" }] }));
  assert.equal(same.reproduced, true);
  assert.equal(same.summary, "Reproduced: the same error at src/cart.js:12");
  const byPlace = compareReplay(original, page({ consoleErrors: [{ text: "Something else", source: "http://shop.localhost/src/cart.js?t=123:12:1" }] }));
  assert.equal(byPlace.reproduced, true, "the same file and line counts");
  const other = compareReplay(original, page({ consoleErrors: [{ text: "Unrelated", source: "/src/other.js:1:1" }] }));
  assert.equal(other.reproduced, false);
  assert.equal(other.summary, "Not reproduced: 1 other problem this time");
  assert.equal(compareReplay(original, page({ ok: true })).summary, "Not reproduced: no problems this time");
  const req = { id: 2, at: original.at, type: "request" as const, text: "POST /api/orders/42 → 500", method: "POST", url: "/api/orders/42", status: 500 };
  assert.equal(compareReplay(req, page({ failedRequests: [{ url: "http://shop.localhost:1355/api/orders/77", method: "POST", status: 500 }] })).reproduced, true, "ids folded");
  assert.equal(compareReplay(req, page({ failedRequests: [{ url: "http://shop.localhost/api/orders/77", method: "POST", status: 404 }] })).reproduced, false);
  assert.equal(compareReplay(original, undefined, [{ id: "x", kind: "runtime", message: "TypeError: cart.items is undefined (line 2)", lines: [], count: 1, firstLine: 1, lastLine: 1, firstSeen: "", lastSeen: "", resolved: false }]).reproduced, true, "a server error counts");
});
