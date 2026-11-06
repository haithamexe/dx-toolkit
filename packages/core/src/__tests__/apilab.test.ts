import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-apilab-test-"));
const core = await import("../index.js");
const {
  cleanRule,
  pathMatches,
  matchRules,
  planRules,
  editBody,
  editHeaders,
  setJsonPath,
  putRule,
  loadRules,
  removeRule,
  parseYaml,
  parseSpecText,
  readSpec,
  mocksFromSpec,
  exampleFor,
  mapApi,
  validate,
  findSpecFiles,
  projectSpec,
  forgetSpec,
  saveSpec,
  specSource,
  specTurnedOff,
  templateMatches,
  matchMock,
  putMocks,
  loadMocks,
  purgeMocks,
  setMockMode,
  jsonFromAnswer,
} = core;

const SPEC_YAML = `
openapi: 3.0.3
info:
  title: Shop API   # the demo shop
  version: "1.2"
servers:
  - url: https://api.shop-website.dev/v1
paths:
  /users/{id}:
    get:
      operationId: getUser
      summary: One user
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: The user
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/User"
        '404':
          description: No such user
          content:
            application/json:
              examples:
                missing:
                  value: { error: "not found" }
  /users/me:
    get:
      responses:
        "200":
          description: You
          content:
            application/json:
              example:
                id: me
                email: octocat@example.com
  /orders:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema: { type: object, properties: { total: { type: number } } }
      responses:
        "201":
          description: |
            Created.
            With a second line.
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Order"
components:
  schemas:
    User:
      type: object
      required: [id, email]
      properties:
        id: { type: string, format: uuid }
        email: { type: string, format: email }
        firstName: { type: string }
        createdAt: { type: string, format: date-time }
        role: { type: string, enum: [admin, member] }
    Order:
      type: object
      properties:
        id: { type: integer }
        price: { type: number }
        user:
          $ref: "#/components/schemas/User"
`;

test("yaml: the parts of YAML API specs use", () => {
  const doc = parseYaml(SPEC_YAML) as any;
  assert.equal(doc.openapi, "3.0.3");
  assert.equal(doc.info.title, "Shop API", "a comment after a value is dropped");
  assert.equal(doc.info.version, "1.2", "quoted numbers stay text");
  assert.equal(doc.servers[0].url, "https://api.shop-website.dev/v1");
  assert.ok(doc.paths["/users/{id}"].get.responses["200"], "status keys stay text");
  assert.deepEqual(doc.paths["/users/{id}"].get.parameters[0].schema, { type: "string" });
  assert.equal(doc.paths["/orders"].post.responses["201"].description, "Created.\nWith a second line.\n");
  assert.deepEqual(doc.components.schemas.User.required, ["id", "email"]);
  assert.deepEqual(parseYaml("a:\n- 1\n- two\nb: 'it''s'\nc: ~\nd: true\n"), { a: [1, "two"], b: "it's", c: null, d: true });
  assert.throws(() => parseYaml("a: &x 1\nb: *x\n"), /anchors/);
});

test("openapi: OpenAPI 3 and Swagger 2 read into one list of endpoints, references followed", () => {
  const spec = readSpec(parseSpecText(SPEC_YAML));
  assert.equal(spec.title, "Shop API");
  assert.equal(spec.basePath, "/v1", "the server's path, not its host");
  const user = spec.endpoints.find((e) => e.path === "/v1/users/{id}")!;
  assert.equal(user.operationId, "getUser");
  assert.equal((user.responses[0].schema as any).properties.email.format, "email", "$ref followed");
  assert.equal(user.responses[1].examples[0].name, "missing");
  const order = spec.endpoints.find((e) => e.method === "POST")!;
  assert.equal(order.requestBody?.required, true);
  assert.equal(((order.responses[0].schema as any).items.properties.user.properties.id as any).format, "uuid", "nested references too");

  const swagger = readSpec(
    parseSpecText(
      JSON.stringify({
        swagger: "2.0",
        info: { title: "Old API", version: "1" },
        basePath: "/api",
        paths: { "/pets": { get: { responses: { 200: { description: "ok", schema: { type: "array", items: { $ref: "#/definitions/Pet" } } } } } } },
        definitions: { Pet: { type: "object", properties: { name: { type: "string" } } } },
      }),
    ),
  );
  assert.equal(swagger.endpoints[0].path, "/api/pets");
  assert.equal((swagger.endpoints[0].responses[0].schema as any).items.properties.name.type, "string");
  assert.throws(() => parseSpecText('{"hello": 1}'), /isn't an OpenAPI or Swagger/);
});

test("openapi: made-up data fits the schema and reads like real data, the same every time", () => {
  const user = { type: "object", properties: { id: { type: "string", format: "uuid" }, email: { type: "string", format: "email" }, firstName: { type: "string" }, createdAt: { type: "string", format: "date-time" }, role: { type: "string", enum: ["admin", "member"] }, price: { type: "number" }, tags: { type: "array", items: { type: "string" } } } };
  const a = exampleFor(user, "", "seed") as any;
  assert.deepEqual(exampleFor(user, "", "seed"), a, "deterministic");
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  assert.match(a.email, /@example\.com$/);
  assert.ok(!Number.isNaN(Date.parse(a.createdAt)));
  assert.equal(a.role, "admin");
  assert.ok(a.price >= 5 && a.price <= 500);
  assert.equal(a.tags.length, 3);
  assert.deepEqual(validate(user, a, ""), [], "what's made up passes the spec's own check");
});

test("openapi: mocks from the spec answer from the first call; a template fits any value", () => {
  const spec = readSpec(parseSpecText(SPEC_YAML));
  const mocks = mocksFromSpec(spec);
  const user200 = mocks.find((m) => m.pattern === "/v1/users/{id}" && m.status === 200)!;
  assert.equal(user200.source, "generated");
  assert.equal(user200.path, "/v1/users/:id");
  const me = mocks.find((m) => m.path === "/v1/users/me")!;
  assert.equal(me.source, "spec");
  assert.equal(JSON.parse(me.body).email, "octocat@example.com");
  const missing = mocks.find((m) => m.example === "missing")!;
  assert.equal(missing.status, 404);

  assert.equal(templateMatches("/v1/users/{id}", "/v1/users/alice?x=1"), true);
  assert.equal(templateMatches("/v1/users/{id}", "/v1/users/alice/orders"), false);
  assert.equal(templateMatches("/files/{name}.json", "/files/report.json"), true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shop-website-"));
  putMocks(dir, "shop-website", mocks);
  const set = loadMocks(dir);
  assert.equal(matchMock(set, { method: "GET", url: "/v1/users/alice" })?.status, 200, "a success is the usual answer");
  assert.equal(matchMock(set, { method: "GET", url: "/v1/users/me" })?.id, me.id, "an exact path beats the template");
  assert.equal(matchMock(set, { method: "GET", url: "/v1/users/alice" }, { code: 404 })?.status, 404, "x-mock-response-code");
  assert.equal(matchMock(set, { method: "GET", url: "/v1/users/alice" }, { name: "missing" })?.example, "missing", "x-mock-response-name");
  assert.equal(matchMock(set, { method: "DELETE", url: "/v1/users/alice" }), undefined);

  // A real answer kept by the cache beats data made up from the schema; purging the cache brings it back.
  putMocks(dir, "shop-website", [{ ...user200, id: "cache1", pattern: undefined, path: "/v1/users/:id", source: "cache", body: '{"id":"real"}' }]);
  assert.equal(JSON.parse(matchMock(loadMocks(dir), { method: "GET", url: "/v1/users/42" })!.body).id, "real");
  assert.equal(purgeMocks(dir, "cache").removed, 1);
  assert.equal(matchMock(loadMocks(dir), { method: "GET", url: "/v1/users/42" })?.source, "generated");
  const modes = setMockMode(dir, "shop-website", { cache: true });
  assert.equal(modes.cache, true);
});

test("openapi: the API map puts the spec next to what the app called", () => {
  const spec = readSpec(parseSpecText(SPEC_YAML));
  const at = new Date().toISOString();
  const ev = (id: number, method: string, url: string, status: number, body?: string) =>
    ({ id, at, dir: "/x", project: "shop", type: "request", text: "", method, url, status, responseBody: body, responseHeaders: { "content-type": "application/json" }, from: "proxy" }) as any;
  const map = mapApi(spec, [
    ev(1, "GET", "/v1/users/42", 200, JSON.stringify({ id: "42", email: 7, role: "owner" })),
    ev(2, "GET", "/v1/users/me", 200, JSON.stringify({ id: "me", email: "a@b.c" })),
    ev(3, "GET", "/v1/users/42", 418),
    ev(4, "GET", "/v1/health", 200, "{}"),
    ev(5, "DELETE", "/v1/orders/9", 204),
  ]);
  const user = map.endpoints.find((e) => e.path === "/v1/users/{id}")!;
  assert.equal(user.calls, 2, "/users/me goes to its own endpoint");
  assert.ok(user.issues.some((i) => /email is a number, the spec says text/.test(i)));
  assert.ok(user.issues.some((i) => /owner/.test(i)));
  assert.ok(user.issues.some((i) => /418/.test(i)));
  assert.equal(map.endpoints.find((e) => e.path === "/v1/orders")!.calls, 0, "never called");
  assert.deepEqual(map.undocumented.map((u) => `${u.method} ${u.path}`).sort(), ["DELETE /v1/orders/:id", "GET /v1/health"]);
});

test("openapi: spec files are found in the project, most likely first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-gateway-"));
  fs.mkdirSync(path.join(dir, "docs"));
  fs.mkdirSync(path.join(dir, "node_modules", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "openapi.yaml"), SPEC_YAML);
  fs.writeFileSync(path.join(dir, "swagger.json"), JSON.stringify({ swagger: "2.0", paths: {} }));
  fs.writeFileSync(path.join(dir, "node_modules", "lib", "openapi.json"), JSON.stringify({ openapi: "3.0.0" }));
  fs.writeFileSync(path.join(dir, "api.json"), JSON.stringify({ not: "a spec" }));
  assert.deepEqual(findSpecFiles(dir), ["swagger.json", "docs/openapi.yaml"]);
});

test("openapi: a project's spec is found by itself, read fresh, and stays gone once removed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shop-website-"));
  assert.equal(projectSpec(dir), undefined, "no spec file, none given");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs", "openapi.yaml"), SPEC_YAML);
  const found = projectSpec(dir)!;
  assert.deepEqual([found.source, found.found, specSource(found.source)], ["file:docs/openapi.yaml", true, "from docs/openapi.yaml"]);
  const count = (s: ReturnType<typeof projectSpec>) => readSpec(s!.doc).endpoints.length;
  const before = count(projectSpec(dir));
  // An edit to the file shows the next time, without giving it again.
  fs.writeFileSync(path.join(dir, "docs", "openapi.yaml"), SPEC_YAML.replace("paths:", "paths:\n  /api/health:\n    get:\n      summary: Up?\n      responses:\n        '200':\n          description: ok"));
  assert.equal(count(projectSpec(dir)), before + 1);
  // Removed on purpose: the file is still there, but dx doesn't pick it up again by itself.
  forgetSpec(dir);
  assert.equal(specTurnedOff(dir), true);
  assert.equal(projectSpec(dir), undefined);
  // Giving it one again replaces that.
  saveSpec(dir, "pasted", parseSpecText(SPEC_YAML));
  assert.equal(specTurnedOff(dir), false);
  assert.deepEqual([projectSpec(dir)!.source, projectSpec(dir)!.found, specSource("url:/openapi.json")], ["pasted", undefined, "from the running app at /openapi.json"]);
});

test("rules: only known fields of the right shape, and dx's own headers stay dx's", () => {
  const r = cleanRule({ method: "post", path: "/api/orders/*", request: { setHeaders: { "X-Debug": "1" }, json: [{ path: "items.0.qty", value: 5 }] }, response: { status: "503" }, delayMs: 99_999, fail: "drop", extra: "ignored" })!;
  assert.equal(r.method, "POST");
  assert.equal(r.delayMs, 30_000, "capped");
  assert.equal(r.response?.status, 503);
  assert.deepEqual(r.request?.setHeaders, { "x-debug": "1" });
  assert.equal((r as any).extra, undefined);
  assert.throws(() => cleanRule({ path: "/x", request: { setHeaders: { "Content-Length": "9" } } }), /can't set/);
  assert.throws(() => cleanRule({ path: "/x", request: { setHeaders: { "X-A": "a\r\nInjected: 1" } } }), /can't send/);
  assert.throws(() => cleanRule({ path: "no-slash" }), /starts with \//);
  assert.throws(() => cleanRule({ path: "/x", method: "TRACE" }), /Unknown method/);
});

test("rules: paths, methods and the order rules apply in", () => {
  assert.equal(pathMatches("/api/orders/*", "/api/orders/42?x=1"), true);
  assert.equal(pathMatches("/api/orders/*", "/api/orders/42/items"), false);
  assert.equal(pathMatches("/api/**", "/api/orders/42/items"), true);
  assert.equal(pathMatches("/api/search?q=*", "/api/search?q=shoes&page=2"), true);
  assert.equal(pathMatches("/api/search?q=hats", "/api/search?q=shoes"), false);
  assert.equal(pathMatches("/api/*.json", "/api/data.json"), true);
  const set = { format: "dx-rules", version: 1, dir: "/x", project: "x", updatedAt: "", rules: [cleanRule({ path: "/api/**", delayMs: 500 })!, cleanRule({ method: "GET", path: "/api/orders", response: { json: [{ path: "total", value: 0 }] } })!, cleanRule({ on: false, path: "**", fail: "500" })!] } as any;
  const plan = planRules(matchRules(set, { method: "GET", url: "/api/orders" }))!;
  assert.equal(plan.rules.length, 2, "a rule that's off doesn't apply");
  assert.equal(plan.delayMs, 500);
  assert.equal(plan.fail, undefined);
  assert.equal(plan.needsResponseBody, true);
  assert.equal(planRules(matchRules(set, { method: "POST", url: "/other" })), undefined);
});

test("rules: editing headers and JSON bodies", () => {
  assert.deepEqual(editHeaders({ Authorization: "x", Accept: "a" }, { removeHeaders: ["authorization"], setHeaders: { "x-role": "admin" } }), { accept: "a", "x-role": "admin" });
  assert.equal(editBody('{"user":{"name":"a"},"items":[{"qty":1}]}', { json: [{ path: "user.name", value: "b" }, { path: "items.0.qty", value: 9 }, { path: "user.admin", value: true }] }).body, '{"user":{"name":"b","admin":true},"items":[{"qty":9}]}');
  assert.equal(editBody('{"a":1,"b":2}', { json: [{ path: "b", remove: true }] }).body, '{"a":1}');
  assert.equal(editBody("not json", { json: [{ path: "a", value: 1 }] }).note, "the body isn't JSON, so its fields weren't changed");
  assert.equal(editBody("anything", { body: "replaced" }).body, "replaced");
  const polluted = setJsonPath({}, "__proto__.admin", true);
  assert.equal(({} as any).admin, undefined, "no prototype pollution");
  assert.deepEqual(polluted, {});
});

test("rules: kept per project, readable only by you, and removed by id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-app-"));
  const r = putRule(dir, "todo-app", { path: "/api/todos", fail: "500" });
  assert.equal(loadRules(dir).rules[0].id, r.id);
  putRule(dir, "todo-app", { ...r, fail: undefined, delayMs: 2000 });
  assert.equal(loadRules(dir).rules.length, 1, "same id replaces");
  assert.equal(loadRules(dir).rules[0].delayMs, 2000);
  removeRule(dir, r.id);
  assert.equal(loadRules(dir).rules.length, 0);
  assert.throws(() => removeRule(dir, r.id), /isn't there/);
});

test("ai: the JSON in an agent's answer", () => {
  assert.deepEqual(jsonFromAnswer('Here you go:\n```json\n{"a": 1}\n```\nEnjoy'), { a: 1 });
  assert.deepEqual(jsonFromAnswer('[{"id": 1}]'), [{ id: 1 }]);
  assert.deepEqual(jsonFromAnswer('Sure! {"b": 2}'), { b: 2 });
  assert.throws(() => jsonFromAnswer("no json here"), /wasn't JSON/);
});
