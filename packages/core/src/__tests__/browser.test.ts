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
const LOGIN = `<!doctype html><title>Sign in</title>
<form id="f"><label>Email <input id="email" name="email"></label><button type="submit">Sign in</button></form>
<button id="broken" onclick="fetch('/api/missing')">Load extras</button>
<script>
  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await fetch("/api/login", { method: "POST", body: document.getElementById("email").value });
    location.href = "/dashboard?user=" + encodeURIComponent(await r.text());
  });
</script>`;
const DASHBOARD = `<!doctype html><title>Dashboard</title><h1>Welcome back</h1><p id="who"></p>
<script>document.getElementById("who").textContent = new URLSearchParams(location.search).get("user");</script>`;

let server: http.Server;
let base = "";
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/login" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => res.end(body.toUpperCase()));
      return;
    }
    const pages: Record<string, string> = { "/broken": BROKEN, "/overlay": OVERLAY, "/fine": FINE, "/login": LOGIN, "/dashboard": DASHBOARD };
    const page = pages[(req.url ?? "").split("?")[0]];
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

test("steps click through a flow and say which step caused what", opts, async () => {
  const r = await checkPage({
    url: `${base}/login`,
    steps: [
      { click: "#broken" },
      { type: "alex@example.com", into: "#email" },
      { click: "text=Sign in" },
      { waitFor: "url=/dashboard" },
      { waitFor: "text=Welcome back", screenshot: true },
    ],
  });
  assert.equal(r.steps?.length, 5, JSON.stringify(r.steps));
  assert.ok(r.steps!.every((s) => s.ok), JSON.stringify(r.steps));
  assert.match(r.finalUrl ?? "", /\/dashboard\?user=ALEX%40EXAMPLE\.COM$/);
  assert.match(r.text ?? "", /ALEX@EXAMPLE\.COM/, "the typed text reached the server and back");
  assert.equal(r.steps![0].problems, 1);
  assert.ok(r.failedRequests.some((f) => f.url.endsWith("/api/missing") && f.step === 1), JSON.stringify(r.failedRequests));
  assert.ok(r.steps![4].screenshot && fs.existsSync(r.steps![4].screenshot));
  assert.equal(r.ok, false, "the 404 during step 1 counts");
});

test("a step that can't be done stops the flow with a reason", opts, async () => {
  const r = await checkPage({ url: `${base}/fine`, steps: [{ click: "text=Nowhere", timeoutMs: 600 }, { waitFor: "text=All good" }] });
  assert.equal(r.steps?.length, 1, "the step after a failed one isn't run");
  assert.equal(r.steps![0].ok, false);
  assert.match(r.steps![0].error ?? "", /Nothing to click matches text=Nowhere/);
  assert.equal(r.ok, false);
});
