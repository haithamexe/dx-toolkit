import http from "node:http";
import {
  aiCli,
  aiClis,
  aiFailure,
  askAi,
  findSpecFiles,
  forgetSpec,
  jsonFromAnswer,
  loadMocks,
  loadRules,
  loadSpec,
  mapApi,
  mocksFromSpec,
  parseSpecText,
  purgeMocks,
  putMocks,
  putRule,
  readActivity,
  readProjectSpec,
  readSpec,
  recordRun,
  removeRule,
  RULE_BODY_MAX,
  RuleError,
  saveMocks,
  saveSpec,
  SPEC_MAX_BYTES,
  SPEC_URL_PATHS,
  SpecError,
  templateMatches,
  updateMock,
  validate,
  MockError,
  type MockSource,
  type Project,
  type Schema,
} from "@dx/core";
import { flushActivity } from "./activity.js";
import { forgetRules, ruleHits, sendHistory, sendRequest } from "./apilab.js";
import { HttpError, knownProject, type ApiRequest } from "./api.js";
import { localRoutes, type LocalRoute } from "./dev.js";
import { decide, heldItem, listHeld, releaseAll } from "./intercept.js";
import { forgetMocks, mockServerFor, startMockServer, stopMockServer } from "./mocks.js";

/**
 * The Requests page: rules, Intercept, the Repeater, the API spec and its map, the mock server,
 * the response cache and AI data for mocks. Every route takes a known project's dir. Requests are
 * only ever sent to a dev server dx runs (its route), held items and AI answers stay in memory,
 * and commands are fixed: nothing from a request is run or used as an address.
 */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RuleError || err instanceof SpecError || err instanceof MockError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

/** A header map from the page: names that are names, values without line breaks, at most 100. */
function headersOf(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "Headers are names and values.");
  const out: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 100) throw new HttpError(400, "At most 100 headers.");
  for (const [k, v] of entries) {
    const value = String(v ?? "");
    if (!HEADER_NAME.test(k)) throw new HttpError(400, `"${k}" isn't a header name.`);
    if (/[\r\n]/.test(value) || value.length > 8000) throw new HttpError(400, `The header ${k} has a value that can't be sent.`);
    out[k.toLowerCase()] = value;
  }
  return out;
}

function pathOf(raw: unknown): string {
  const p = String(raw ?? "");
  if (!p.startsWith("/") || p.startsWith("//") || /[\s\r\n]/.test(p) || p.length > 8000) throw new HttpError(400, "The address is a path on the app, starting with / (like /api/orders?page=2).");
  return p;
}

function methodOf(raw: unknown): string {
  const m = String(raw ?? "GET").toUpperCase();
  if (!METHODS.includes(m)) throw new HttpError(400, `Methods: ${METHODS.join(", ")}.`);
  return m;
}

/** The dev server dx runs for this project (a stack's service, or its main one). */
function routeOf(project: Project, service?: unknown): LocalRoute {
  const all = [...localRoutes().values()].filter((r) => r.dir.toLowerCase() === project.dir.toLowerCase());
  const route = (typeof service === "string" && service ? all.find((r) => r.service === service) : undefined) ?? all.find((r) => !r.service) ?? all[0];
  if (!route) throw new HttpError(409, `${project.name}'s dev server isn't running in dx. Start it from the Projects page first: the Repeater sends to the server dx runs.`);
  return route;
}

/** A spec from a running app, on this computer only: dx's own route to its dev server. */
function fetchSpec(route: LocalRoute, specPath: string): Promise<string> {
  const port = Number(new URL(route.url).port || 80);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "localhost", port, path: specPath, headers: { accept: "application/json, application/yaml, text/yaml, */*" }, timeout: 10_000 }, (res) => {
      if ((res.statusCode ?? 0) >= 300) {
        res.resume();
        return reject(new SpecError(`${specPath} answered ${res.statusCode}.`, 404));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > SPEC_MAX_BYTES) req.destroy(new SpecError("A spec can be at most 5 MB.", 413));
        else chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("timeout", () => req.destroy(new SpecError(`${specPath} didn't answer.`, 504)));
    req.on("error", reject);
  });
}

function specSummary(project: Project) {
  const stored = loadSpec(project.dir);
  if (!stored) return undefined;
  const spec = readSpec(stored.doc);
  flushActivity();
  const events = readActivity({ dir: project.dir, since: new Date(Date.now() - 7 * 86_400_000), limit: 5000 });
  return { source: stored.source, savedAt: stored.savedAt, title: spec.title, version: spec.version, kind: spec.kind, basePath: spec.basePath, map: mapApi(spec, events) };
}

/** The spec's schema for a mock's answer, when there's a spec and it has that endpoint and status. */
function schemaFor(dir: string, ep: { method: string; path: string; pattern?: string; status: number }): Schema | undefined {
  const stored = loadSpec(dir);
  if (!stored) return undefined;
  const spec = readSpec(stored.doc);
  const sample = ep.pattern ?? ep.path.replace(/:id/g, "1");
  const found = spec.endpoints.find((e) => e.method === ep.method && (e.path === ep.pattern || templateMatches(e.path, sample)));
  const r = found?.responses.find((x) => x.status === ep.status) ?? found?.responses.find((x) => x.status === "default");
  return r?.schema;
}

const SOURCES: MockSource[] = ["recorded", "cache", "spec", "generated", "ai"];

export const labRoutes: Record<string, (req: ApiRequest) => unknown> = {
  // ------------------------------------------------------------ rules
  "GET /api/lab/rules": (req) => {
    const project = knownProject(req.query.get("dir"));
    return loadRules(project.dir, project.name).rules.map((r) => ({ ...r, hits: ruleHits.get(r.id) ?? 0 }));
  },
  "POST /api/lab/rules": (req) => {
    const project = knownProject(req.body.dir);
    const rule = call(() => putRule(project.dir, project.name, req.body.rule));
    forgetRules();
    // A rule that no longer holds requests lets go of the ones it was holding.
    if (!rule.on || !rule.intercept) for (const i of listHeld(project.dir)) if (i.rule.split(", ").includes(rule.name)) decide(i.id, { action: "forward" });
    recordRun("rules", true, `${project.name}: rule "${rule.name}" ${rule.on ? "on" : "off"}`, "web", { project: project.name });
    return rule;
  },
  "POST /api/lab/rules/remove": (req) => {
    const project = knownProject(req.body.dir);
    call(() => removeRule(project.dir, String(req.body.id ?? "")));
    forgetRules();
    recordRun("rules", true, `${project.name}: a rule removed`, "web", { project: project.name });
    return { ok: true };
  },

  // ------------------------------------------------------------ Intercept
  "GET /api/lab/intercept": (req) => listHeld(knownProject(req.query.get("dir")).dir),
  "POST /api/lab/intercept": (req) => {
    const id = String(req.body.id ?? "");
    const item = heldItem(id);
    if (!item) throw new HttpError(404, "That one already went on (after a minute, held requests go on by themselves).");
    knownProject(item.dir);
    const action = req.body.action === "drop" ? "drop" : "forward";
    const status = req.body.status === undefined || req.body.status === "" ? undefined : Number(req.body.status);
    if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) throw new HttpError(400, "A status is a number from 100 to 599.");
    if (req.body.body !== undefined && (typeof req.body.body !== "string" || Buffer.byteLength(req.body.body) > 8 * RULE_BODY_MAX)) throw new HttpError(400, "The body is text, at most 8 MB.");
    const ok = decide(id, {
      action,
      method: req.body.method === undefined ? undefined : methodOf(req.body.method),
      url: req.body.url === undefined ? undefined : pathOf(req.body.url),
      status,
      headers: req.body.headers === undefined ? undefined : headersOf(req.body.headers),
      body: req.body.body as string | undefined,
    });
    if (!ok) throw new HttpError(404, "That one already went on.");
    return { ok: true, action };
  },
  "POST /api/lab/intercept/release": (req) => ({ released: releaseAll(knownProject(req.body.dir).dir) }),

  // ------------------------------------------------------------ the Repeater
  "POST /api/lab/send": async (req) => {
    const project = knownProject(req.body.dir);
    const route = routeOf(project, req.body.service);
    const body = req.body.body === undefined || req.body.body === null ? undefined : String(req.body.body);
    if (body !== undefined && Buffer.byteLength(body) > 8 * RULE_BODY_MAX) throw new HttpError(413, "The body can be at most 8 MB.");
    const method = methodOf(req.body.method);
    const p = pathOf(req.body.path);
    const headers = headersOf(req.body.headers);
    // A value dx hid when it recorded it (a token, a cookie) can't be sent as it is: it has to be typed in.
    const hidden = Object.entries(headers).find(([, v]) => v.includes("•••"));
    if (hidden) throw new HttpError(400, `dx hid the value of ${hidden[0]} when it recorded it. Type the real value, or take the header out.`);
    const result = await sendRequest({ route, method, path: p, headers, body });
    recordRun("repeater", !result.error, `${project.name}: ${method} ${p.split("?")[0]} → ${result.error ?? result.status}`, "web", { project: project.name });
    return result;
  },
  "GET /api/lab/history": (req) => sendHistory(knownProject(req.query.get("dir")).dir),

  // ------------------------------------------------------------ the API spec
  "GET /api/lab/spec": (req) => {
    const project = knownProject(req.query.get("dir"));
    const running = [...localRoutes().values()].some((r) => r.dir.toLowerCase() === project.dir.toLowerCase());
    return { files: findSpecFiles(project.dir), urls: SPEC_URL_PATHS, running, spec: call(() => specSummary(project)) };
  },
  "POST /api/lab/spec": async (req) => {
    const project = knownProject(req.body.dir);
    let doc: Record<string, unknown> | undefined;
    let source = "";
    if (typeof req.body.file === "string") {
      doc = call(() => readProjectSpec(project.dir, String(req.body.file)));
      source = `file:${String(req.body.file).replace(/\\/g, "/")}`;
    } else if (typeof req.body.text === "string") {
      doc = call(() => parseSpecText(String(req.body.text)));
      source = "pasted";
    } else {
      // From the running app: the path given, or each usual one in turn.
      const route = routeOf(project);
      const tries = typeof req.body.url === "string" ? [pathOf(req.body.url)] : SPEC_URL_PATHS;
      for (const p of tries) {
        try {
          doc = parseSpecText(await fetchSpec(route, p));
          source = `url:${p}`;
          break;
        } catch (err) {
          if (tries.length === 1) throw err instanceof SpecError ? new HttpError(err.status, err.message) : err;
        }
      }
      if (!doc) throw new HttpError(404, `${project.name} doesn't serve a spec at the usual addresses (${SPEC_URL_PATHS.slice(0, 4).join(", ")}…). Give its file or paste it.`);
    }
    saveSpec(project.dir, source, doc);
    const summary = specSummary(project)!;
    recordRun("spec", true, `${project.name}: API spec from ${source} (${summary.map.endpoints.length} endpoints)`, "web", { project: project.name });
    return summary;
  },
  "POST /api/lab/spec/forget": (req) => {
    forgetSpec(knownProject(req.body.dir).dir);
    return { ok: true };
  },
  "POST /api/lab/spec/mocks": (req) => {
    const project = knownProject(req.body.dir);
    const stored = loadSpec(project.dir);
    if (!stored) throw new HttpError(404, `${project.name} has no API spec yet.`);
    const r = putMocks(project.dir, project.name, mocksFromSpec(readSpec(stored.doc)));
    forgetMocks();
    recordRun("mock", true, `${project.name}: mocks from the API spec, ${r.added} new, ${r.replaced} updated`, "web", { project: project.name });
    return { added: r.added, replaced: r.replaced, kept: r.kept, endpoints: r.set.endpoints.length };
  },

  // ------------------------------------------------------------ the mock server, the cache, AI data
  "POST /api/mocks/server": async (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    if (req.body.on === true) {
      if (!loadMocks(project.dir, project.name).endpoints.length) throw new HttpError(400, `${project.name} has no mocks yet: make them from its API spec, the cache or its history first.`);
      const s = await startMockServer(project.dir, project.name);
      recordRun("mock", true, `${project.name}: mock server at ${s.url}`, "web", { project: project.name });
      return s;
    }
    await stopMockServer(project.dir);
    return { ok: true };
  },
  "POST /api/mocks/purge": (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    const source = req.body.source === undefined ? undefined : (String(req.body.source) as MockSource);
    if (source !== undefined && !SOURCES.includes(source)) throw new HttpError(400, `Sources: ${SOURCES.join(", ")}.`);
    const r = purgeMocks(project.dir, source);
    forgetMocks();
    recordRun("mock", true, `${project.name}: purged ${r.removed} mock(s)${source ? ` from ${source}` : ""}`, "web", { project: project.name });
    return { removed: r.removed, endpoints: r.set.endpoints.length, server: mockServerFor(project.dir) };
  },
  "GET /api/lab/ai": async () => (await aiClis()).map((c) => ({ tool: c.tool, name: c.name })),
  "POST /api/mocks/ai": async (req) => {
    const project = knownProject(req.body.dir, { snapshots: true });
    const set = loadMocks(project.dir, project.name);
    const ep = set.endpoints.find((e) => e.id === String(req.body.id ?? ""));
    if (!ep) throw new HttpError(404, "That mock isn't there any more. Refresh the list.");
    const cli = await aiCli(req.body.tool === "codex" || req.body.tool === "claude" ? req.body.tool : undefined);
    if (!cli) throw new HttpError(400, "Neither Claude Code nor Codex is installed. Install one and sign in, then try again.");
    const note = typeof req.body.note === "string" ? req.body.note.slice(0, 2000) : "";
    const schema = schemaFor(project.dir, ep);
    // dx writes the prompt from the mock and the spec; the page only adds your note.
    const prompt = [
      "You write realistic sample data for a mock API server that a developer uses while building an app.",
      "Reply with only the JSON body of the answer, nothing else.",
      "",
      `Endpoint: ${ep.method} ${ep.pattern ?? ep.path}${ep.operation ? ` (${ep.operation})` : ""}`,
      `Answer status: ${ep.status}`,
      schema ? `JSON Schema the answer must fit:\n${JSON.stringify(schema).slice(0, 20_000)}` : "There's no schema: keep the shape of the current body.",
      ep.body ? `The current body (keep its shape and field names):\n${ep.body.slice(0, 8000)}` : "",
      note ? `What the developer wants:\n${note}` : "",
      "",
      "Make it look real and varied: names, emails, dates, prices and descriptions like a real app's, lists of 5 to 10 items unless the schema limits them, ids that fit together.",
      "Use made-up people only, example.com for emails and links, and no real secrets or tokens.",
    ]
      .filter((l) => l !== "")
      .join("\n");
    const r = await askAi(cli, prompt, { timeoutMs: 180_000 });
    if (r.code !== 0 || r.timedOut) throw new HttpError(502, aiFailure(r, `${cli.name} couldn't write the data`));
    let value: unknown;
    try {
      value = jsonFromAnswer(r.text);
    } catch {
      throw new HttpError(502, `${cli.name} didn't answer with JSON. Try again, or add a note on what you want.`);
    }
    const updated = call(() => updateMock(project.dir, ep.id, { body: JSON.stringify(value, null, 2), contentType: /json/i.test(ep.contentType) ? ep.contentType : "application/json" }));
    const after = loadMocks(project.dir, project.name);
    const mine = after.endpoints.find((e) => e.id === ep.id);
    if (mine) {
      mine.source = "ai";
      saveMocks(after);
    }
    forgetMocks();
    recordRun("mock", true, `${project.name}: ${cli.name} wrote data for ${ep.method} ${ep.path}`, "web", { project: project.name });
    return { endpoint: { ...updated, source: "ai" }, tool: cli.name, issues: schema ? validate(schema, value, "").slice(0, 5) : [] };
  },
};
