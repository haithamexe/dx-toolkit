import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The newcomer tour and the pull request proof, from fixture projects and made-up history in temp folders.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "dx-tour-home-"));
process.env.DX_HOME = home;
const { projectTour, tourMarkdown, callsByPage, detectTech, readmeIntro } = await import("../tools/tour.js");
const { prProof, proofMarkdown, withProof, PROOF_START, PROOF_END } = await import("../tools/prproof.js");
type Ev = import("../tools/activity.js").ActivityEvent;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-tour-app-"));
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Octo Cat", "-c", "user.email=octocat@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });

let id = 0;
const ev = (at: number, type: Ev["type"], extra: Partial<Ev>): Ev => ({ id: ++id, at: new Date(at).toISOString(), dir, project: "shop-website", type, text: "", from: "proxy", ...extra });

write("package.json", JSON.stringify({ name: "shop-website", scripts: { dev: "next dev", test: "vitest run" }, dependencies: { next: "^14.2.0", react: "^18.3.0", "@prisma/client": "^5.0.0" }, devDependencies: { typescript: "^5.4.0", vitest: "^1.0.0" } }));
write("README.md", "# Shop website\n\n[![CI](https://example.com/badge.svg)](https://example.com)\n\nThe **shop** for [octocat's](https://example.com) mugs: a catalogue, a cart and checkout.\n\n## Setup\n\nRun it.\n");
write(".env.example", "DATABASE_URL=postgres://localhost/shop\nSTRIPE_KEY=\n");
write(".env", "DATABASE_URL=postgres://user:pa55word@localhost/shop\nSTRIPE_KEY=sk_test_value_never_shown\n");
write("app/page.tsx", "export default function Home() { return null; }\n");
write("app/orders/[id]/page.tsx", "export default function Order() { return null; }\n");
write("app/api/orders/route.ts", "export async function GET() {}\nexport async function POST() {}\n");
write("app/api/orders/[id]/route.ts", "export async function GET() {}\n");
write("src/components/Cart.tsx", "export const Cart = () => null;\n");
write("prisma/schema.prisma", 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\nmodel User {\n  id Int @id @default(autoincrement())\n  orders Order[]\n}\nmodel Order {\n  id Int @id @default(autoincrement())\n  userId Int\n  user User @relation(fields: [userId], references: [id])\n}\n');
write(".gitignore", ".env\nnode_modules\n");
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-qm", "First version");

const t0 = Date.now() - 60_000;
const history: Ev[] = [
  ev(t0, "page", { url: "/" }),
  ev(t0 + 100, "request", { url: "/api/orders", method: "GET", status: 200, ms: 20, requestHeaders: { referer: "http://shop-website.localhost/" } }),
  ev(t0 + 5000, "route", { page: "http://shop-website.localhost/orders/7", url: "/orders/7" }),
  ev(t0 + 5100, "request", { url: "/api/orders/7", method: "GET", status: 200, ms: 12 }),
  ev(t0 + 5200, "request", { url: "/api/orders/7", method: "GET", status: 200, ms: 11 }),
  ev(t0 + 9000, "request", { url: "/api/unknown", method: "DELETE", status: 404, ms: 3, requestHeaders: { referer: "http://shop-website.localhost/orders/7" } }),
];

test("calls are put under the page that made them: Referer first, else the page open just before", () => {
  const r = callsByPage(history);
  assert.equal(r.pages.get("/"), 1);
  assert.equal(r.pages.get("/orders/:id"), 1);
  assert.deepEqual([...r.calls.get("/")!], [["GET /api/orders", 1]]);
  assert.deepEqual([...r.calls.get("/orders/:id")!], [["GET /api/orders/:id", 2], ["DELETE /api/unknown", 1]]);
});

test("the tour maps pages to calls to files, with names of settings but never their values", () => {
  const t = projectTour({ name: "shop-website", dir, packageManager: "npm", devCommand: "npm run dev", scripts: ["dev", "test"] }, { events: history });
  assert.match(t.about ?? "", /^The shop for octocat's mugs: a catalogue, a cart and checkout\.$/);
  for (const x of ["Next.js 14", "React 18", "Prisma", "TypeScript"]) assert.ok(t.tech.includes(x), x);
  const order = t.pages.find((p) => p.path === "/orders/:id")!;
  assert.equal(order.file, "app/orders/[id]/page.tsx");
  assert.equal(order.visits, 1);
  assert.deepEqual(order.calls.map((c) => [c.key, c.count, c.file]), [["GET /api/orders/:id", 2, "app/api/orders/[id]/route.ts"], ["DELETE /api/unknown", 1, undefined]]);
  const list = t.endpoints.find((e) => e.key === "GET /api/orders")!;
  assert.equal(list.file, "app/api/orders/route.ts");
  assert.deepEqual(list.pages, ["/"]);
  assert.ok(t.endpoints.some((e) => e.key === "POST /api/orders" && e.calls === 0), "declared and never called is still listed");
  assert.deepEqual(t.env.map((e) => e.name), ["DATABASE_URL", "STRIPE_KEY"]);
  assert.deepEqual(t.data?.tables.map((x) => [x.name, x.links]), [["User", []], ["Order", ["User"]]]);
  assert.deepEqual(t.tests, { framework: "vitest", command: "npm test" });
  assert.ok(t.folders.some((f) => f.path === "src/components" && f.what === "UI components"));
  const md = tourMarkdown(t);
  const all = JSON.stringify(t) + md;
  assert.ok(!all.includes("pa55word") && !all.includes("sk_test_value_never_shown"), "no .env value in the tour");
  assert.match(md, /^# shop-website/);
  assert.match(md, /\| `\/orders\/:id` \| `app\/orders\/\[id\]\/page\.tsx` \| `GET \/api\/orders\/:id`<br>`DELETE \/api\/unknown` \|/);
  assert.ok(md.includes("`dx go shop-website`"));
});

test("the tour has the project's API spec, found by itself, next to what was called", () => {
  assert.equal(projectTour({ name: "shop-website", dir }, { events: history }).specs, undefined, "no spec yet");
  write("docs/openapi.json", JSON.stringify({ openapi: "3.0.3", info: { title: "Shop API", version: "2.0" }, paths: { "/api/orders": { get: { summary: "The orders" } }, "/api/orders/{id}": { get: { summary: "One order" } }, "/api/orders/{id}/refund": { post: { summary: "Refund it" } } } }));
  try {
    const t = projectTour({ name: "shop-website", dir }, { events: history });
    assert.deepEqual([t.specs?.[0]?.title, t.specs?.[0]?.version, t.specs?.[0]?.source, t.undocumented], ["Shop API", "2.0", "file:docs/openapi.json", 1]);
    assert.deepEqual(
      t.specs?.[0]?.endpoints.map((e) => [e.method, e.path, e.calls]),
      [["GET", "/api/orders", 1], ["GET", "/api/orders/{id}", 2], ["POST", "/api/orders/{id}/refund", 0]],
    );
    assert.match(tourMarkdown(t), /## API spec\n\nShop API 2\.0 \(openapi 3\.0\.3, from docs\/openapi\.json\):/);
  } finally {
    fs.rmSync(path.join(dir, "docs"), { recursive: true, force: true });
  }
});

test("README intros skip badges and headings, and Python projects are recognised", () => {
  assert.equal(readmeIntro(path.join(dir, "missing")), undefined);
  const py = fs.mkdtempSync(path.join(os.tmpdir(), "dx-tour-py-"));
  fs.writeFileSync(path.join(py, "requirements.txt"), "fastapi==0.110\nsqlalchemy>=2\n");
  assert.deepEqual(detectTech(py), ["Python", "FastAPI", "SQLAlchemy"]);
  fs.rmSync(py, { recursive: true, force: true });
});

test("the proof's section replaces an earlier one, or goes at the end", () => {
  const section = `${PROOF_START}\nnew\n${PROOF_END}`;
  assert.equal(withProof("", section), `${section}\n`);
  assert.equal(withProof("Fixes the cart.\n", section), `Fixes the cart.\n\n${section}\n`);
  assert.equal(withProof(`Intro\n\n${PROOF_START}\nold\n${PROOF_END}\n\nOutro`, section), `Intro\n\n${section}\n\nOutro`);
});

test("the proof says what was tested on the branch, from dx's own records", async () => {
  git("checkout", "-q", "-b", "fix-cart");
  write("src/components/Cart.tsx", "export const Cart = () => 'cart';\n");
  git("commit", "-qam", "Fix the cart total");
  const sha = git("rev-parse", "HEAD").trim();
  write("src/components/Cart.tsx", "export const Cart = () => 'cart!';\n");
  const now = Date.now();
  const events: Ev[] = [
    ev(now - 50_000, "page", { url: "/cart" }),
    ev(now - 49_000, "request", { url: "/api/cart/3", method: "GET", status: 200, ms: 9 }),
    ev(now - 48_000, "error", { text: "TypeError: total is undefined", level: "error", from: "browser" }),
    ev(now + 5_000, "error", { text: "TypeError: total is undefined", level: "error", from: "browser" }),
  ];
  const runs = [
    { at: new Date(now - 30_000).toISOString(), tool: "test", ok: true, detail: "shop-website: 12 passed, 0 failed", project: "shop-website" },
    { at: new Date(now - 20_000).toISOString(), tool: "gremlins", ok: true, detail: "shop-website: No problems in 40 actions (#4812)", project: "shop-website" },
    { at: new Date(now - 10_000).toISOString(), tool: "test", ok: true, detail: "other-app: 1 passed, 0 failed", project: "other-app" },
  ];
  const visual = [{ commit: sha, at: new Date(now).toISOString(), subject: "Fix the cart total", captures: [{ name: "cart@desktop", path: "/cart", viewport: "desktop" as const, width: 1280, height: 800, changed: true, ratio: 0.04, label: "the Checkout button", slower: "largest paint 200 ms → 900 ms", a11yNew: [{ rule: "alt", text: "Image without alt text: logo.png" }] }] }];
  const p = await prProof({ name: "shop-website", dir }, { events, runs, visual: visual as never, now });
  assert.equal(p.branch, "fix-cart");
  assert.equal(p.base, "main");
  assert.deepEqual(p.commits.map((c) => c.subject), ["Fix the cart total"]);
  assert.equal(p.uncommitted, 1);
  assert.equal(p.tests?.detail, "12 passed, 0 failed");
  assert.deepEqual(p.pages, [{ path: "/cart", visits: 1 }]);
  assert.equal(p.calls, 1);
  assert.equal(p.errors.length, 1);
  assert.equal(p.errors[0].count, 2);
  assert.equal(p.errors[0].open, true, "it came up after the last commit");
  assert.deepEqual(p.checks.map((c) => c.tool), ["Gremlins"]);
  assert.deepEqual(p.visual[0].changed, ["/cart (the Checkout button, 4%)"]);
  const md = p.markdown;
  assert.ok(md.startsWith(PROOF_START) && md.endsWith(PROOF_END));
  for (const bit of ["✅ **Tests**: 12 passed, 0 failed", "**Tried by hand**: 1 page (`/cart`)", "1 still came up after the last commit", "✅ **Gremlins**: No problems in 40 actions (#4812)", "👀 **Looks different**: /cart (the Checkout button, 4%)", "🐢 **Slower**: /cart: largest paint 200 ms → 900 ms", "1 file isn't committed yet"]) assert.ok(md.includes(bit), bit);
  assert.ok(!md.includes("other-app"));
  assert.equal(proofMarkdown(p), md);
});
