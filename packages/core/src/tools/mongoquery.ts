/**
 * Reading queries for MongoDB, in the shell's own words, but only these: `show collections`, `db.stats()`,
 * `db.<collection>.find(filter, projection).sort({...}).skip(n).limit(n)`, `.countDocuments(filter)`,
 * `.estimatedDocumentCount()`, `.distinct("field", filter)` and `.aggregate([...])` without `$out` or `$merge`.
 *
 * The shell runs JavaScript, so a query is never passed on as written: it is read here into its parts, every
 * argument must be plain JSON (keys may go unquoted, as in the shell), the pieces that run code or write are
 * refused (`$where`, `$function`, `$accumulator`, `$out`, `$merge`), and the script the container gets is built
 * from the checked parts, re-written as JSON. What the person typed never reaches the shell.
 */

export type MongoQuery =
  | { op: "collections" }
  | { op: "stats" }
  | { op: "find"; collection: string; filter: unknown; projection?: unknown; sort?: unknown; skip?: number; limit?: number }
  | { op: "count"; collection: string; filter: unknown }
  | { op: "estimate"; collection: string }
  | { op: "distinct"; collection: string; field: string; filter: unknown }
  | { op: "aggregate"; collection: string; pipeline: unknown[] };

export const MONGO_MAX_DOCS = 200;
const COLLECTION = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/;
const REFUSED = ["$where", "$function", "$accumulator", "$out", "$merge", "$currentOp", "$listLocalSessions"];

/** Text with the shell's unquoted keys and single quotes turned into JSON, outside strings only. */
function toJson(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let body = "";
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\" && j + 1 < text.length) {
          body += text[j] + text[j + 1];
          j += 2;
        } else {
          body += text[j];
          j++;
        }
      }
      // A single-quoted string becomes a double-quoted one; its inner quotes are escaped.
      out += ch === "'" ? `"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : `"${body}"`;
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[\w$.]/.test(text[j])) j++;
      const word = text.slice(i, j);
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k++;
      // A key before a colon gets its quotes; true, false and null stay words.
      out += text[k] === ":" && !["true", "false", "null"].includes(word) ? `"${word}"` : word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The arguments between the parentheses, split on the commas outside brackets and strings. */
function splitArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (quote || depth !== 0) throw new Error("The brackets or quotes in that query don't match.");
  if (inner.slice(start).trim()) args.push(inner.slice(start));
  return args.map((a) => a.trim());
}

function value(text: string, what: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toJson(text));
  } catch {
    throw new Error(`${what} has to be plain JSON, like {"status": "paid"}: no functions, dates or ObjectId(...) (use {"$oid": "…"} and {"$date": "…"}).`);
  }
  const flat = JSON.stringify(parsed);
  const refused = REFUSED.find((k) => flat.includes(`"${k}"`));
  if (refused) throw new Error(`${refused} runs code or writes, so it isn't allowed here.`);
  return parsed;
}

function whole(text: string, what: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new Error(`${what} takes a whole number.`);
  return n;
}

/** The query as parts, or why it can't run. */
export function parseMongoQuery(input: string): MongoQuery {
  const text = input.trim().replace(/;\s*$/, "").trim();
  if (!text || /^show\s+(collections|tables)$/i.test(text)) return { op: "collections" };
  if (/^db\.stats\(\s*\)$/.test(text)) return { op: "stats" };
  const head = /^db\.(?:getCollection\(\s*["']([^"']+)["']\s*\)|([A-Za-z0-9_][A-Za-z0-9_.-]*?))\.(find|findOne|countDocuments|estimatedDocumentCount|distinct|aggregate)\(/.exec(text);
  if (!head) throw new Error("Only reading queries run here: show collections, db.stats(), db.<collection>.find(…), .findOne(…), .countDocuments(…), .distinct(…), .aggregate([…]).");
  const collection = head[1] ?? head[2];
  if (!COLLECTION.test(collection) || collection.startsWith("system.")) throw new Error(`"${collection}" isn't a collection dx reads.`);
  // The call's own arguments, then any .sort / .skip / .limit chained after it.
  let depth = 1;
  let quote = "";
  let i = head[0].length;
  for (; i < text.length && depth > 0; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  if (depth !== 0) throw new Error("The brackets in that query don't match.");
  const method = head[3];
  const args = splitArgs(text.slice(head[0].length, i - 1));
  const chain = text.slice(i).trim();

  if (method === "estimatedDocumentCount") {
    if (chain || args.length) throw new Error("estimatedDocumentCount() takes nothing.");
    return { op: "estimate", collection };
  }
  if (method === "countDocuments") {
    if (chain) throw new Error("countDocuments(…) can't be chained.");
    return { op: "count", collection, filter: args[0] ? value(args[0], "The filter") : {} };
  }
  if (method === "distinct") {
    if (chain) throw new Error("distinct(…) can't be chained.");
    const field = args[0] ? value(args[0], "The field") : undefined;
    if (typeof field !== "string" || !field || field.length > 200) throw new Error('distinct takes a field name in quotes, like distinct("status").');
    return { op: "distinct", collection, field, filter: args[1] ? value(args[1], "The filter") : {} };
  }
  if (method === "aggregate") {
    if (chain) throw new Error("aggregate([…]) can't be chained: put limit and sort in the pipeline.");
    const pipeline = args[0] ? value(args[0], "The pipeline") : undefined;
    if (!Array.isArray(pipeline) || pipeline.length > 30) throw new Error("aggregate takes a list of stages, like aggregate([{\"$match\": {…}}]).");
    return { op: "aggregate", collection, pipeline };
  }
  const q: Extract<MongoQuery, { op: "find" }> = { op: "find", collection, filter: args[0] ? value(args[0], "The filter") : {} };
  if (args[1]) q.projection = value(args[1], "The projection");
  if (method === "findOne") q.limit = 1;
  const re = /^\.(sort|skip|limit)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/;
  let rest = chain;
  while (rest) {
    const m = re.exec(rest);
    if (!m) throw new Error("After find(…) only .sort({…}), .skip(n) and .limit(n) can follow.");
    if (m[1] === "sort") q.sort = value(m[2], "The sort");
    else if (m[1] === "skip") q.skip = whole(m[2].trim(), "skip");
    else q.limit = whole(m[2].trim(), "limit");
    rest = rest.slice(m[0].length).trim();
  }
  return q;
}

/** The script the container runs for a checked query: only JSON the query was re-written as, never its own text. */
export function mongoScript(q: MongoQuery): string {
  const j = (v: unknown) => JSON.stringify(v);
  // mongosh has EJSON; the older mongo shell only has JSON, which writes ObjectId and dates as {$oid}, {$date}.
  const out = (expr: string) => `const __s = typeof EJSON !== "undefined" ? (x) => EJSON.stringify(x, { relaxed: true }) : (x) => JSON.stringify(x); print(__s(${expr}))`;
  switch (q.op) {
    case "collections":
      return out("db.getCollectionNames().sort().map((collection) => ({ collection }))");
    case "stats":
      return out("(({ db, collections, views, objects, dataSize, storageSize, indexes, indexSize }) => [{ db, collections, views, objects, dataSize, storageSize, indexes, indexSize }])(db.stats())");
    case "estimate":
      return out(`[{ count: db.getCollection(${j(q.collection)}).estimatedDocumentCount() }]`);
    case "count":
      return out(`[{ count: db.getCollection(${j(q.collection)}).countDocuments(${j(q.filter)}) }]`);
    case "distinct":
      return out(`db.getCollection(${j(q.collection)}).distinct(${j(q.field)}, ${j(q.filter)}).slice(0, ${MONGO_MAX_DOCS}).map((value) => ({ value }))`);
    case "aggregate":
      return out(`db.getCollection(${j(q.collection)}).aggregate(${j([...q.pipeline, { $limit: MONGO_MAX_DOCS + 1 }])}).toArray()`);
    case "find": {
      const limit = Math.min(q.limit ?? MONGO_MAX_DOCS + 1, MONGO_MAX_DOCS + 1);
      const parts = [`db.getCollection(${j(q.collection)}).find(${j(q.filter)}${q.projection ? `, ${j(q.projection)}` : ""})`];
      if (q.sort) parts.push(`.sort(${j(q.sort)})`);
      if (q.skip) parts.push(`.skip(${q.skip})`);
      parts.push(`.limit(${limit}).toArray()`);
      return out(parts.join(""));
    }
  }
}

/** The rows of a table from what the script printed: the union of the first documents' keys, each cell as text. */
export function mongoTable(printed: string): { columns: string[]; rows: string[][]; truncated: boolean } {
  const line = printed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("["))
    .pop();
  if (!line) throw new Error(printed.trim().split(/\r?\n/)[0] || "MongoDB gave no answer.");
  let docs: unknown;
  try {
    docs = JSON.parse(line);
  } catch {
    throw new Error("MongoDB's answer wasn't something dx could read.");
  }
  if (!Array.isArray(docs)) throw new Error("MongoDB's answer wasn't a list.");
  const truncated = docs.length > MONGO_MAX_DOCS;
  const shown = docs.slice(0, MONGO_MAX_DOCS) as Record<string, unknown>[];
  const columns: string[] = [];
  for (const d of shown.slice(0, 50)) for (const k of Object.keys(d && typeof d === "object" ? d : { value: d })) if (!columns.includes(k) && columns.length < 30) columns.push(k);
  const cell = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
  return { columns, rows: shown.map((d) => columns.map((c) => cell((d as Record<string, unknown>)?.[c]))), truncated };
}
