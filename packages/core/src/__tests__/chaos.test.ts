import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-chaos-test-"));
fs.writeFileSync(path.join(process.env.DX_HOME, "config.json"), JSON.stringify({ projectsRoots: [], autoConnectAi: false, activityDays: 7 }));
const core = await import("../index.js");
const { decideChaos, breakJson, cleanChaos, setChaos, loadChaos, chaosReport, logoutWindow, zonedTime, emulationCommands, seeded, JUNK, declaredRoutes, routeFits, normalRoute, findGraveyard, compareBehaviour, callsOf, envUsage, envNames, probeEnv, appendActivity, nextActivityId } = core;

const dirOf = (name: string, files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
};

test("chaos: the same seed breaks the same calls the same way; another seed doesn't", () => {
  const run = (seed: number) =>
    Array.from({ length: 200 }, (_, n) => decideChaos({ level: "blackfriday", faults: [], seed }, { method: "GET", path: `/api/orders/${n}?page=2`, n, index: n, signedIn: false })?.label ?? "-");
  assert.deepEqual(run(4812), run(4812));
  assert.notDeepEqual(run(4812), run(77));
  const labels = run(4812);
  // Black Friday breaks most calls, and in several ways.
  assert.ok(labels.filter((l) => l !== "-").length > 120);
  for (const f of ["slow", "rate limited", "500"]) assert.ok(labels.some((l) => l.includes(f)), f);
  // A level only uses its own faults; a list of faults narrows it.
  const wifi = Array.from({ length: 300 }, (_, n) => decideChaos({ level: "wifi", faults: [], seed: 1 }, { method: "GET", path: "/api/x", n, index: n, signedIn: true })?.fault);
  assert.ok(!wifi.includes("flaky") && !wifi.includes("logout") && wifi.includes("slow"));
  const only = Array.from({ length: 300 }, (_, n) => decideChaos({ level: "blackfriday", faults: ["flaky"], seed: 1 }, { method: "GET", path: "/api/x", n, index: n, signedIn: false })?.fault);
  assert.deepEqual([...new Set(only)].sort(), ["flaky", undefined].sort());
});

test("chaos: a session expires once, for a few signed-in calls", () => {
  const w = logoutWindow(4812);
  const at = (index: number, signedIn = true) => decideChaos({ level: "deploy", faults: ["logout"], seed: 4812 }, { method: "GET", path: "/api/me", n: index, index, signedIn })?.fault;
  assert.equal(at(w.from), "logout");
  assert.equal(at(w.from + w.count - 1), "logout");
  assert.equal(at(w.from + w.count), undefined);
  assert.equal(at(w.from - 1), undefined);
  assert.equal(at(w.from, false), undefined, "a call without a session can't be logged out");
});

test("chaos: odd data breaks one field of a JSON answer, the same one for the same call", () => {
  const body = JSON.stringify({ items: [{ id: 1, name: "Blue mug", price: 12.5 }], total: 1 });
  const a = breakJson(body, 0, "4812|GET /api/items|3")!;
  assert.deepEqual(a, breakJson(body, 0, "4812|GET /api/items|3"));
  assert.notEqual(a.text, body);
  assert.match(a.note, /became (null|an empty list|-1|a 10,000-character string|an empty string)/);
  assert.equal(breakJson("<html>", 0, "x"), undefined, "not JSON: left alone");
  // Over many calls every kind of breakage turns up.
  const notes = Array.from({ length: 80 }, (_, i) => breakJson(body, 0, `k${i}`)!.note).join("\n");
  for (const w of ["null", "-1", "10,000-character", "empty list"]) assert.ok(notes.includes(w), w);
});

test("chaos settings: checked, kept per project, and a new run starts when it's turned on", () => {
  const dir = dirOf("shop-website", {});
  assert.throws(() => cleanChaos({ level: "apocalypse" }), /level is one of/);
  assert.throws(() => cleanChaos({ clock: { timeZone: "Mars/Olympus" } }), /isn't a time zone/);
  assert.throws(() => cleanChaos({ clock: { at: "1900-01-01" } }), /between 1971 and 2200/);
  assert.throws(() => cleanChaos({ paths: "/api\n/x" }), /path pattern/);
  assert.deepEqual(cleanChaos({ faults: ["slow", "nonsense", "slow"] }).faults, ["slow"]);
  const first = loadChaos(dir);
  assert.equal(first.seed, loadChaos(dir).seed, "the seed shown before saving is the one used");
  const on = setChaos(dir, "shop-website", { on: true, level: "deploy" });
  assert.ok(on.on && on.startedAt);
  assert.equal(on.seed, first.seed);
  assert.equal(loadChaos(dir).level, "deploy");
  const clock = setChaos(dir, "shop-website", { clock: { at: "2026-12-31T23:59:50", timeZone: "Pacific/Auckland", frozen: true } });
  assert.equal(clock.clock?.at, "2026-12-31T10:59:50.000Z", "a time without an offset is on the zone's clocks");
  assert.equal(setChaos(dir, "shop-website", { clock: null }).clock, undefined);
  if (process.platform !== "win32") assert.equal(fs.statSync(core.chaosFile(dir)).mode & 0o777, 0o600);
  assert.equal(zonedTime("2027-03-28T01:30:00", "Europe/Berlin"), Date.UTC(2027, 2, 28, 0, 30), "before the clocks go forward");
  assert.equal(zonedTime("2026-07-01T12:00:00", "America/New_York"), Date.UTC(2026, 6, 1, 16, 0));
});

test("chaos report: blank pages, uncaught errors, stuck spinners and double submits, each with the chaos before it", () => {
  const t0 = Date.parse("2026-11-05T10:00:00Z");
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const base = { dir: "/x", project: "shop-website", from: "proxy" as const };
  let id = 1;
  const ev = (o: Record<string, unknown>) => ({ ...base, id: id++, ...o }) as any;
  const events = [
    ev({ at: at(1), type: "request", method: "GET", url: "/api/products", status: 500, text: "GET /api/products → 500", rules: ["chaos: 500"], visit: "v1" }),
    ev({ at: at(2), type: "error", text: "TypeError: Cannot read properties of undefined (reading 'map')", source: "/app.js:8:35", from: "browser", visit: "v1" }),
    ev({ at: at(3), type: "error", problem: "blank", text: "The page went blank after an error", from: "browser", visit: "v1" }),
    ev({ at: at(4), type: "request", method: "POST", url: "/api/orders", status: 201, text: "POST /api/orders → 201", requestBody: '{"qty":1}', visit: "v2", rules: ["chaos: slow 2.1 s"] }),
    ev({ at: at(5), type: "request", method: "POST", url: "/api/orders", status: 201, text: "POST /api/orders → 201", requestBody: '{"qty":1}', visit: "v2" }),
    ev({ at: at(30), type: "error", problem: "stuck", text: "A loading indicator <div.spinner> was still showing after 15 s", from: "browser", visit: "v2" }),
    ev({ at: at(31), type: "request", method: "GET", url: "/api/products", status: 200, text: "GET /api/products → 200", rules: ["chaos: odd data: items.0.price became null"] }),
  ];
  const r = chaosReport(events, at(0));
  assert.equal(r.calls, 4);
  assert.equal(r.broken, 3);
  assert.deepEqual(r.byFault, { "500": 1, slow: 1, "odd data": 1 });
  const kinds = r.findings.map((f) => f.kind);
  assert.deepEqual(kinds.sort(), ["blank", "double", "stuck", "uncaught"]);
  const uncaught = r.findings.find((f) => f.kind === "uncaught")!;
  assert.deepEqual(uncaught.after, ["500 on GET /api/products"]);
  assert.equal(chaosReport(events, at(10)).findings.length, 1, "only since the run started");
});

test("emulation: a cheap phone on 3G, another time zone, and back", () => {
  const on = emulationCommands({ phone: true, timeZone: "Asia/Kathmandu" });
  const methods = on.map(([m]) => m);
  for (const m of ["Emulation.setDeviceMetricsOverride", "Emulation.setTouchEmulationEnabled", "Emulation.setCPUThrottlingRate", "Network.emulateNetworkConditions", "Emulation.setTimezoneOverride"]) assert.ok(methods.includes(m), m);
  assert.deepEqual(on.find(([m]) => m === "Emulation.setCPUThrottlingRate")![1], { rate: 6 });
  const off = emulationCommands({ phone: true }, { undo: true, userAgent: "Mozilla/5.0 Desktop" });
  assert.deepEqual(off.find(([m]) => m === "Emulation.setCPUThrottlingRate")![1], { rate: 1 });
  assert.deepEqual(off.find(([m]) => m === "Emulation.setUserAgentOverride")![1], { userAgent: "Mozilla/5.0 Desktop" });
  assert.deepEqual(emulationCommands({}), []);
});

test("gremlins: seeded, so a run can be done again", () => {
  const a = seeded(42);
  const b = seeded(42);
  const xs = Array.from({ length: 20 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 20 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(xs, Array.from({ length: 20 }, seeded(43)));
  assert.ok(JUNK.includes("") && JUNK.some((j) => j.length >= 5000) && JUNK.some((j) => /DROP TABLE/.test(j)));
});

test("graveyard: routes and pages from the code, matched against what was used", () => {
  const dir = dirOf("shop-website", {
    "package.json": "{}",
    "server/routes.ts": "router.get('/api/orders/:id', h);\napp.post(\"/api/orders\", h);\napp.delete(`/api/legacy/:id`, h);\n",
    "app/api/cart/route.ts": "export async function GET() {}\nexport async function POST() {}\n",
    "app/settings/billing/page.tsx": "export default function P() {}",
    "app/(shop)/products/[slug]/page.tsx": "export default function P() {}",
    "pages/about.tsx": "export default 1",
    "api/main.py": '@app.get("/api/health")\ndef h(): pass\n@app.route("/api/admin", methods=["GET", "POST"])\ndef a(): pass\n',
    "src/router.tsx": 'import { createBrowserRouter } from "react-router";\nconst r = [{ path: "/reports" }];',
    "server/routes.test.ts": "app.get('/api/never-counted', h);",
  });
  const { endpoints, pages } = declaredRoutes(dir);
  const eps = endpoints.map((e) => `${e.method ?? "*"} ${e.path}`).sort();
  assert.deepEqual(eps, ["DELETE /api/legacy/:id", "GET /api/admin", "GET /api/cart", "GET /api/health", "GET /api/orders/:id", "POST /api/admin", "POST /api/cart", "POST /api/orders"].sort());
  assert.deepEqual(pages.map((p) => p.path).sort(), ["/about", "/products/:slug", "/reports", "/settings/billing"]);
  assert.equal(normalRoute("blog/[...slug]"), "/blog/**");
  assert.equal(normalRoute("/users/<int:id>/"), "/users/:id");
  assert.ok(routeFits("/api/orders/:id", "/api/orders/42"));
  assert.ok(!routeFits("/api/orders/:id", "/api/orders"));
  assert.ok(routeFits("/blog/**", "/blog/2026/hello"));

  const now = new Date().toISOString();
  appendActivity([
    { id: nextActivityId(), at: now, dir, project: "shop-website", type: "request", method: "GET", url: "/api/orders/42", status: 200, text: "GET /api/orders/42 → 200", from: "proxy" },
    { id: nextActivityId(), at: now, dir, project: "shop-website", type: "request", method: "GET", url: "/api/unknown", status: 404, text: "GET /api/unknown → 404", from: "proxy" },
    { id: nextActivityId(), at: now, dir, project: "shop-website", type: "page", url: "http://shop-website.localhost/settings/billing", text: "page", from: "proxy" },
  ]);
  const g = findGraveyard(dir, "shop-website", { days: 30 });
  assert.equal(g.days, 7, "only as far back as the history is kept");
  assert.equal(g.endpoints.find((e) => e.what === "GET /api/orders/:id")!.uses, 1);
  assert.equal(g.endpoints.find((e) => e.what === "POST /api/orders")!.uses, 0);
  assert.equal(g.pages.find((p) => p.path === "/settings/billing")!.uses, 1);
  assert.equal(g.pages.find((p) => p.path === "/about")!.uses, 0);
  assert.equal(g.unmatched, 1);
});

test("behaviour diff: calls, answers, errors and warnings compared by path", () => {
  const page = (o: Partial<import("../index.js").PageCheck>): import("../index.js").PageCheck => ({ url: "http://localhost:5173/", ok: true, ms: 1, browser: "Chrome", exceptions: [], consoleErrors: [], consoleWarnings: [], failedRequests: [], ...o });
  const before = page({
    requests: [
      { url: "http://localhost:4001/api/cart", method: "GET", status: 200, type: "Fetch" },
      { url: "http://localhost:4001/api/track", method: "POST", status: 204, type: "XHR" },
      { url: "http://localhost:4001/@vite/client", method: "GET", status: 200, type: "Fetch" },
    ],
    consoleWarnings: [{ text: "old warning" }],
  });
  const after = page({
    url: "http://shop-website.localhost:1355/",
    requests: [
      { url: "http://shop-website.localhost/api/cart", method: "GET", status: 200, type: "Fetch" },
      { url: "http://shop-website.localhost/api/cart", method: "GET", status: 200, type: "Fetch" },
      { url: "http://shop-website.localhost/api/user/7", method: "GET", status: 500, type: "Fetch" },
    ],
    exceptions: [{ text: "TypeError: x is undefined\n    at app.js:1" }],
  });
  assert.deepEqual(callsOf(before).map((c) => c.key), ["GET /api/cart", "POST /api/track"], "the dev server's own files left out");
  const d = compareBehaviour(before, after, "/");
  const texts = d.changes.map((c) => `${c.tone}: ${c.text}`);
  assert.ok(texts.includes("worse: GET /api/cart is called 2 times, was 1"));
  assert.ok(texts.includes("worse: New call: GET /api/user/:id → 500"));
  assert.ok(texts.includes("change: No longer called: POST /api/track"));
  assert.ok(texts.includes("worse: New error: TypeError: x is undefined"));
  assert.ok(texts.includes("better: Warning gone: old warning"));
  assert.equal(d.changes[0].tone, "worse", "worse first");
  assert.ok(compareBehaviour(before, before).same);
});

test("missing values: which .env values the code uses, and which crash the app without them", async () => {
  const dir = dirOf("api-gateway", {
    ".env": "API_KEY=k-123\nGREETING=hello\nUNUSED_FLAG=1\n",
    "package.json": JSON.stringify({ name: "api-gateway", scripts: { dev: "node server.cjs" } }),
    "server.cjs": [
      "const http = require('http');",
      "if (!process.env.API_KEY) { console.error('Error: API_KEY is not set'); process.exit(1); }",
      "const greeting = process.env.GREETING || 'hi';",
      "http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ greeting })); }).listen(Number(process.env.PORT), '127.0.0.1');",
    ].join("\n"),
  });
  assert.deepEqual(envNames(dir), ["API_KEY", "GREETING", "UNUSED_FLAG"]);
  const usage = envUsage(dir, envNames(dir));
  assert.deepEqual(usage.get("API_KEY"), ["server.cjs"]);
  assert.deepEqual(usage.get("UNUSED_FLAG"), []);
  // The fixture doesn't read .env itself: pass the values in like a framework would.
  for (const [k, v] of Object.entries({ API_KEY: "k-123", GREETING: "hello" })) process.env[k] = v;
  try {
    const r = await probeEnv({ name: "api-gateway", dir, devCommand: "node server.cjs" } as any, { startTimeoutMs: 15_000 });
    assert.equal(r.error, undefined, JSON.stringify(r.baseline));
    const verdicts = Object.fromEntries(r.values.map((v) => [v.key, v.verdict]));
    assert.deepEqual(verdicts, { API_KEY: "crashes", GREETING: "unnoticed", UNUSED_FLAG: "unused" });
    assert.ok(!JSON.stringify(r).includes("k-123"), "values are never in the result");
  } finally {
    delete process.env.API_KEY;
    delete process.env.GREETING;
  }
});
