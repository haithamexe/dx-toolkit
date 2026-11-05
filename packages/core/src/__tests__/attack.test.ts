import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-attack-test-"));
const { attackApp, findBrowser, maskHeaders, maskSetCookie } = await import("../index.js");

// A made-up app with one weakness per check, and a fixed one to compare with. It only ever
// listens on 127.0.0.1, and the attack only talks to it.
function app(safe: boolean) {
  const comments: string[] = [];
  let logins = 0;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return http.createServer((q, r) => {
    let body = "";
    q.on("data", (c) => (body += c));
    q.on("end", () => {
      const url = new URL(q.url ?? "/", "http://x");
      const json = (status: number, b: unknown, h: Record<string, string> = {}) => {
        r.writeHead(status, { "content-type": "application/json", ...h });
        r.end(JSON.stringify(b));
      };
      const page = (html: string) => {
        r.writeHead(200, { "content-type": "text/html", ...(safe ? { "content-security-policy": "default-src 'self'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" } : {}) });
        r.end(`<!doctype html><html lang="en"><body>${html}</body></html>`);
      };
      const signed = /sid=good/.test(q.headers.cookie ?? "");
      const cors: Record<string, string> = !safe && q.headers.origin ? { "access-control-allow-origin": q.headers.origin, "access-control-allow-credentials": "true" } : {};
      if (url.pathname === "/search") return page(`<p>Results for ${safe ? esc(url.searchParams.get("q") ?? "") : (url.searchParams.get("q") ?? "")}</p>`);
      if (url.pathname === "/comments") return page(`<ul>${comments.map((c) => `<li>${safe ? esc(c) : c}</li>`).join("")}</ul>`);
      if (url.pathname === "/api/comments" && q.method === "POST") {
        if (safe && q.headers.origin && q.headers.origin !== "http://127.0.0.1") return json(403, { error: "cross-site" });
        try {
          comments.push(String(JSON.parse(body).text));
        } catch (err) {
          return safe ? json(400, { error: "bad json" }) : json(500, { error: (err as Error).stack });
        }
        return json(201, { ok: true });
      }
      if (url.pathname === "/api/login" && q.method === "POST") {
        logins++;
        if (safe && logins > 5) return json(429, { error: "slow down" }, { "retry-after": "60" });
        return json(401, { error: "wrong password" });
      }
      const order = /^\/api\/orders\/(.+)$/.exec(url.pathname);
      if (order) {
        if (safe && !signed) return json(401, { error: "sign in" });
        if (!/^\d+$/.test(order[1])) return json(500, { error: safe ? "bad id" : `SQLITE_ERROR: unrecognized token: "${order[1]}"` });
        if (safe && order[1] !== "42") return json(404, { error: "not yours" });
        return json(200, { id: Number(order[1]), total: 12.5 * Number(order[1]) }, cors);
      }
      json(404, { error: "no" });
    });
  });
}

let bad: http.Server;
let good: http.Server;
const listen = (s: http.Server) => new Promise<number>((res) => s.listen(0, "127.0.0.1", () => res((s.address() as { port: number }).port)));
let badUrl = "";
let goodUrl = "";
before(async () => {
  bad = app(false);
  good = app(true);
  badUrl = `http://127.0.0.1:${await listen(bad)}`;
  goodUrl = `http://127.0.0.1:${await listen(good)}`;
});
after(() => {
  bad.close();
  good.close();
});

// What the history would hold after using the app: paths, masked cookies and passwords.
const at = new Date().toISOString();
let id = 1;
const ev = (o: Record<string, unknown>) => ({ id: id++, at, dir: "/x", project: "shop-website", from: "proxy", text: "", ...o }) as any;
const events = [
  ev({ type: "page", url: "/search?q=mugs" }),
  ev({ type: "page", url: "/comments" }),
  ev({ type: "request", method: "GET", url: "/api/orders/42", status: 200, requestHeaders: { cookie: "•••" } }),
  ev({ type: "request", method: "POST", url: "/api/comments", status: 201, requestBody: '{"text":"Nice mug"}', requestHeaders: { cookie: "•••", "content-type": "application/json" } }),
  ev({ type: "request", method: "POST", url: "/api/login", status: 401, requestBody: '{"email":"octocat@example.com","password":"•••"}', requestHeaders: { "content-type": "application/json" }, responseHeaders: { "set-cookie": maskSetCookie("sid=abc; Path=/") } }),
];

test("set cookies keep their name and flags in the history, never their value", () => {
  assert.equal(maskSetCookie("sid=abc123; Path=/; HttpOnly; Secure; SameSite=Lax"), "sid=•••; Path=/; HttpOnly; Secure; SameSite=Lax");
  assert.equal(maskSetCookie("weird value"), "•••");
  assert.equal(maskHeaders({ "Set-Cookie": ["a=1; HttpOnly", "b=2"] })["set-cookie"], "a=•••; HttpOnly, b=•••");
  assert.equal(maskHeaders({ cookie: "sid=abc" }).cookie, "•••");
});

test("attack my app: each weakness is found, with the request that shows it", async () => {
  const r = await attackApp({ baseUrl: badUrl, dir: fs.mkdtempSync(path.join(os.tmpdir(), "shop-website-")), events, session: { cookie: "sid=good" }, browser: !!findBrowser() });
  const checks = new Set(r.findings.map((f) => f.check));
  for (const c of ["headers", "cookie", "cors", "no-auth", "idor", "sql-error", "stack-trace", "xss-reflected", "csrf", "login-rate"]) assert.ok(checks.has(c as never), `${c}: ${JSON.stringify(r.findings.map((f) => f.check))}`);
  if (findBrowser()) assert.ok(checks.has("xss-stored"), "stored script shows on /comments");
  const cors = r.findings.find((f) => f.check === "cors")!;
  assert.equal(cors.severity, "high");
  assert.match(cors.proof, /Origin: https:\/\/evil\.example/);
  assert.match(r.findings.find((f) => f.check === "login-rate")!.proof, /20 × POST \/api\/login/);
  assert.equal(r.findings[0].severity, "high", "serious first");
  assert.ok(!JSON.stringify(r).includes("sid=good"), "the session isn't in the report");
});

test("attack my app: a fixed app has nothing serious, and a read-only run changes nothing", async () => {
  const r = await attackApp({ baseUrl: goodUrl, dir: os.tmpdir(), events, session: { cookie: "sid=good" }, browser: !!findBrowser() });
  assert.deepEqual(
    r.findings.filter((f) => f.severity === "high").map((f) => f.title),
    [],
  );
  const ro = await attackApp({ baseUrl: goodUrl, dir: os.tmpdir(), events, readOnly: true, browser: false });
  assert.ok(ro.skipped.some((s) => /read-only/.test(s)));
  assert.ok(!ro.tried.some((t) => /wrong passwords|saved through/.test(t)));
  await assert.rejects(attackApp({ baseUrl: "http://example.com", dir: os.tmpdir(), events }), /on this computer/);
});
