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
}

export interface ApiSpec {
  title: string;
  version: string;
  /** "openapi 3.1.0" or "swagger 2.0". */
  kind: string;
  basePath: string;
  endpoints: SpecEndpoint[];
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
  /** Where it came from: "file:docs/openapi.yaml", "url:/openapi.json", or "pasted". */
  source: string;
  savedAt: string;
  doc: Record<string, unknown>;
  /** dx found it by itself (a spec file in the project, or the running app's usual address). */
  found?: boolean;
}

export function specFile(dir: string): string {
  const r = path.resolve(dir);
  const n = process.platform === "linux" ? r : r.toLowerCase();
  const name = path.basename(dir).replace(/[^\w.-]+/g, "-").slice(0, 40) || "project";
  return dxPath("specs", `${name}-${crypto.createHash("sha1").update(n).digest("hex").slice(0, 8)}.json`);
}

/** Keeps the spec dx uses for a project (readable by this user only). */
export function saveSpec(dir: string, source: string, doc: Record<string, unknown>, options: { found?: boolean } = {}): StoredSpec {
  const stored: StoredSpec = { format: "dx-spec", dir: path.resolve(dir), source, savedAt: new Date().toISOString(), doc, ...(options.found ? { found: true } : {}) };
  const file = specFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return stored;
}

/** The kept spec; a spec file in the project is read fresh each time, so edits to it show. */
export function loadSpec(dir: string): StoredSpec | undefined {
  let stored: StoredSpec;
  try {
    stored = JSON.parse(fs.readFileSync(specFile(dir), "utf8")) as StoredSpec;
    if (stored.format !== "dx-spec") return undefined;
  } catch {
    return undefined;
  }
  if (stored.source.startsWith("file:")) {
    const rel = stored.source.slice(5);
    const full = path.resolve(dir, rel);
    if (full.startsWith(path.resolve(dir) + path.sep)) {
      try {
        stored.doc = parseSpecText(fs.readFileSync(full, "utf8"));
      } catch {
        // the file went or broke: the last copy is used
      }
    }
  }
  return stored;
}

/**
 * Removes the project's spec. Removing it on purpose is remembered (a marker in its place), so dx
 * doesn't pick the same spec file up again by itself; giving it one again replaces the marker.
 */
export function forgetSpec(dir: string): void {
  const file = specFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ format: "dx-spec-off", dir: path.resolve(dir) }), { mode: 0o600 });
}

/** Where a spec came from, in words: "from docs/openapi.yaml", "from the running app at /openapi.json", "pasted in". */
export function specSource(source: string): string {
  if (source.startsWith("file:")) return `from ${source.slice(5)}`;
  if (source.startsWith("url:")) return `from the running app at ${source.slice(4)}`;
  return "pasted in";
}

/** Whether the project's spec was removed on purpose. */
export function specTurnedOff(dir: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(specFile(dir), "utf8")) as { format?: string }).format === "dx-spec-off";
  } catch {
    return false;
  }
}

/**
 * The project's API spec, with nothing to set up: the one it was given, else the most likely spec
 * file in the project (openapi/swagger, three levels down), kept from then on and read fresh each
 * time. Not after you removed it. The running app's usual addresses are tried by the dashboard.
 */
export function projectSpec(dir: string): StoredSpec | undefined {
  const kept = loadSpec(dir);
  if (kept || specTurnedOff(dir)) return kept;
  for (const rel of findSpecFiles(dir)) {
    try {
      return saveSpec(dir, `file:${rel}`, readProjectSpec(dir, rel), { found: true });
    } catch {
      // not a spec dx can read: the next one
    }
  }
  return undefined;
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
export function readSpec(doc: Record<string, unknown>): ApiSpec {
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
      endpoints.push(ep);
    }
  }
  return {
    title: typeof info.title === "string" ? info.title : "API",
    version: typeof info.version === "string" ? info.version : String(info.version ?? ""),
    kind: swagger2 ? `swagger ${doc.swagger}` : `openapi ${doc.openapi}`,
    basePath,
    endpoints,
  };
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
          id: `spec${crypto.createHash("sha1").update(`${ep.method} ${ep.path} ${status} ${s.name}`).digest("hex").slice(0, 12)}`,
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
  const entries: MapEntry[] = spec.endpoints.map((ep) => ({ method: ep.method, path: ep.path, summary: ep.summary, operationId: ep.operationId, tags: ep.tags, calls: 0, statuses: [], issues: [] }));
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
  return { title: spec.title, version: spec.version, kind: spec.kind, endpoints: entries, undocumented: [...undocumented.values()].sort((a, b) => b.calls - a.calls) };
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
