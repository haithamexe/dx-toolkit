import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-https-home-"));
const { startLocalDomains } = await import("../proxy.js");
const { certCovers } = await import("@dx/core");

// A throwaway self-signed certificate for the test, made with openssl when it's on PATH.
function selfSigned(): { cert: Buffer; key: Buffer } | undefined {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-https-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    return { cert: fs.readFileSync(path.join(dir, "c.pem")), key: fs.readFileSync(path.join(dir, "k.pem")) };
  } catch {
    return undefined;
  }
}

test("certCovers matches names and *.parent wildcards", () => {
  const names = ["dx.localhost", "shop.localhost", "*.shop.localhost"];
  assert.ok(certCovers("shop.localhost", names));
  assert.ok(certCovers("api.shop.localhost", names));
  assert.ok(certCovers("DX.localhost", names));
  assert.ok(!certCovers("blog.localhost", names));
  assert.ok(!certCovers("a.b.shop.localhost", names), "a wildcard covers one level only");
});

const pair = selfSigned();
test("https:// is served with the same routes, and a new name refreshes the certificate", { skip: pair ? false : "openssl isn't on PATH" }, async () => {
  // Stands in for the dashboard behind dx.localhost.
  const seen: http.IncomingHttpHeaders[] = [];
  const target = http.createServer((req, res) => {
    seen.push(req.headers);
    res.end("dashboard");
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  let refreshed = "";
  const domains = await startLocalDomains({
    dashboardPort: (target.address() as AddressInfo).port,
    ports: [0],
    tls: {
      ...pair!,
      ports: [0],
      covers: () => false,
      refresh: async (host) => {
        refreshed = host;
        return pair;
      },
    },
  });
  try {
    assert.ok(domains?.httpsPort, "https is listening");
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port: domains!.httpsPort, path: "/", servername: "dx.localhost", headers: { host: "dx.localhost" }, rejectUnauthorized: false },
        (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => resolve(b));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(body, "dashboard");
    assert.equal(seen[0]["x-forwarded-proto"], "https");
    assert.equal(refreshed, "dx.localhost", "a name the certificate didn't cover was added");
  } finally {
    await domains?.close();
    target.close();
  }
});
