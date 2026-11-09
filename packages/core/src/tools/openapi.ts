import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dxPath } from "../config.js";
import type { ActivityEvent } from "./activity.js";
import { foldPath, templateMatches, type MockEndpoint, type MockSource } from "./mocks.js";
import { parseYaml } from "./yaml.js";

/**
 * A project's API spec (OpenAPI 3 or Swagger 2), found in its folder, on its running dev server,
 * or given by hand. dx reads it into a list of endpoints, maps it against what the app really
 * called (called, never called, not in the spec, answers that don't match it), and makes mock
 * endpoints from it: the spec's own examples, or data made up from its schemas, so a mock server
 * answers from the first call. The spec dx uses is kept per project under ~/.dx/specs.
 */

export interface SpecResponse {
  status: number | "default";
  description?: string;
  contentType?: string;
  schema?: Schema;
  examples: Array<{ name: string; value: unknown }>;
}

export interface SpecEndpoint {
  method: string;
  /** The spec's path template, with the server's base path in front: /api/users/{id}. */
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  parameters: Array<{ name: string; in: string; required: boolean; schema?: Schema }>;
  requestBody?: { contentType: string; schema?: Schema; required: boolean };
  responses: SpecResponse[];
  /** Which of the project's APIs it's from (the spec's id and name), once there can be several. */
  api?: string;
  apiName?: string;
}

export interface ApiSpec {
  title: string;
  version: string;
  /** "openapi 3.1.0" or "swagger 2.0". */
  kind: string;
  basePath: string;
  endpoints: SpecEndpoint[];
  /** The project's API this is: its id, name and (in a stack) the service it is. */
  api?: string;
  apiName?: string;
  service?: string;
}

export type Schema = Record<string, unknown>;

export class SpecError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const SPEC_MAX_BYTES = 5 * 1024 * 1024;
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

// ------------------------------------------------------------------ finding and keeping

const SPEC_NAME = /^(openapi|swagger|api-docs|api|oas)([.-][\w-]+)?\.(json|ya?ml)$|\.(openapi|swagger)\.(json|ya?ml)$/i;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "vendor", ".venv", "venv", "target", "__pycache__"]);

/** Spec files in the project (its folder and three levels down), most likely first. */
export function findSpecFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3 && !SKIP.has(e.name) && !e.name.startsWith(".")) walk(full, depth + 1);
      } else if (e.isFile() && SPEC_NAME.test(e.name)) {
        try {
          if (fs.statSync(full).size > SPEC_MAX_BYTES) continue;
          const head = fs.readFileSync(full, "utf8").slice(0, 2000);
          if (/["']?(openapi|swagger)["']?\s*:/.test(head)) found.push(path.relative(dir, full).split(path.sep).join("/"));
        } catch {
          // unreadable: skipped
        }
      }
    }
  };
  walk(dir, 0);
  const rank = (f: string) => (f.split("/").length - 1) * 2 + (/openapi/i.test(f) ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Where a running app usually serves its spec (FastAPI, NestJS, Spring, Express swagger, .NET…). */
export const SPEC_URL_PATHS = ["/openapi.json", "/api/openapi.json", "/swagger.json", "/api/swagger.json", "/v3/api-docs", "/api-docs", "/api-docs.json", "/docs/openapi.json", "/swagger/v1/swagger.json", "/api/docs-json", "/docs-json"];

/** Reads spec text (JSON or YAML) into its document; refuses what isn't OpenAPI or Swagger. */
export function parseSpecText(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > SPEC_MAX_BYTES) throw new SpecError("A spec can be at most 5 MB.", 413);
  let doc: unknown;
  const t = text.trim();
  try {
    doc = t.startsWith("{") ? JSON.parse(t) : parseYaml(t);
  } catch (err) {
    throw new SpecError(`dx couldn't read that spec: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== "object" || (!("openapi" in doc) && !("swagger" in doc))) throw new SpecError("That isn't an OpenAPI or Swagger document (it has no openapi: or swagger: field).");
  return doc as Record<string, unknown>;
}

export interface StoredSpec {
  format: "dx-spec";
  dir: string;
  /** Names it among the project's APIs, and its mocks: letters, digits and dashes, unique in the project. */
  id: string;
  /** Shown instead of its title when you gave one. */
  name: string;
  /** Where it came from: "file:docs/openapi.yaml", "url:/openapi.json", or "pasted". */
  source: string;
  savedAt: string;
  doc: Record<string, unknown>;
  /** dx found it by itself (a spec file in the project, or the running app's usual address). */
  found?: boolean;
  /** For a stack: the service this API is, so calls to it (and mocks of it) are told apart from the others'. */
  service?: string;
  /** Where the API is served when that isn't the spec's own base path, e.g. /payments. */
  mount?: string;
}

/** What's kept for a project: its specs, and whether they were all removed on purpose. */
interface SpecStore {
  format: "dx-specs";
  version: 2;
  dir: string;
  /** Removed on purpose: dx doesn't look for one by itself until you give it one. */
  off?: boolean;
  specs: Omit<StoredSpec, "format" | "dir">[];
}

export const SPECS_MAX = 20;

export function specFile(dir: string): string {
  const r = path.resolve(dir);
  const n = process.platform === "linux" ? r : r.toLowerCase();
  const name = path.basename(dir).replace(/[^\w.-]+/g, "-").slice(0, 40) || "project";
  return dxPath("specs", `${name}-${crypto.createHash("sha1").update(n).digest("hex").slice(0, 8)}.json`);
}

const slug = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** The kept specs of a project. The first versions kept one spec (or a marker that it was removed): read as one. */
function readStore(dir: string): SpecStore {
  const empty: SpecStore = { format: "dx-specs", version: 2, dir: path.resolve(dir), specs: [] };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(specFile(dir), "utf8")) as Record<string, unknown>;
  } catch {
    return empty;
  }
  if (raw.format === "dx-spec-off") return { ...empty, off: true };
  if (raw.format === "dx-spec" && typeof raw.source === "string" && raw.doc && typeof raw.doc === "object") {
    const doc = raw.doc as Record<string, unknown>;
    const title = String(((doc.info ?? {}) as Record<string, unknown>).title ?? "");
    const name = title || sourceName(raw.source);
    return { ...empty, specs: [{ id: slug(name) || "api", name, source: raw.source, savedAt: String(raw.savedAt ?? ""), doc, ...(raw.found ? { found: true } : {}) }] };
  }
  if (raw.format !== "dx-specs" || !Array.isArray(raw.specs)) return empty;
  const specs = (raw.specs as SpecStore["specs"]).filter((x) => x && typeof x.id === "string" && typeof x.source === "string" && x.doc && typeof x.doc === "object");
  return { ...empty, ...(raw.off === true ? { off: true } : {}), specs };
}

function writeStore(dir: string, store: SpecStore): void {
  const file = specFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A name from where a spec came from: "docs/orders.yaml" → "orders". */
function sourceName(source: string): string {
  if (source.startsWith("file:")) return path.basename(source.slice(5)).replace(/\.(json|ya?ml)$/i, "").replace(/[.-]?(openapi|swagger)$/i, "") || path.basename(source.slice(5));
  if (source.startsWith("url:")) return source.slice(4).replace(/^\/+/, "").replace(/\.(json|ya?ml)$/i, "") || "api";
  return "api";
}

export interface SpecOptions {
  found?: boolean;
  /** Replace this one (by id) instead of looking for the same source. */
  id?: string;
  name?: string;
  service?: string;
  mount?: string;
}

const SERVICE = /^[\w.-]{1,60}$/;
const MOUNT = /^\/[\w./{}~-]{0,200}$/;

/**
 * Adds a spec to the project's APIs, or replaces one: the one with `id`, else the one that came
 * from the same file or address. Any number can be kept, each with its own id, so their endpoints
 * and mocks stay apart. Giving one again also ends "removed on purpose".
 */
export function saveSpec(dir: string, source: string, doc: Record<string, unknown>, options: SpecOptions = {}): StoredSpec {
  const store = readStore(dir);
  const title = String(((doc.info ?? {}) as Record<string, unknown>).title ?? "");
  const i = store.specs.findIndex((x) => (options.id ? x.id === options.id : x.source === source && source !== "pasted"));
  if (options.service !== undefined && options.service !== "" && !SERVICE.test(options.service)) throw new SpecError("A service is a name like api or orders.");
  if (options.mount !== undefined && options.mount !== "" && !MOUNT.test(options.mount)) throw new SpecError("Where it's served starts with / (like /payments).");
  if (i < 0 && store.specs.length >= SPECS_MAX) throw new SpecError(`A project can have at most ${SPECS_MAX} APIs.`);
  const name = (options.name ?? "").trim().slice(0, 60) || (i >= 0 ? store.specs[i].name : title || sourceName(source));
  let id = i >= 0 ? store.specs[i].id : slug(name) || "api";
  if (i < 0) for (let n = 2; store.specs.some((x) => x.id === id); n++) id = `${slug(name) || "api"}-${n}`;
  const old = i >= 0 ? store.specs[i] : undefined;
  const entry: Omit<StoredSpec, "format" | "dir"> = {
    id,
    name,
    source,
    savedAt: new Date().toISOString(),
    doc,
    ...(options.found ? { found: true } : {}),
    ...((options.service ?? old?.service) ? { service: options.service === "" ? undefined : (options.service ?? old?.service) } : {}),
    ...((options.mount ?? old?.mount) ? { mount: options.mount === "" ? undefined : (options.mount ?? old?.mount) } : {}),
  };
  if (!entry.service) delete entry.service;
  if (!entry.mount) delete entry.mount;
  if (i >= 0) store.specs[i] = entry;
  else store.specs.push(entry);
  delete store.off;
  writeStore(dir, store);
  return { format: "dx-spec", dir: path.resolve(dir), ...entry };
}

/** Renames an API or changes its service or mount, keeping its id (so its mocks keep theirs). */
export function updateSpec(dir: string, id: string, patch: { name?: unknown; service?: unknown; mount?: unknown }): StoredSpec {
  const store = readStore(dir);
  const x = store.specs.find((s) => s.id === id);
  if (!x) throw new SpecError("That API isn't there any more. Refresh the page.", 404);
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 60) throw new SpecError("A name is up to 60 characters.");
    x.name = patch.name.trim();
  }
  if (patch.service !== undefined) {
    if (typeof patch.service !== "string" || (patch.service !== "" && !SERVICE.test(patch.service))) throw new SpecError("A service is a name like api or orders.");
    if (patch.service) x.service = patch.service;
    else delete x.service;
  }
  if (patch.mount !== undefined) {
    if (typeof patch.mount !== "string" || (patch.mount !== "" && !MOUNT.test(patch.mount))) throw new SpecError("Where it's served starts with / (like /payments).");
    if (patch.mount) x.mount = patch.mount;
    else delete x.mount;
  }
  writeStore(dir, store);
  return { format: "dx-spec", dir: path.resolve(dir), ...x };
}

/** Each kept spec; one from a file in the project is read fresh, so edits to the file show. */
export function listSpecs(dir: string): StoredSpec[] {
  return readStore(dir).specs.map((x) => {
    const stored: StoredSpec = { format: "dx-spec", dir: path.resolve(dir), ...x };
    if (stored.source.startsWith("file:")) {
      const full = path.resolve(dir, stored.source.slice(5));
      if (full.startsWith(path.resolve(dir) + path.sep)) {
        try {
          stored.doc = parseSpecText(fs.readFileSync(full, "utf8"));
        } catch {
          // the file went or broke: the last copy is used
        }
      }
    }
    return stored;
  });
}

/** One kept spec by id. */
export function loadSpec(dir: string, id?: string): StoredSpec | undefined {
  const all = listSpecs(dir);
  return id ? all.find((x) => x.id === id) : all[0];
}

/**
 * Removes one API (by id), or all of them. Removing the last on purpose is remembered (a marker),
 * so dx doesn't pick the same spec file up again by itself; giving one again ends it.
 */
export function forgetSpec(dir: string, id?: string): void {
  const store = readStore(dir);
  if (id && !store.specs.some((x) => x.id === id)) throw new SpecError("That API isn't there any more. Refresh the page.", 404);
  store.specs = id ? store.specs.filter((x) => x.id !== id) : [];
  if (!store.specs.length) store.off = true;
  writeStore(dir, store);
}

/** Where a spec came from, in words: "from docs/openapi.yaml", "from the running app at /openapi.json", "pasted in". */
export function specSource(source: string): string {
  if (source.startsWith("file:")) return `from ${source.slice(5)}`;
  if (source.startsWith("url:")) return `from the running app at ${source.slice(4)}`;
  return "pasted in";
}

/** The specs a state file carries (the ones given by hand, not found by dx) and whether all were removed on purpose. */
export function exportableSpecs(dir: string): { off: boolean; specs: Omit<StoredSpec, "format" | "dir" | "savedAt" | "found">[] } {
  const store = readStore(dir);
  return { off: store.off === true, specs: store.specs.filter((x) => !x.found).map(({ savedAt: _s, found: _f, ...x }) => x) };
}

/** Whether the project's specs were removed on purpose. */
export function specTurnedOff(dir: string): boolean {
  return readStore(dir).off === true;
}

/**
 * The project's API specs, with nothing to set up: the ones it was given, else the most likely
 * spec file in the project (openapi/swagger, three levels down), kept from then on and read fresh
 * each time. Not after you removed them all. The running app's usual addresses are tried by the
 * dashboard; other spec files in the project are offered, not added.
 */
export function projectSpecs(dir: string): StoredSpec[] {
  const kept = listSpecs(dir);
  if (kept.length || specTurnedOff(dir)) return kept;
  for (const rel of findSpecFiles(dir)) {
    try {
      saveSpec(dir, `file:${rel}`, readProjectSpec(dir, rel), { found: true });
      return listSpecs(dir);
    } catch {
      // not a spec dx can read: the next one
    }
  }
  return [];
}

/** The first of the project's specs, for callers that want one. */
export function projectSpec(dir: string): StoredSpec | undefined {
  return projectSpecs(dir)[0];
}

/** Reads a spec file inside the project (and only there). */
export function readProjectSpec(dir: string, rel: string): Record<string, unknown> {
  const full = path.resolve(dir, rel);
  const root = path.resolve(dir);
  if (!full.startsWith(root + path.sep) || /(^|[\\/])node_modules([\\/]|$)/.test(rel)) throw new SpecError("The spec must be a file inside the project.");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(full);
  } catch {
    throw new SpecError(`There's no ${rel} in the project.`, 404);
  }
  if (!st.isFile()) throw new SpecError("The spec must be a plain file.");
  return parseSpecText(fs.readFileSync(full, "utf8"));
}

// ------------------------------------------------------------------ reading

/** The spec as one list of endpoints, whether it's OpenAPI 3 or Swagger 2. `$ref`s inside it are followed. */
export function readSpec(doc: Record<string, unknown>, options: { mount?: string; api?: { id: string; name: string; service?: string } } = {}): ApiSpec {
  const info = (doc.info ?? {}) as Record<string, unknown>;
  const swagger2 = typeof doc.swagger === "string";
  let basePath = "";
  if (swagger2) basePath = typeof doc.basePath === "string" ? doc.basePath : "";
  else {
    const server = Array.isArray(doc.servers) ? (doc.servers[0] as Record<string, unknown> | undefined) : undefined;
    const url = typeof server?.url === "string" ? server.url : "";
    // Only its path matters here: the mock answers on dx's own address.
    basePath = url.replace(/^[a-z]+:\/\/[^/]*/i, "").replace(/\{[^}]+\}/g, "");
  }
  // Where the API is served, when that isn't what the spec says.
  if (options.mount) basePath = options.mount;
  basePath = basePath.replace(/\/+$/, "");
  const resolve = makeResolver(doc);
  const endpoints: SpecEndpoint[] = [];
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const [p, itemRaw] of Object.entries(paths)) {
    const item = resolve(itemRaw) as Record<string, unknown>;
    if (!item || typeof item !== "object") continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const m of METHODS) {
      const op = item[m] as Record<string, unknown> | undefined;
      if (!op || typeof op !== "object") continue;
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])].map((x) => resolve(x) as Record<string, unknown>).filter(Boolean);
      const ep: SpecEndpoint = {
        method: m.toUpperCase(),
        path: `${basePath}${p.startsWith("/") ? p : `/${p}`}` || "/",
        operationId: typeof op.operationId === "string" ? op.operationId : undefined,
        summary: typeof op.summary === "string" ? op.summary : undefined,
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
        parameters: params
          .filter((x) => x.in !== "body")
          .map((x) => ({ name: String(x.name), in: String(x.in), required: x.required === true, schema: (resolve(x.schema) ?? (x.type ? { type: x.type, format: x.format, enum: x.enum } : undefined)) as Schema | undefined })),
        responses: [],
      };
      // The request body: OpenAPI 3's requestBody, or Swagger 2's "in: body" parameter.
      const body2 = params.find((x) => x.in === "body");
      if (body2) ep.requestBody = { contentType: "application/json", schema: resolve(body2.schema) as Schema, required: body2.required === true };
      const rb = resolve(op.requestBody) as Record<string, unknown> | undefined;
      if (rb?.content && typeof rb.content === "object") {
        const [ct, media] = pickContent(rb.content as Record<string, Record<string, unknown>>);
        if (ct) ep.requestBody = { contentType: ct, schema: resolve(media?.schema) as Schema, required: rb.required === true };
      }
      for (const [code, rRaw] of Object.entries((op.responses ?? {}) as Record<string, unknown>)) {
        const r = resolve(rRaw) as Record<string, unknown> | undefined;
        if (!r) continue;
        const status: number | "default" = code === "default" ? "default" : /^\d{3}$/.test(code) ? Number(code) : /^[1-5]XX$/i.test(code) ? Number(code[0]) * 100 : NaN;
        if (Number.isNaN(status)) continue;
        const res: SpecResponse = { status, description: typeof r.description === "string" ? r.description : undefined, examples: [] };
        if (swagger2) {
          if (r.schema) ((res.contentType = "application/json"), (res.schema = resolve(r.schema) as Schema));
          const ex = (r.examples ?? {}) as Record<string, unknown>;
          for (const [ct, v] of Object.entries(ex)) if (/json/i.test(ct)) res.examples.push({ name: "example", value: v });
        } else if (r.content && typeof r.content === "object") {
          const [ct, media] = pickContent(r.content as Record<string, Record<string, unknown>>);
          if (ct) {
            res.contentType = ct;
            res.schema = resolve(media?.schema) as Schema;
            if (media?.example !== undefined) res.examples.push({ name: "example", value: media.example });
            for (const [name, exRaw] of Object.entries((media?.examples ?? {}) as Record<string, unknown>)) {
              const ex = resolve(exRaw) as Record<string, unknown> | undefined;
              if (ex && "value" in ex) res.examples.push({ name, value: ex.value });
            }
          }
        }
        ep.responses.push(res);
      }
      if (options.api) {
        ep.api = options.api.id;
        ep.apiName = options.api.name;
      }
      endpoints.push(ep);
    }
  }
  return {
    title: typeof info.title === "string" ? info.title : "API",
    version: typeof info.version === "string" ? info.version : String(info.version ?? ""),
    kind: swagger2 ? `swagger ${doc.swagger}` : `openapi ${doc.openapi}`,
    basePath,
    endpoints,
    ...(options.api ? { api: options.api.id, apiName: options.api.name, ...(options.api.service ? { service: options.api.service } : {}) } : {}),
  };
}

/** A kept spec read into endpoints that know which API they're from, where it's served and (in a stack) which service. */
export function readStored(stored: StoredSpec): ApiSpec {
  return readSpec(stored.doc, { mount: stored.mount, api: { id: stored.id, name: stored.name, service: stored.service } });
}

/** Every one of the project's APIs, read. A spec that can't be read is left out, not thrown. */
export function projectApis(dir: string): { stored: StoredSpec; spec: ApiSpec }[] {
  return projectSpecs(dir).flatMap((stored) => {
    try {
      return [{ stored, spec: readStored(stored) }];
    } catch {
      return [];
    }
  });
}

function pickContent(content: Record<string, Record<string, unknown>>): [string | undefined, Record<string, unknown> | undefined] {
  const types = Object.keys(content);
  const ct = types.find((t) => /json/i.test(t)) ?? types.find((t) => /text|xml/i.test(t)) ?? types[0];
  return [ct, ct ? content[ct] : undefined];
}

/**
 * Follows `#/...` references inside the document, lazily and with a depth limit, so a schema
 * that refers to itself (a tree of categories) doesn't loop.
 */
function makeResolver(doc: Record<string, unknown>) {
  const lookup = (ref: string): unknown => {
    if (!ref.startsWith("#/")) return undefined;
    let cur: unknown = doc;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!cur || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur;
  };
  const resolve = (value: unknown, depth = 0): unknown => {
    if (!value || typeof value !== "object" || depth > 20) return value;
    const ref = (value as Record<string, unknown>).$ref;
    if (typeof ref === "string") return resolve(lookup(ref), depth + 1);
    return value;
  };
  return (value: unknown) => deref(value, resolve, 0);
}

/** A copy with every $ref replaced, at most 8 levels deep (deeper ones stay as { $ref }). */
function deref(value: unknown, resolve: (v: unknown, d?: number) => unknown, depth: number): unknown {
  const v = resolve(value);
  if (!v || typeof v !== "object" || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => deref(x, resolve, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = k === "example" || k === "examples" || k === "default" || k === "enum" ? x : deref(x, resolve, depth + 1);
  return out;
}

// ------------------------------------------------------------------ example data

/**
 * A value that fits a schema: its own example, default or first enum value when it has one,
 * otherwise made up from its type, format and the property's name ("email" gets an address,
 * "createdAt" a date), the same each time for the same place in the spec.
 */
export function exampleFor(schema: Schema | undefined, name = "", seed = "", depth = 0): unknown {
  if (!schema || depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const pick = (list: unknown) => (Array.isArray(list) && list.length ? (list[0] as Schema) : undefined);
  if (Array.isArray(schema.allOf)) {
    const merged: Schema = { type: "object", properties: {}, required: [] };
    for (const part of schema.allOf as Schema[]) {
      Object.assign(merged.properties as object, (part?.properties as object) ?? {});
      if (part?.type && part.type !== "object") merged.type = part.type;
    }
    return exampleFor(merged, name, seed, depth + 1);
  }
  if (schema.oneOf || schema.anyOf) return exampleFor(pick(schema.oneOf) ?? pick(schema.anyOf), name, seed, depth + 1);
  let type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== "null") : (schema.type as string | undefined);
  if (!type) type = schema.properties ? "object" : schema.items ? "array" : "string";
  const n = rand(`${seed}/${name}`);
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) out[k] = exampleFor(s, k, `${seed}/${k}`, depth + 1);
      if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === "object") out.key = exampleFor(schema.additionalProperties as Schema, "value", seed, depth + 1);
      return out;
    }
    case "array": {
      const count = Math.max(Number(schema.minItems ?? 0), Math.min(Number(schema.maxItems ?? 3), 3));
      return Array.from({ length: count || 3 }, (_, i) => exampleFor(schema.items as Schema, singular(name), `${seed}[${i}]`, depth + 1));
    }
    case "integer":
    case "number": {
      const min = Number(schema.minimum ?? (/(price|amount|total|cost)/i.test(name) ? 5 : /(age)/i.test(name) ? 18 : 1));
      const max = Number(schema.maximum ?? (/(price|amount|total|cost)/i.test(name) ? 500 : /(age)/i.test(name) ? 80 : /(count|quantity|qty)/i.test(name) ? 20 : 1000));
      const v = min + n * (max - min);
      return type === "integer" ? Math.round(v) : Math.round(v * 100) / 100;
    }
    case "boolean":
      return n > 0.4;
    case "null":
      return null;
    default:
      return stringFor(schema, name, n, seed);
  }
}

const FIRST = ["Ada", "Grace", "Alan", "Linus", "Margaret", "Ken", "Barbara", "Tim", "Radia", "Dennis"];
const LAST = ["Lovelace", "Hopper", "Turing", "Torvalds", "Hamilton", "Thompson", "Liskov", "Berners-Lee", "Perlman", "Ritchie"];
const CITIES = ["Lisbon", "Oslo", "Kyoto", "Austin", "Nairobi", "Toronto", "Melbourne", "Cairo"];
const WORDS = ["blue", "quick", "silent", "bright", "small", "modern", "classic", "fresh"];
const NOUNS = ["notebook", "lamp", "backpack", "mug", "chair", "headphones", "bottle", "jacket"];
const COMPANIES = ["Acme Corp", "Globex", "Initech", "Umbrella Labs", "Hooli", "Soylent Co", "Vandelay Industries", "Wonka Works"];

function stringFor(schema: Schema, name: string, n: number, seed: string): string {
  const i = Math.floor(n * 10);
  const f = String(schema.format ?? "");
  const lower = name.toLowerCase();
  if (f === "date-time" || /(at|date|time)$/i.test(name)) return new Date(Date.UTC(2026, 0, 1) + Math.floor(n * 300) * 86_400_000).toISOString();
  if (f === "date") return new Date(Date.UTC(2026, 0, 1) + Math.floor(n * 300) * 86_400_000).toISOString().slice(0, 10);
  if (f === "uuid" || /^(uuid|guid)$/.test(lower)) return uuidFrom(seed);
  if (f === "email" || /email/.test(lower)) return `${FIRST[i].toLowerCase()}.${LAST[i % LAST.length].toLowerCase().replace(/[^a-z]/g, "")}@example.com`;
  if (f === "uri" || f === "url" || /(url|link|href|website)$/.test(lower)) return `https://example.com/${lower.replace(/url|link|href/, "") || "page"}/${i + 1}`;
  if (f === "ipv4") return `192.0.2.${10 + i}`;
  if (f === "hostname") return `host-${i + 1}.example.com`;
  if (/(image|avatar|photo|picture)/.test(lower)) return `https://picsum.photos/seed/${i + 1}/300/200`;
  if (/^id$|_id$|Id$/.test(name) || lower === "id") return `${lower.replace(/_?id$/, "") || "id"}_${(Math.floor(n * 9000) + 1000).toString(36)}`;
  if (/first.?name/.test(lower)) return FIRST[i];
  if (/last.?name|surname/.test(lower)) return LAST[i];
  if (/(user.?name|login|handle)/.test(lower)) return `${FIRST[i].toLowerCase()}${i}`;
  if (/name$/.test(lower)) {
    // What the name is of comes from where it sits: GET /api/products → products, a user's name → a person.
    const where = `${seed} ${lower}`.toLowerCase();
    if (/(product|item|sku|catalog|article|good|menu|dish)/.test(where)) return `${cap(WORDS[i % WORDS.length])} ${NOUNS[i % NOUNS.length]}`;
    if (/(compan|organi[sz]ation|\borg|team|shop|store|brand|vendor|supplier|tenant)/.test(where)) return COMPANIES[i % COMPANIES.length];
    if (/(project|repo|app|service|board|channel|room|group|categor|tag|label|plan|tier)/.test(where)) return `${cap(WORDS[i % WORDS.length])} ${["project", "board", "channel", "group", "plan"][i % 5]}`;
    return `${FIRST[i]} ${LAST[i]}`;
  }
  if (/title|subject/.test(lower)) return `${cap(WORDS[i % WORDS.length])} ${NOUNS[(i + 3) % NOUNS.length]}`;
  if (/city/.test(lower)) return CITIES[i % CITIES.length];
  if (/country/.test(lower)) return ["PT", "NO", "JP", "US", "KE", "CA"][i % 6];
  if (/phone/.test(lower)) return `+1 555 01${String(10 + i * 7).slice(0, 2)}`;
  if (/(status|state)$/.test(lower)) return ["active", "pending", "done"][i % 3];
  if (/(description|bio|summary|body|text|content|comment|message|note)/.test(lower)) return `A ${WORDS[i % WORDS.length]} ${NOUNS[i % NOUNS.length]} for everyday use.`;
  if (/currency/.test(lower)) return "USD";
  if (/(slug)/.test(lower)) return `${WORDS[i % WORDS.length]}-${NOUNS[i % NOUNS.length]}`;
  if (/(color|colour)/.test(lower)) return ["#0e7490", "#b45309", "#6d28d9"][i % 3];
  const s = `${lower || "text"} ${i + 1}`;
  const max = Number(schema.maxLength ?? 0);
  return max > 0 ? s.slice(0, max) : s;
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

function singular(name: string): string {
  return name.replace(/ies$/, "y").replace(/s$/, "");
}

function rand(seed: string): number {
  return crypto.createHash("sha1").update(seed).digest().readUInt32BE(0) / 0xffffffff;
}

function uuidFrom(seed: string): string {
  const h = crypto.createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ------------------------------------------------------------------ mocks from the spec

/** Mock endpoints from the spec: each response's examples, or one made up from its schema. */
export function mocksFromSpec(spec: ApiSpec): MockEndpoint[] {
  const now = new Date().toISOString();
  const out: MockEndpoint[] = [];
  for (const ep of spec.endpoints) {
    for (const r of ep.responses) {
      const status = r.status === "default" ? 500 : r.status;
      if (status === 500 && r.status === "default" && ep.responses.some((x) => x.status !== "default")) continue;
      const json = !r.contentType || /json/i.test(r.contentType);
      const samples: Array<{ name: string; value: unknown; source: MockSource }> = r.examples.length
        ? r.examples.map((x) => ({ ...x, source: "spec" as MockSource }))
        : // An error answer with no example and no schema gets a plain message; a success always gets data.
          status >= 400 && !r.schema
          ? [{ name: "", value: { error: r.description ?? `Error ${status}` }, source: "generated" as MockSource }]
          : status === 204 || (!r.schema && status < 300 && r.contentType === undefined)
            ? [{ name: "", value: undefined, source: "generated" as MockSource }]
            : [{ name: "", value: exampleFor(r.schema, "", `${ep.method} ${ep.path} ${status}`), source: "generated" as MockSource }];
      for (const s of samples) {
        const body = s.value === undefined ? "" : json ? JSON.stringify(s.value, null, 2) : String(s.value);
        const contentType = r.contentType ?? (body ? "application/json" : "text/plain");
        out.push({
          // The API is part of the id: two APIs with the same method, path and status keep both.
          id: `spec${crypto.createHash("sha1").update(`${spec.api ?? ""} ${ep.method} ${ep.path} ${status} ${s.name}`).digest("hex").slice(0, 12)}`,
          ...(spec.api ? { api: spec.api, apiName: spec.apiName } : {}),
          ...(spec.service ? { service: spec.service } : {}),
          method: ep.method,
          path: foldTemplate(ep.path),
          pattern: ep.path.includes("{") ? ep.path : undefined,
          status,
          delayMs: 0,
          contentType,
          body,
          enabled: true,
          source: s.source,
          operation: ep.operationId ?? ep.summary,
          example: s.name || undefined,
          recorded: { status, contentType, body, at: now, eventId: 0 },
          updatedAt: now,
        });
      }
    }
  }
  return out;
}

/** /users/{id} → /users/:id, the way recorded paths are shown. */
export function foldTemplate(p: string): string {
  return p.replace(/\{[^}]+\}/g, ":id");
}

// ------------------------------------------------------------------ the API map

export interface MapEntry {
  method: string;
  path: string;
  /** Which API it's in (id and name). */
  api?: string;
  apiName?: string;
  summary?: string;
  operationId?: string;
  tags: string[];
  calls: number;
  lastStatus?: number;
  lastAt?: string;
  statuses: number[];
  /** Answers that don't fit the spec: an undeclared status, a body that doesn't match its schema. */
  issues: string[];
}

export interface ApiMap {
  /** The API's id and name, when it's one of a project's (not a spec read on its own). */
  api?: string;
  apiName?: string;
  service?: string;
  title: string;
  version: string;
  kind: string;
  endpoints: MapEntry[];
  /** Calls the app made that the spec doesn't have: method and folded path, with a count. */
  undocumented: Array<{ method: string; path: string; calls: number; lastStatus?: number }>;
}

/** The spec next to what the app really called (its activity history). */
export function mapApi(spec: ApiSpec, events: ActivityEvent[]): ApiMap {
  const calls = events.filter((e) => e.type === "request" && e.url?.startsWith("/") && !e.url.startsWith("/__dx/") && !e.mocked);
  const entries: MapEntry[] = spec.endpoints.map((ep) => ({ method: ep.method, path: ep.path, ...(ep.api ? { api: ep.api, apiName: ep.apiName } : {}), summary: ep.summary, operationId: ep.operationId, tags: ep.tags, calls: 0, statuses: [], issues: [] }));
  const undocumented = new Map<string, { method: string; path: string; calls: number; lastStatus?: number }>();
  const order = [...calls].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const e of order) {
    const method = (e.method ?? "GET").toUpperCase();
    // An exact path beats a template: /users/me over /users/{id}.
    const idx = bestEndpoint(spec.endpoints, method, e.url!);
    if (idx < 0) {
      // Pages, scripts and styles aren't API calls the spec would have.
      if (method === "GET" && !/json|xml/i.test(e.responseHeaders?.["content-type"] ?? "") && !/\/api\/|graphql/.test(e.url!)) continue;
      const key = `${method} ${foldPath(e.url!)}`;
      const u = undocumented.get(key) ?? { method, path: foldPath(e.url!), calls: 0 };
      u.calls++;
      u.lastStatus = e.status;
      undocumented.set(key, u);
      continue;
    }
    const m = entries[idx];
    m.calls++;
    m.lastAt = e.at;
    if (e.status !== undefined) {
      m.lastStatus = e.status;
      if (!m.statuses.includes(e.status)) m.statuses.push(e.status);
      for (const issue of checkAnswer(spec.endpoints[idx], e)) if (!m.issues.includes(issue) && m.issues.length < 5) m.issues.push(issue);
    }
  }
  return { ...(spec.api ? { api: spec.api, apiName: spec.apiName, ...(spec.service ? { service: spec.service } : {}) } : {}), title: spec.title, version: spec.version, kind: spec.kind, endpoints: entries, undocumented: [...undocumented.values()].sort((a, b) => b.calls - a.calls) };
}

/** Several APIs next to what the app called: each call goes to the API that has it, and the same endpoint in two APIs is named. */
export interface ApisMap {
  apis: ApiMap[];
  /** Calls no API has: method and folded path, with a count. */
  undocumented: ApiMap["undocumented"];
  /** The same method and path in more than one API: which of them a call or mock belongs to is a guess until each is told apart. */
  overlaps: Array<{ method: string; path: string; apis: string[] }>;
}

export function mapApis(specs: ApiSpec[], events: ActivityEvent[]): ApisMap {
  const calls = events.filter((e) => e.type === "request" && e.url?.startsWith("/") && !e.url.startsWith("/__dx/") && !e.mocked);
  const entries = specs.map((spec) => spec.endpoints.map((ep) => ({ method: ep.method, path: ep.path, ...(ep.api ? { api: ep.api, apiName: ep.apiName } : {}), summary: ep.summary, operationId: ep.operationId, tags: ep.tags, calls: 0, statuses: [] as number[], issues: [] as string[] }) as MapEntry));
  const undocumented = new Map<string, { method: string; path: string; calls: number; lastStatus?: number }>();
  for (const e of [...calls].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const method = (e.method ?? "GET").toUpperCase();
    // The API with the best endpoint for it; a stack's call only goes to the API that is that service.
    let best: { s: number; i: number; score: number } | undefined;
    specs.forEach((spec, s) => {
      if (spec.service && e.service && spec.service !== e.service) return;
      const i = bestEndpoint(spec.endpoints, method, e.url!);
      if (i < 0) return;
      // A match through the call's own service beats one that only fits by path.
      const score = spec.endpoints[i].path.split("/").filter((x) => !x.includes("{")).length * 2 + (spec.service && spec.service === e.service ? 1 : 0);
      if (!best || score > best.score) best = { s, i, score };
    });
    if (!best) {
      if (method === "GET" && !/json|xml/i.test(e.responseHeaders?.["content-type"] ?? "") && !/\/api\/|graphql/.test(e.url!)) continue;
      const key = `${method} ${foldPath(e.url!)}`;
      const u = undocumented.get(key) ?? { method, path: foldPath(e.url!), calls: 0 };
      u.calls++;
      u.lastStatus = e.status;
      undocumented.set(key, u);
      continue;
    }
    const m = entries[best.s][best.i];
    m.calls++;
    m.lastAt = e.at;
    if (e.status !== undefined) {
      m.lastStatus = e.status;
      if (!m.statuses.includes(e.status)) m.statuses.push(e.status);
      for (const issue of checkAnswer(specs[best.s].endpoints[best.i], e)) if (!m.issues.includes(issue) && m.issues.length < 5) m.issues.push(issue);
    }
  }
  const seen = new Map<string, Set<string>>();
  specs.forEach((spec) => {
    for (const ep of spec.endpoints) {
      // Two APIs that are different services don't compete for a call: only ones of the same service (or none) overlap.
      const key = `${spec.service ?? ""} ${ep.method} ${foldTemplate(ep.path)}`;
      const set = seen.get(key) ?? seen.set(key, new Set()).get(key)!;
      set.add(spec.apiName ?? spec.title);
    }
  });
  const overlaps = [...seen.entries()].flatMap(([key, set]) => {
    const apis = [...set];
    if (apis.length < 2) return [];
    const [method, ...rest] = key.split(" ")[1].split(" ");
    return [{ method, path: rest.join(" "), apis }];
  });
  return {
    apis: specs.map((spec, i) => ({ ...(spec.api ? { api: spec.api, apiName: spec.apiName, ...(spec.service ? { service: spec.service } : {}) } : {}), title: spec.title, version: spec.version, kind: spec.kind, endpoints: entries[i], undocumented: [] })),
    undocumented: [...undocumented.values()].sort((a, b) => b.calls - a.calls),
    overlaps,
  };
}

function bestEndpoint(endpoints: SpecEndpoint[], method: string, url: string): number {
  let best = -1;
  let bestScore = -1;
  endpoints.forEach((ep, i) => {
    if (ep.method !== method || !templateMatches(ep.path, url)) return;
    const score = ep.path.split("/").filter((s) => !s.includes("{")).length;
    if (score > bestScore) ((best = i), (bestScore = score));
  });
  return best;
}

/** What doesn't fit the spec in one recorded answer. */
export function checkAnswer(ep: SpecEndpoint, e: ActivityEvent): string[] {
  const issues: string[] = [];
  const declared = ep.responses.find((r) => r.status === e.status) ?? ep.responses.find((r) => typeof r.status === "number" && r.status % 100 === 0 && Math.floor(e.status! / 100) * 100 === r.status) ?? ep.responses.find((r) => r.status === "default");
  if (!declared) {
    issues.push(`answered ${e.status}, which the spec doesn't list`);
    return issues;
  }
  if (!declared.schema || !e.responseBody || e.truncated || !/json/i.test(e.responseHeaders?.["content-type"] ?? "")) return issues;
  let body: unknown;
  try {
    body = JSON.parse(e.responseBody);
  } catch {
    return ["the answer isn't valid JSON"];
  }
  for (const p of validate(declared.schema, body, "")) if (issues.length < 3) issues.push(`${e.status}: ${p}`);
  return issues;
}

/** Where a value doesn't fit a schema: types, required properties, enums. Not every JSON Schema rule. */
export function validate(schema: Schema | undefined, value: unknown, at: string, depth = 0): string[] {
  if (!schema || depth > 8) return [];
  if (Array.isArray(schema.allOf)) return (schema.allOf as Schema[]).flatMap((s) => validate(s, value, at, depth + 1));
  if (schema.oneOf || schema.anyOf) {
    const list = (schema.oneOf ?? schema.anyOf) as Schema[];
    return list.some((s) => validate(s, value, at, depth + 1).length === 0) ? [] : [`${at || "the body"} matches none of the allowed shapes`];
  }
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : schema.type ? [schema.type as string] : [];
  if (schema.nullable === true) types.push("null");
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
  const fits = !types.length || types.includes(actual) || (actual === "integer" && types.includes("number"));
  if (!fits) {
    const word = (t: string) => ({ integer: "a whole number", number: "a number", string: "text", boolean: "true or false", array: "a list", object: "an object", null: "null" })[t] ?? t;
    const said = actual === "integer" ? "a number" : word(actual);
    return [`${at || "the body"} is ${said}, the spec says ${[...new Set(types.map(word))].join(" or ")}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((x) => JSON.stringify(x) === JSON.stringify(value))) return [`${at || "the body"} is ${JSON.stringify(value)}, not one of ${schema.enum.map((x) => JSON.stringify(x)).join(", ")}`];
  const out: string[] = [];
  if (actual === "object" && value) {
    for (const r of (Array.isArray(schema.required) ? schema.required : []) as string[]) {
      if (!(r in (value as object))) out.push(`${at ? `${at}.` : ""}${r} is missing`);
    }
    for (const [k, s] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) {
      if (k in (value as object)) out.push(...validate(s, (value as Record<string, unknown>)[k], at ? `${at}.${k}` : k, depth + 1));
    }
  }
  if (actual === "array" && schema.items) (value as unknown[]).slice(0, 5).forEach((v, i) => out.push(...validate(schema.items as Schema, v, `${at}[${i}]`, depth + 1)));
  return out;
}
