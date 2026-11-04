import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-activity-test-"));
const {
  activityFolder,
  activityUsage,
  appendActivity,
  bugReport,
  clearActivity,
  formatActivity,
  isProblem,
  nextActivityId,
  parseSince,
  pruneActivity,
  readActivity,
  replayFromVisit,
  reportContext,
  listTerminals,
  terminalIds,
} = await import("../index.js");
type Ev = import("../index.js").ActivityEvent;

const shop = path.join(os.tmpdir(), "dx-activity-shop");
const blog = path.join(os.tmpdir(), "dx-activity-blog");

function ev(dir: string, at: Date, fields: Partial<Ev>): Ev {
  return { id: nextActivityId(at.getTime()), at: at.toISOString(), dir, project: path.basename(dir), type: "action", text: "Clicked button", from: "browser", ...fields };
}

test("ids keep increasing, also within one millisecond", () => {
  const a = nextActivityId(1000);
  const b = nextActivityId(1000);
  const c = nextActivityId(999);
  assert.ok(b > a && c > b);
});

test("writes one file per project and day, and reads back with filters", () => {
  clearActivity();
  const now = new Date();
  const earlier = new Date(now.getTime() - 3 * 60_000);
  appendActivity([
    ev(shop, earlier, { type: "page", text: "GET / → 200", status: 200, from: "proxy" }),
    ev(shop, earlier, { type: "action", text: "Clicked button “Add to cart”" }),
    ev(shop, now, { type: "request", text: "POST /api/cart → 500", method: "POST", status: 500, requestBody: '{"id":7}', responseBody: '{"error":"out of stock"}', from: "proxy" }),
    ev(shop, now, { type: "console", level: "error", text: "Cart failed to load", source: "/src/cart.ts:12:5" }),
    ev(blog, now, { type: "route", text: "/ → /posts/1" }),
  ]);
  assert.ok(fs.existsSync(activityFolder(shop)));
  assert.notEqual(activityFolder(shop), activityFolder(blog));
  if (process.platform !== "win32") assert.equal(fs.statSync(fs.readdirSync(activityFolder(shop)).map((f) => path.join(activityFolder(shop), f))[0]).mode & 0o777, 0o600);

  const all = readActivity();
  assert.equal(all.length, 5);
  assert.ok(all.every((e, i) => i === 0 || e.id > all[i - 1].id), "oldest first");
  assert.deepEqual(readActivity({ dir: shop }).map((e) => e.type), ["page", "action", "request", "console"]);
  assert.deepEqual(readActivity({ types: ["route"] }).map((e) => e.project), ["dx-activity-blog"]);
  assert.deepEqual(readActivity({ problems: true }).map((e) => e.text), ["POST /api/cart → 500", "Cart failed to load"]);
  assert.deepEqual(readActivity({ search: "OUT OF STOCK" }).map((e) => e.type), ["request"], "searches bodies, case ignored");
  assert.equal(readActivity({ since: new Date(now.getTime() - 60_000) }).length, 3);
  assert.equal(readActivity({ limit: 2 }).length, 2);
  assert.deepEqual(readActivity({ limit: 2 }).map((e) => e.type), ["console", "route"], "the newest ones");
  const last = all[2].id;
  assert.equal(readActivity({ after: last }).length, 2);
});

test("listed in the order things happened, though the page's events arrive a moment late", () => {
  clearActivity();
  const now = Date.now();
  // The request the click caused is recorded first; the click comes in with the page's next batch.
  const request = ev(shop, new Date(now - 200), { type: "request", text: "POST /api/cart → 409" });
  const click = { ...ev(shop, new Date(now - 250), { text: "Clicked button “Add to cart”" }), id: nextActivityId() };
  assert.ok(click.id > request.id);
  appendActivity([request, click]);
  assert.deepEqual(readActivity({ dir: shop }).map((e) => e.type), ["action", "request"]);
  clearActivity();
});

test("a line cut short is skipped, and old days are deleted", () => {
  clearActivity();
  const today = new Date();
  const old = new Date(today.getTime() - 10 * 86_400_000);
  appendActivity([ev(shop, old, { text: "long ago" }), ev(shop, today, { text: "today" })]);
  const todayFile = fs.readdirSync(activityFolder(shop)).sort().at(-1)!;
  fs.appendFileSync(path.join(activityFolder(shop), todayFile), '{"id": 1, "at": "cut sh');
  assert.deepEqual(readActivity({ dir: shop }).map((e) => e.text), ["long ago", "today"]);
  assert.equal(pruneActivity(7), 1);
  assert.deepEqual(readActivity({ dir: shop }).map((e) => e.text), ["today"]);
  clearActivity(shop);
  assert.equal(readActivity().length, 0);
});

test("a day that reaches its limit keeps events without bodies, then only problems; the total is capped too", () => {
  clearActivity();
  const at = new Date();
  const big = "x".repeat(4000);
  appendActivity([ev(shop, at, { type: "request", text: "GET /api/poll → 200", responseBody: big, from: "proxy" })], 3000);
  appendActivity([ev(shop, at, { type: "request", text: "GET /api/poll → 200", responseBody: big, requestHeaders: { accept: "*/*" }, from: "proxy" })], 3000);
  let list = readActivity({ dir: shop });
  assert.equal(list.length, 2);
  assert.equal(list[0].responseBody, big, "under the limit: kept whole");
  assert.equal(list[1].responseBody, undefined, "over it: without bodies");
  assert.equal(list[1].requestHeaders, undefined);
  assert.equal(list[1].trimmed, true);
  appendActivity(
    [
      ev(shop, at, { type: "request", text: "GET /api/poll → 200", from: "proxy" }),
      ev(shop, at, { type: "error", text: "Uncaught TypeError", stack: big }),
    ],
    2000,
  );
  list = readActivity({ dir: shop });
  assert.deepEqual(list.slice(2).map((e) => e.type), ["error"], "past twice the limit: only problems");
  assert.equal(list[2].stack, undefined);

  const usage = activityUsage();
  assert.equal(usage.projects.length, 1);
  assert.equal(usage.projects[0].project, "dx-activity-shop");
  assert.ok(usage.bytes > 4000);

  // Over the total: the oldest days go first.
  const old = new Date(at.getTime() - 2 * 86_400_000);
  appendActivity([ev(blog, old, { text: "two days ago", stack: big })]);
  const removed = pruneActivity(7, new Date(), usage.bytes + 100);
  assert.equal(removed, 1);
  assert.deepEqual(readActivity({ dir: blog }), []);
  assert.equal(readActivity({ dir: shop }).length, 3, "today's is kept");
  clearActivity();
});

test("a bug report: the steps, what went wrong, the requests, the stack", () => {
  clearActivity();
  const t = Date.now();
  const at = (ms: number) => new Date(t - 60_000 + ms);
  const visit = "abcdefgh" + (t - 60_000).toString(36);
  appendActivity([
    ev(shop, at(0), { type: "page", text: "GET / → 200", url: "/", from: "proxy" }),
    ev(shop, at(100), { type: "action", text: "Clicked button “Add to cart”", target: "#add", visit, page: "http://shop.localhost/" }),
    ev(shop, at(150), { type: "route", text: "/ → /cart", visit, page: "http://shop.localhost/cart" }),
    ev(shop, at(200), { type: "request", text: "POST /api/cart → 409", method: "POST", status: 409, requestBody: '{"id":7,"password":"•••"}', responseBody: '{"error":"Only 1 left"}', from: "proxy" }),
    ev(shop, at(300), { type: "error", level: "error", text: "Uncaught TypeError: Cannot read properties of null (reading 'items')", stack: "TypeError: …\n    at /src/cart.ts:12:5", source: "/src/cart.ts:12:5", visit, page: "http://shop.localhost/cart" }),
    ev(blog, at(310), { type: "action", text: "Clicked link “Other project”" }),
  ]);
  const target = readActivity({ dir: shop, types: ["error"] })[0];
  const { target: found, events } = reportContext(shop, target.id);
  assert.equal(found?.id, target.id);
  assert.ok(!events.some((e) => e.dir === blog), "only this project");
  const md = bugReport(found!, events);
  assert.match(md, /^## Uncaught TypeError: Cannot read properties of null \(reading 'items'\)/);
  assert.match(md, /- \*\*Where in the code\*\*: `\/src\/cart\.ts:12:5`/);
  assert.match(md, /### Steps\n\n1\. Opened \/\n2\. Clicked button “Add to cart”\n3\. Went \/ → \/cart/);
  assert.match(md, /- \*\*Request failed\*\* at .*: POST \/api\/cart → 409/);
  assert.match(md, /"password": "•••"/);
  assert.match(md, /"error": "Only 1 left"/);
  assert.match(md, /### Stack: Uncaught TypeError/);
  assert.equal(reportContext(shop, 12345).target, undefined);
  clearActivity();
});

test("replay: the page a visit started on, its clicks, and waiting where a click changed the address", () => {
  const t = new Date();
  const visit = [
    ev(shop, t, { type: "action", text: "Clicked button “Add to cart”", target: "#add", page: "http://shop.localhost/" }),
    ev(shop, new Date(t.getTime() + 50), { type: "route", text: "/ → /cart", page: "http://shop.localhost/cart" }),
    ev(shop, new Date(t.getTime() + 100), { type: "console", text: "added", page: "http://shop.localhost/cart" }),
    ev(shop, new Date(t.getTime() + 200), { type: "action", text: "Clicked link “Checkout” (/checkout)", page: "http://shop.localhost/cart" }),
    ev(shop, new Date(t.getTime() + 300), { type: "action", text: "Submitted form “login” (POST /login)", page: "http://shop.localhost/checkout" }),
    ev(shop, new Date(t.getTime() + 400), { type: "route", text: "/checkout → /cart (back or forward)", page: "http://shop.localhost/cart" }),
    ev(shop, new Date(t.getTime() + 500), { type: "request", text: "GET /api/x → 200", from: "proxy" }),
  ];
  const r = replayFromVisit(visit);
  assert.ok(r);
  assert.equal(r.url, "http://shop.localhost/");
  assert.deepEqual(r.steps, [{ click: "#add" }, { waitFor: "url=/cart" }, { click: "text=Checkout" }]);
  assert.equal(r.notes.length, 2, JSON.stringify(r.notes));
  assert.equal(replayFromVisit([ev(shop, t, { type: "request", text: "GET / → 200", from: "proxy" })]), undefined, "nothing from the page itself");
});

test("since reads durations, days, times and dates", () => {
  const now = new Date(2026, 10, 4, 15, 0, 0);
  assert.equal(parseSince("30m", now)?.getTime(), now.getTime() - 30 * 60_000);
  assert.equal(parseSince("2h", now)?.getTime(), now.getTime() - 2 * 3_600_000);
  assert.equal(parseSince("3d", now)?.getTime(), now.getTime() - 3 * 86_400_000);
  assert.equal(parseSince("today", now)?.getHours(), 0);
  assert.equal(parseSince("yesterday", now)?.getDate(), 3);
  assert.equal(parseSince("14:30", now)?.getMinutes(), 30);
  assert.equal(parseSince("2026-11-01", now)?.getUTCDate(), 1);
  assert.equal(parseSince("soon", now), undefined);
});

test("problems, and the text agents and the terminal get", () => {
  const at = new Date();
  assert.ok(isProblem(ev(shop, at, { type: "request", status: 404 })));
  assert.ok(isProblem(ev(shop, at, { type: "request", error: "ECONNREFUSED" })));
  assert.ok(!isProblem(ev(shop, at, { type: "request", status: 201 })));
  assert.ok(isProblem(ev(shop, at, { type: "console", level: "warn" })));
  assert.ok(!isProblem(ev(shop, at, { type: "console", level: "log" })));
  assert.ok(isProblem(ev(shop, at, { type: "server-error", text: "TS2304" })));
  const text = formatActivity([ev(shop, at, { type: "request", text: "POST /api/cart → 500", ms: 34, requestBody: '{"id":7}', responseBody: "x".repeat(50) })], { bodies: true, project: true, maxBody: 10 });
  assert.match(text, /request dx-activity-shop POST \/api\/cart → 500 {2}\(34 ms\)/);
  assert.match(text, /→ \{"id":7\}/);
  assert.match(text, /← x{10} …/);
});

test("terminals: the ones dx knows here, and exactly one in use when any is installed", async () => {
  const ids = terminalIds();
  assert.ok(ids.length >= 3);
  if (process.platform === "win32") assert.ok(ids.includes("cmd") && ids.includes("windows-terminal") && ids.includes("git-bash"));
  if (process.platform === "darwin") assert.ok(ids.includes("terminal") && ids.includes("iterm"));
  const list = await listTerminals("not-a-terminal");
  assert.deepEqual(list.map((t) => t.id), ids);
  const installed = list.filter((t) => t.installed);
  assert.equal(list.filter((t) => t.selected).length, installed.length ? 1 : 0);
  if (installed.length) assert.equal(list.find((t) => t.selected)!.id, installed[0].id, "an unknown choice falls back to the first one found");
  if (installed.length > 1) {
    const second = installed[1].id;
    assert.equal((await listTerminals(second)).find((t) => t.selected)!.id, second);
  }
});
