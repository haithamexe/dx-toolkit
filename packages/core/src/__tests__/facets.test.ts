import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-facets-test-"));
const { BUILT_IN_VIEWS, cleanFilter, emptyFilter, facetCounts, filterFromQuery, filterItems, filterToQuery, frameworkOf, isEmptyFilter, readMeta, removeView, saveView, setPinned, setProjectTags } = await import("../index.js");
type Item = import("../index.js").FacetItem;

const item = (name: string, over: Partial<Item> = {}): Item => ({ name, dir: `/path/to/${name}`, kind: "Vite", status: [], tags: [], pinned: false, lastActive: 0, changed: 0, unpushed: 0, behind: 0, ...over });
const items: Item[] = [
  item("shop-website", { kind: "Next.js", status: ["running", "needs", "unsaved"], tags: ["client"] }),
  item("todo-app", { status: ["running"], tags: ["client", "side project"], pinned: true }),
  item("archive", { kind: "Python", tags: ["client"] }),
  item("api-gateway", { kind: "Node server", status: ["unsaved", "behind"] }),
  item("notes", { status: [] }),
];

test("within a facet it's or, across facets it's and", () => {
  const names = (f: Partial<ReturnType<typeof emptyFilter>>) => filterItems(items, { ...emptyFilter(), ...f }).map((i) => i.name);
  assert.deepEqual(names({ status: ["running"] }), ["todo-app", "shop-website"], "pinned first, then by name");
  assert.deepEqual(names({ status: ["running", "behind"] }), ["todo-app", "api-gateway", "shop-website"], "running or behind");
  assert.deepEqual(names({ status: ["running"], tag: ["client"] }), ["todo-app", "shop-website"]);
  assert.deepEqual(names({ status: ["running"], kind: ["Next.js"] }), ["shop-website"]);
  assert.deepEqual(names({ kind: ["Python", "Node server"] }), ["api-gateway", "archive"]);
  assert.deepEqual(names({ pinned: true }), ["todo-app"]);
  assert.deepEqual(names({ q: "SIDE" }), ["todo-app"], "text reaches tags, any case");
  assert.deepEqual(names({}).length, 5);
});

test("each choice's count is taken with the other facets applied, not its own", () => {
  const f = { ...emptyFilter(), status: ["running" as const], tag: ["client"] };
  const c = facetCounts(items, f);
  const get = (list: { value: string; count: number }[], v: string) => list.find((x) => x.value === v)?.count;
  assert.equal(get(c.status, "running"), 2, "status is counted among the client projects: two of the three are running");
  assert.equal(get(c.status, "unsaved"), 1, "unsaved among the client projects: shop-website");
  assert.equal(get(c.status, "behind"), 0, "a choice that would show nothing says 0");
  assert.equal(get(c.tag, "client"), 2, "tags counted among the running ones");
  assert.equal(get(c.tag, "side project"), 1);
  assert.equal(get(c.kind, "Python"), 0, "archive is a client project but not running");
  assert.equal(c.pinned, 1);
});

test("a choice you made stays listed at zero so you can take it off", () => {
  const c = facetCounts(items, { ...emptyFilter(), tag: ["no-such-tag"], kind: ["Rust"] });
  assert.equal(c.tag.find((t) => t.value === "no-such-tag")?.count, 0);
  assert.equal(c.kind.find((k) => k.value === "Rust")?.count, 0);
});

test("a filter travels in the address and comes back the same", () => {
  const f = { ...emptyFilter(), status: ["running" as const, "needs" as const], kind: ["Next.js"], tag: ["side project"], pinned: true, q: "shop web" };
  const q = filterToQuery(f);
  assert.equal(q, "status=running,needs&kind=Next.js&tag=side%20project&pinned=1&q=shop%20web");
  assert.deepEqual(filterFromQuery(new URLSearchParams(q)), f);
  assert.equal(filterToQuery(emptyFilter()), "");
  assert.ok(isEmptyFilter(filterFromQuery(new URLSearchParams(""))));
});

test("a filter from outside keeps only what is known and well-formed", () => {
  const f = cleanFilter({ status: ["running", "exploded", 7], kind: ["Vite", "<script>"], tag: ["Client", "bad/tag"], pinned: "true", q: "  x ".repeat(80), extra: "ignored" });
  assert.deepEqual(f.status, ["running"]);
  assert.deepEqual(f.kind, ["Vite"]);
  assert.deepEqual(f.tag, ["client"], "lower case, and a tag with a slash isn't one");
  assert.equal(f.pinned, true);
  assert.ok(f.q.length <= 80);
  assert.deepEqual(cleanFilter("nonsense"), emptyFilter());
});

test("a framework from the dependencies, else the language", () => {
  const make = (deps: Record<string, string>, kind: "node" | "python" = "node") => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dx-fw-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: deps }));
    return { dir, kind };
  };
  assert.equal(frameworkOf(make({ next: "15", react: "19" })), "Next.js");
  assert.equal(frameworkOf(make({ react: "19", vite: "6" })), "Vite");
  assert.equal(frameworkOf(make({ express: "5" })), "Node server");
  assert.equal(frameworkOf(make({ left: "1" })), "Node");
  assert.equal(frameworkOf(make({ next: "15" }, "python")), "Python", "another language's folder isn't read as Node");
  assert.equal(frameworkOf({ dir: "/path/to/nowhere", kind: "node" }), "Node");
});

test("tags are kept as words, checked, and refused by name when they aren't", () => {
  assert.deepEqual(setProjectTags("/path/to/todo-app", " Client , side  project ,client"), ["client", "side project"]);
  assert.deepEqual(readMeta().tags["/path/to/todo-app"], ["client", "side project"]);
  assert.throws(() => setProjectTags("/path/to/todo-app", "ok, bad/tag"), /"bad\/tag" isn't a tag/);
  assert.throws(() => setProjectTags("/path/to/todo-app", "a,b,c,d,e,f,g,h,i"), /at most 8/);
  assert.deepEqual(setProjectTags("/path/to/todo-app", ""), []);
  assert.equal(readMeta().tags["/path/to/todo-app"], undefined, "an empty list removes the entry");
});

test("pins and saved views are kept, replaced by name, limited, and removable", () => {
  setPinned("/Path/To/Todo-App", true);
  assert.deepEqual(readMeta().pinned, ["/path/to/todo-app"], "stored lower case, once");
  setPinned("/path/to/todo-app", true);
  assert.equal(readMeta().pinned.length, 1);
  setPinned("/path/to/todo-app", false);
  assert.deepEqual(readMeta().pinned, []);

  const v = saveView("Client work, running", { status: ["running"], tag: ["client"], junk: 1 });
  assert.equal(v.id, "client-work-running");
  assert.deepEqual(v.filter, { ...emptyFilter(), status: ["running"], tag: ["client"] });
  saveView("Client work, running", { status: ["needs"] });
  assert.equal(readMeta().views.length, 1, "the same name replaces it");
  assert.deepEqual(readMeta().views[0].filter.status, ["needs"]);
  assert.throws(() => saveView("", { status: ["running"] }), /Give the view a name/);
  assert.throws(() => saveView("Empty", {}), /nothing to save/);
  for (let i = 0; i < 19; i++) saveView(`View ${i}`, { status: ["running"] });
  assert.throws(() => saveView("One too many", { status: ["running"] }), /up to 20 views/);
  assert.equal(removeView("client-work-running"), true);
  assert.equal(removeView("client-work-running"), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(process.env.DX_HOME!, "projectmeta.json")).mode & 0o777, 0o600);
});

test("the views dx starts with are plain filters", () => {
  assert.deepEqual(BUILT_IN_VIEWS.map((v) => v.id), ["needs-me", "running", "unsaved", "pinned"]);
  assert.deepEqual(filterItems(items, BUILT_IN_VIEWS[0].filter).map((i) => i.name), ["shop-website"]);
});
