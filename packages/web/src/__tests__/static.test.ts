import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";

// The dashboard's own files: compressed and revalidated with an ETag, except the page that holds this run's token.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-static-home-"));
const pub = fs.mkdtempSync(path.join(os.tmpdir(), "dx-static-public-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));
fs.writeFileSync(path.join(pub, "index.html"), '<meta name="dx-token" content="__DX_TOKEN__"><p>hi</p>');
const script = "export const x = '" + "abc".repeat(2000) + "';\n";
fs.writeFileSync(path.join(pub, "app.js"), script);
fs.writeFileSync(path.join(pub, "tiny.js"), "let a = 1;\n");

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
before(async () => {
  dashboard = await startDashboard({ port: 0, publicDir: pub });
});
after(async () => {
  await dashboard.close();
});

// A raw request, so the compression isn't undone for us.
function get(p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(p, dashboard.url);
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

test("a script is sent compressed to a browser that takes it, with an ETag to revalidate by", async () => {
  const r = await get("/app.js", { "Accept-Encoding": "gzip, deflate" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.match(String(r.headers.etag), /^"[0-9a-f]{20}"$/);
  assert.equal(r.headers.vary, "Accept-Encoding");
  assert.equal(zlib.gunzipSync(r.body).toString("utf8"), script);
  assert.ok(r.body.length < script.length / 5, "much smaller on the wire");
  assert.ok(String(r.headers["content-security-policy"]).includes("default-src 'self'"), "the page's security headers stay");
});

test("without gzip it is sent as is, and a current copy is answered 304", async () => {
  const plain = await get("/app.js");
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.body.toString("utf8"), script);
  const again = await get("/app.js", { "If-None-Match": String(plain.headers.etag), "Accept-Encoding": "gzip" });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  const stale = await get("/app.js", { "If-None-Match": '"nope"' });
  assert.equal(stale.status, 200);
});

test("a file that changes is read again, and a tiny one isn't compressed", async () => {
  const before = await get("/app.js");
  fs.writeFileSync(path.join(pub, "app.js"), script + "export const y = 2;\n");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(pub, "app.js"), future, future);
  const after = await get("/app.js");
  assert.notEqual(after.headers.etag, before.headers.etag);
  assert.ok(after.body.toString("utf8").endsWith("export const y = 2;\n"));
  const tiny = await get("/tiny.js", { "Accept-Encoding": "gzip" });
  assert.equal(tiny.headers["content-encoding"], undefined);
  assert.equal(tiny.body.toString("utf8"), "let a = 1;\n");
});

test("the page that holds the token is never kept, and the token is in it", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers.etag, undefined);
  assert.ok(r.body.toString("utf8").includes(`content="${dashboard.token}"`));
  assert.equal((await get("/../server.js")).status, 404, "nothing outside the public folder");
});
