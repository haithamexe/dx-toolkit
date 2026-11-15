import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-sitecheck-test-"));
const { refusedAddress, siteFindings, siteStatus, siteAllows, checkSitePage } = await import("../tools/sitecheck.js");
const { findBrowser, checkPage } = await import("../tools/browser.js");
type SiteConfig = import("../tools/sites.js").SiteConfig;

const servers: http.Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

function serve(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, "127.0.0.1", () => {
      servers.push(s);
      resolve((s.address() as AddressInfo).port);
    });
  });
}

const siteOf = (port: number): SiteConfig => ({ host: `127.0.0.1:${port}`, project: "/path/to/shop-website", env: "staging" });

test("an address a connection must never reach is refused, whatever name led there", () => {
  for (const a of ["127.0.0.1", "::1", "0.0.0.0", "::", "169.254.169.254", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "not-an-address"]) assert.equal(refusedAddress(a), true, a);
  for (const a of ["93.184.216.34", "10.0.0.5", "192.168.1.20", "2606:2800:220:1:248:1893:25c8:1946"]) assert.equal(refusedAddress(a), false, a);
  // Loopback is allowed only for tests, and the unspecified and metadata addresses never are.
  assert.equal(refusedAddress("127.0.0.1", true), false);
  assert.equal(refusedAddress("0.0.0.0", true), true);
  assert.equal(refusedAddress("169.254.169.254", true), true);
});

test("findings say what is wrong with the answer, and what to do", () => {
  const bare = siteFindings({ status: 200, https: false, ms: 120, cookies: [], redirects: [] }, {});
  assert.ok(bare.some((f) => f.title === "Not served over https" && f.fix));
  assert.ok(bare.some((f) => /Content-Security-Policy/.test(f.title)));
  assert.ok(bare.some((f) => f.level === "ok" && /200/.test(f.title)));
  const failing = siteFindings({ status: 503, https: true, ms: 4000, cookies: [], redirects: [] }, { "strict-transport-security": "max-age=1" });
  assert.ok(failing.some((f) => f.level === "bad" && /503/.test(f.title)));
  assert.ok(failing.some((f) => /Slow/.test(f.title)));
  assert.ok(!failing.some((f) => /Strict-Transport/.test(f.title)));
  const clean = siteFindings(
    { status: 200, https: true, ms: 80, cookies: [], redirects: [] },
    { "strict-transport-security": "max-age=31536000", "content-security-policy": "default-src 'self'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" },
  );
  assert.ok(!clean.some((f) => f.level === "warn" || f.level === "bad"), JSON.stringify(clean));
});

test("only an address on one of the project's sites can be checked", async () => {
  const port = await serve((_, res) => res.end("hi"));
  await assert.rejects(() => siteStatus(`http://127.0.0.1:${port}/`, [], { allowLoopback: true }), /isn't one of the project's sites/);
  await assert.rejects(() => siteStatus("https://example.com/", [siteOf(port)], { allowLoopback: true }), /isn't one of the project's sites/);
  assert.equal(siteAllows([siteOf(port)])(`http://127.0.0.1:${port}/pricing`), true);
  assert.equal(siteAllows([siteOf(port)])("http://127.0.0.1:1/"), false);
});

test("a status check reads the answer: status, title, deployment, cookie flags (never values)", async () => {
  const port = await serve((_, res) => {
    res.writeHead(200, { "content-type": "text/html", server: "nginx/1.25.3", "x-commit": "3f2c9e1ab", "set-cookie": ["sid=SECRET; HttpOnly; Secure; SameSite=Lax", "pref=1"] });
    res.end('<html><head><title>Shop</title><meta name="version" content="1.4.0"></head></html>');
  });
  const r = await siteStatus(`http://127.0.0.1:${port}/`, [siteOf(port)], { allowLoopback: true });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.title, "Shop");
  assert.equal(r.deployment?.commit, "3f2c9e1ab");
  assert.deepEqual(r.cookies, [
    { name: "sid", secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "pref", secure: false, httpOnly: false, sameSite: undefined },
  ]);
  assert.ok(!JSON.stringify(r).includes("SECRET"), "a cookie's value is never kept");
  assert.ok(r.findings.some((f) => /Server header/i.test(f.title) || /version/i.test(f.title)), "a server version is noted");
});

test("redirects are followed on the project's own sites and stop at any other host", async () => {
  const other = await serve((_, res) => res.end("elsewhere"));
  const port = await serve((req, res) => {
    if (req.url === "/old") return void res.writeHead(301, { location: "/new" }).end();
    if (req.url === "/away") return void res.writeHead(302, { location: `http://127.0.0.1:${other}/landing` }).end();
    res.writeHead(200, { "content-type": "text/plain" }).end("new");
  });
  const sites = [siteOf(port)];
  const followed = await siteStatus(`http://127.0.0.1:${port}/old`, sites, { allowLoopback: true });
  assert.equal(followed.status, 200);
  assert.equal(followed.redirects.length, 1);
  assert.ok(followed.finalUrl.endsWith("/new"));
  const away = await siteStatus(`http://127.0.0.1:${port}/away`, sites, { allowLoopback: true });
  assert.equal(away.stoppedAt, `127.0.0.1:${other}`);
  assert.equal(away.status, undefined, "dx never connected to the other host");
  assert.ok(away.findings.some((f) => /isn't one of this project's sites/.test(f.title)));
});

test("a redirect loop ends, and a refused address is an error, not a connection", async () => {
  const port = await serve((_, res) => res.writeHead(302, { location: "/again" }).end());
  const loop = await siteStatus(`http://127.0.0.1:${port}/`, [siteOf(port)], { allowLoopback: true });
  assert.match(loop.error ?? "", /Too many redirects/);
  // Without the test-only allowance, a site that resolves to this computer is refused.
  const refused = await siteStatus(`http://127.0.0.1:${port}/`, [siteOf(port)]);
  assert.ok(refused.error, "refused");
  assert.equal(refused.ok, false);
});

// A page check can't be pointed at a page from the internet unless the site was added, and its own navigation can't leave the sites.
const browser = findBrowser();
test("a page that navigates away from the project's sites is stopped there", { skip: browser ? false : "no Chrome-family browser found", timeout: 60_000 }, async () => {
  const away = await serve((_, res) => res.writeHead(200, { "content-type": "text/html" }).end("<h1>elsewhere</h1>"));
  const home = await serve((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<html><body><script>setTimeout(() => { location.href = "http://localhost:${away}/"; }, 100);</script>home</body></html>`));
  const allow = (url: string) => new URL(url).host === `127.0.0.1:${home}`;
  const r = await checkPage({ url: `http://127.0.0.1:${home}/`, allow, settleMs: 1500 } as never);
  assert.ok(r.blocked?.includes(`localhost:${away}`), JSON.stringify(r.blocked));
  assert.match(r.error ?? "", /isn't one of this project's sites/);
});

test("checkSitePage refuses an address that isn't a site", async () => {
  await assert.rejects(() => checkSitePage("https://example.com/", []), /./);
});

test("the last checks of a site are kept as numbers, newest first, a dozen per kind, and say how the latest compares", async () => {
  const { recordSiteCheck, lastSiteChecks, siteCheckHistory } = await import("../tools/sitehistory.js");
  const dir = "/path/to/shop-website";
  for (let i = 0; i < 15; i++) recordSiteCheck(dir, "staging.shop-website.dev", { what: "status", ok: true, status: 200, ms: 100 + i, at: new Date(1_790_000_000_000 + i * 1000).toISOString() });
  recordSiteCheck(dir, "staging.shop-website.dev", { what: "audit", ok: true, lcpMs: 1400, a11y: 3, commit: "3F2C9E1AB" });
  recordSiteCheck(dir, "other.example.com", { what: "page", ok: false, problems: 2 });
  const last = lastSiteChecks(dir, "STAGING.shop-website.dev");
  assert.equal(last.status?.latest.ms, 114);
  assert.equal(last.status?.previous?.ms, 113);
  assert.equal(siteCheckHistory(dir, "staging.shop-website.dev", "status").length, 12, "a dozen per kind");
  assert.equal(last.audit?.latest.commit, "3f2c9e1ab");
  assert.equal(last.page, undefined, "another site's checks aren't this one's");
  assert.deepEqual(Object.keys(lastSiteChecks(dir, "other.example.com")), ["page"]);
  // Nothing but numbers and a commit: no address, header or text can be in the file.
  recordSiteCheck(dir, "x.example.com", { what: "status", ok: true, status: 200, ms: 5, commit: "not a commit", ...({ url: "https://x.example.com/?token=abc", title: "Secret page" } as object) } as never);
  const file = path.join(process.env.DX_HOME!, "sitechecks.json");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes("token") && !text.includes("Secret page") && !text.includes("not a commit"));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
