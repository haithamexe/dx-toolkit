import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Two projects whose usual port is the same, started together, by servers that don't say where
// they listen and quietly take the next port when theirs is busy. Each name.localhost must reach
// its own project, never the first one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-two-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dx-two-projects-"));
process.env.DX_HOME = home;
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projectsRoots: [root], editor: "code", autoConnectAi: false, localDomainsPort: 0 }));

const usual = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const port = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(port));
  });
});
for (const name of ["first-app", "second-app"]) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, ".devrc.json"), JSON.stringify({ dev: "node server.cjs", url: `http://localhost:${usual}` }));
  // Waits a moment before listening (so both start before either has the port), reads PORT, and
  // moves to the next port without a word when its own is busy.
  fs.writeFileSync(
    path.join(dir, "server.cjs"),
    `const http = require("http");
     let port = Number(process.env.PORT || ${usual});
     setTimeout(function listen() {
       const s = http.createServer((q, r) => r.end(${JSON.stringify(name)}));
       s.on("error", () => { port++; listen(); });
       s.listen(port, "localhost");
     }, 1500);
     setInterval(() => {}, 1000);`,
  );
}

const { startDashboard } = await import("../server.js");
let dashboard: Awaited<ReturnType<typeof startDashboard>>;
const api = async (p: string, body?: unknown) => {
  const res = await fetch(new URL(p, dashboard.url), { method: body === undefined ? "GET" : "POST", headers: { "X-DX-Token": dashboard.token, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json() as Promise<any>;
};
const viaName = (host: string) =>
  new Promise<string>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: dashboard.localDomainsPort, path: "/", headers: { host: `${host}:${dashboard.localDomainsPort}` } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });

before(async () => {
  dashboard = await startDashboard({ port: 0 });
});
after(async () => {
  for (const name of ["first-app", "second-app"]) await api("/api/dev/stop", { dir: path.join(root, name) });
  await dashboard.close();
});

test("two projects with the same usual port, started together, each reach their own server", async () => {
  await Promise.all(["first-app", "second-app"].map((name) => api("/api/dev/start", { dir: path.join(root, name) })));
  let list: { project: string; status: string; url?: string }[] = [];
  for (let i = 0; i < 80; i++) {
    list = await api("/api/dev");
    if (list.length === 2 && list.every((s) => s.status === "ready" && s.url)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const urls = list.map((s) => s.url);
  assert.equal(new Set(urls).size, 2, `two addresses, not one: ${urls.join(", ")}`);
  assert.equal(await viaName("first-app.localhost"), "first-app");
  assert.equal(await viaName("second-app.localhost"), "second-app", "the second name reaches the second project");
});
