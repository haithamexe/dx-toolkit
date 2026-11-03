import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-browser-test-"));
const { checkPage, findBrowser, isLoopbackUrl } = await import("../tools/browser.js");

const BROKEN = `<!doctype html><title>Broken shop</title><h1>Cart</h1>
<script>
  console.error("Cart failed to load", { id: 7 });
  console.warn("Deprecated prop");
  fetch("/api/missing");
  setTimeout(() => { throw new Error("Cannot read properties of undefined (reading 'items')"); }, 50);
</script>`;
const OVERLAY = `<!doctype html><title>App</title>
<script>
  customElements.define("vite-error-overlay", class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<div>[plugin:vite:react-babel] src/App.tsx: Unexpected token (3:9)</div>"; }
  });
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(document.createElement("vite-error-overlay")));
</script><body></body>`;
const FINE = `<!doctype html><title>Fine</title><p>All good</p>`;

let server: http.Server;
let base = "";
before(async () => {
  server = http.createServer((req, res) => {
    const pages: Record<string, string> = { "/broken": BROKEN, "/overlay": OVERLAY, "/fine": FINE };
    const page = pages[req.url ?? ""];
    res.writeHead(page ? 200 : 404, { "content-type": page ? "text/html" : "text/plain" });
    res.end(page ?? "not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("only addresses on this computer can be checked", async () => {
  assert.ok(isLoopbackUrl("http://localhost:5173/"));
  assert.ok(isLoopbackUrl("http://shop.localhost/cart"));
  assert.ok(!isLoopbackUrl("https://example.com/"));
  assert.ok(!isLoopbackUrl("file:///etc/passwd"));
  await assert.rejects(checkPage({ url: "https://example.com/" }), /Only pages on this computer/);
});

// Every CI runner has Chrome; a machine without a browser skips these.
const browser = findBrowser();
const opts = { skip: browser ? false : "no Chrome, Edge, Chromium or Brave here" };

test("reports exceptions, console errors and failed requests", opts, async () => {
  const r = await checkPage({ url: `${base}/broken`, screenshot: true });
  assert.equal(r.error, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.equal(r.title, "Broken shop");
  assert.ok(r.text?.includes("Cart"));
  assert.ok(r.exceptions.some((e) => e.text.includes("reading 'items'")), JSON.stringify(r.exceptions));
  assert.ok(r.consoleErrors.some((e) => e.text.includes("Cart failed to load")), JSON.stringify(r.consoleErrors));
  assert.ok(r.consoleWarnings.some((e) => e.text.includes("Deprecated prop")));
  assert.ok(r.failedRequests.some((f) => f.url.endsWith("/api/missing") && f.status === 404), JSON.stringify(r.failedRequests));
  assert.ok(r.screenshot && fs.statSync(r.screenshot).size > 1000);
});

test("reads a dev server's error overlay", opts, async () => {
  const r = await checkPage({ url: `${base}/overlay` });
  assert.equal(r.ok, false);
  assert.ok(r.overlay?.includes("Unexpected token"), r.overlay);
});

test("a page with nothing wrong is ok", opts, async () => {
  const r = await checkPage({ url: `${base}/fine` });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, "All good");
});

test("a server that isn't running is reported as such", opts, async () => {
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((r) => closed.close(r));
  const r = await checkPage({ url: `http://127.0.0.1:${port}/` });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Nothing is listening/);
});
