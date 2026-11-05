import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dxPath } from "../config.js";

/**
 * Realistic data in one click: a project's database schema (Prisma, or CREATE TABLE in its SQL
 * migrations) read into tables, and believable, connected rows made for it: users with orders,
 * orders with items, and the edge cases that break apps (an empty cart, a 200-character name,
 * emoji, missing optional values, a soft-deleted user who still has orders). Deterministic from a
 * seed. Datasets are kept as named scenes under ~/.dx/data, to switch between in seconds.
 * Loading one (seedload.ts) only ever touches a database on this computer.
 */

export type ColumnType = "string" | "int" | "bigint" | "float" | "decimal" | "bool" | "date" | "json" | "bytes" | "enum";

export interface Column {
  name: string;
  /** The name in the database (@map / the SQL column). */
  dbName: string;
  type: ColumnType;
  optional: boolean;
  id?: boolean;
  unique?: boolean;
  /** The database fills it: autoincrement, uuid(), cuid(), now(), @updatedAt, a SQL default. */
  generated?: "autoincrement" | "uuid" | "cuid" | "now" | "updatedAt" | "default";
  enumValues?: string[];
  /** A foreign key: this column holds another table's column. */
  ref?: { table: string; column: string };
  list?: boolean;
}

export interface Table {
  name: string;
  dbName: string;
  columns: Column[];
  /** Columns that together must be unique (@@unique, @@id, UNIQUE (a, b)). */
  uniques: string[][];
}

export interface DataSchema {
  source: "prisma" | "sql";
  /** The file it was read from, relative to the project. */
  file: string;
  provider?: "postgresql" | "mysql" | "sqlite" | "sqlserver" | "mongodb" | "cockroachdb";
  tables: Table[];
}

export type Rows = Record<string, Array<Record<string, unknown>>>;

export interface Scene {
  format: "dx-scene";
  version: 1;
  name: string;
  /** "made" (generated), "saved" (from the database) or "backup" (saved before loading another). */
  kind: "made" | "saved" | "backup";
  createdAt: string;
  /** Tables in the order they're filled (parents before children). */
  order: string[];
  rows: Rows;
  /** How it was made: the recipe and its seed. */
  recipe?: string;
  seed?: number;
}

// ------------------------------------------------------------------ reading the schema

/** The project's schema: Prisma first, then SQL files with CREATE TABLE. */
export function readDataSchema(dir: string): DataSchema | undefined {
  const prisma = findPrismaSchema(dir);
  if (prisma) {
    const text = prisma.files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    return { ...parsePrisma(text), file: prisma.files[0] };
  }
  const sqlFiles = findSqlFiles(dir);
  if (sqlFiles.length) {
    const tables = parseSql(sqlFiles.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n;\n"));
    if (tables.length) return { source: "sql", file: sqlFiles[0], tables };
  }
  return undefined;
}

function findPrismaSchema(dir: string): { files: string[] } | undefined {
  let custom: string | undefined;
  try {
    custom = (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { prisma?: { schema?: string } }).prisma?.schema;
  } catch {
    // no package.json
  }
  for (const f of [custom, "prisma/schema.prisma", "schema.prisma", "prisma/schema"].filter((x): x is string => !!x)) {
    const full = path.join(dir, f);
    if (!full.startsWith(path.resolve(dir))) continue;
    try {
      const st = fs.statSync(full);
      if (st.isFile()) return { files: [f] };
      if (st.isDirectory()) {
        const files = fs.readdirSync(full).filter((x) => x.endsWith(".prisma")).map((x) => path.posix.join(f.replace(/\\/g, "/"), x));
        if (files.length) return { files };
      }
    } catch {
      // not there
    }
  }
  return undefined;
}

function findSqlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 4 || out.length > 300) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !/^(node_modules|\.git|dist|build|vendor|\.next)$/.test(e.name)) walk(r, depth + 1);
      else if (e.isFile() && /\.sql$/i.test(e.name) && /migrat|schema|db|sql/i.test(r)) out.push(r);
    }
  };
  walk("", 0);
  return out.filter((f) => /create\s+table/i.test(fs.readFileSync(path.join(dir, f), "utf8")));
}

const PRISMA_TYPES: Record<string, ColumnType> = { String: "string", Int: "int", BigInt: "bigint", Float: "float", Decimal: "decimal", Boolean: "bool", DateTime: "date", Json: "json", Bytes: "bytes" };

/** Models, fields, relations, enums and the provider from a Prisma schema. */
export function parsePrisma(text: string): Omit<DataSchema, "file"> {
  const clean = text.replace(/\/\/[^\n]*/g, "");
  const provider = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/.exec(clean)?.[1] as DataSchema["provider"];
  const enums = new Map<string, string[]>();
  for (const m of clean.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) enums.set(m[1], m[2].split(/\s+/).map((v) => v.trim()).filter((v) => /^\w+$/.test(v)));
  const blocks = [...clean.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)];
  const models = new Set(blocks.map((b) => b[1]));
  const tables: Table[] = [];
  const relations: Array<{ table: string; fields: string[]; model: string; references: string[] }> = [];
  for (const [, name, body] of blocks) {
    const t: Table = { name, dbName: /@@map\(\s*"([^"]+)"/.exec(body)?.[1] ?? name, columns: [], uniques: [] };
    for (const line of body.split("\n").map((l) => l.trim())) {
      if (!line || line.startsWith("@@")) {
        const u = /@@(unique|id)\(\s*(?:fields:\s*)?\[([^\]]+)\]/.exec(line);
        if (u) t.uniques.push(u[2].split(",").map((x) => x.trim()));
        continue;
      }
      const m = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, field, type, list, opt, attrs] = m;
      if (models.has(type)) {
        const rel = /@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*references:\s*\[([^\]]+)\]/.exec(attrs);
        if (rel) relations.push({ table: name, fields: rel[1].split(",").map((x) => x.trim()), model: type, references: rel[2].split(",").map((x) => x.trim()) });
        continue;
      }
      const col: Column = { name: field, dbName: /@map\(\s*"([^"]+)"/.exec(attrs)?.[1] ?? field, type: enums.has(type) ? "enum" : (PRISMA_TYPES[type] ?? "string"), optional: !!opt };
      if (enums.has(type)) col.enumValues = enums.get(type);
      if (list) col.list = true;
      if (/@id\b/.test(attrs)) col.id = true;
      if (/@unique\b/.test(attrs)) col.unique = true;
      const def = /@default\(\s*([\w]+)\s*\(/.exec(attrs)?.[1];
      if (def === "autoincrement") col.generated = "autoincrement";
      else if (def === "uuid") col.generated = "uuid";
      else if (def === "cuid" || def === "nanoid" || def === "ulid") col.generated = "cuid";
      else if (def === "now") col.generated = "now";
      else if (/@updatedAt\b/.test(attrs)) col.generated = "updatedAt";
      else if (/@default\(/.test(attrs)) col.generated = "default";
      t.columns.push(col);
    }
    tables.push(t);
  }
  for (const r of relations) {
    const t = tables.find((x) => x.name === r.table);
    r.fields.forEach((f, i) => {
      const c = t?.columns.find((x) => x.name === f);
      if (c) c.ref = { table: r.model, column: r.references[i] ?? "id" };
    });
  }
  return { source: "prisma", provider, tables };
}

const SQL_TYPES: Array<[RegExp, ColumnType]> = [
  [/^(bigserial|serial8|bigint|int8)\b/, "bigint"],
  [/^(serial|smallserial|int|integer|smallint|tinyint\(1\)|mediumint|int4|int2)\b/, "int"],
  [/^(bool|boolean|bit\(1\))\b/, "bool"],
  [/^(decimal|numeric|money)\b/, "decimal"],
  [/^(real|double|float|float4|float8)\b/, "float"],
  [/^(timestamp|timestamptz|datetime|date|time)\b/, "date"],
  [/^(json|jsonb)\b/, "json"],
  [/^(bytea|blob|binary|varbinary)\b/, "bytes"],
];

/** CREATE TABLE statements (Postgres, MySQL, SQLite) into tables, with foreign keys from REFERENCES and ALTER TABLE. */
export function parseSql(text: string): Table[] {
  const sql = text.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // `"public"."customers"`, `shop.customers`, `[customers]` → customers.
  const unq = (s: string) => s.trim().replace(/[`"[\]]/g, "").split(".").pop()!.trim();
  const tables = new Map<string, Table>();
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([`"[\]\w.]+)\s*\(([\s\S]*?)\)\s*(?:;|engine|without|strict|$)/gi)) {
    const name = unq(m[1]);
    const t: Table = { name, dbName: name, columns: [], uniques: [] };
    // Split the body on commas outside parentheses.
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of m[2]) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    for (const raw of parts.map((p) => p.trim()).filter(Boolean)) {
      const lower = raw.toLowerCase();
      const pk = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]+)\)/i.exec(raw);
      if (pk) {
        const cols = pk[1].split(",").map(unq);
        if (cols.length === 1) t.columns.forEach((c) => c.name === cols[0] && (c.id = true));
        else t.uniques.push(cols);
        continue;
      }
      const uq = /^(?:constraint\s+\S+\s+)?unique\s*(?:key|index)?\s*(?:\S+\s*)?\(([^)]+)\)/i.exec(raw);
      if (uq) {
        t.uniques.push(uq[1].split(",").map(unq));
        continue;
      }
      const fk = /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]+)\)\s*references\s+([`"[\]\w.]+)\s*\(([^)]+)\)/i.exec(raw);
      if (fk) {
        const c = t.columns.find((x) => x.name === unq(fk[1].split(",")[0]));
        if (c) c.ref = { table: unq(fk[2]), column: unq(fk[3].split(",")[0]) };
        continue;
      }
      if (/^(key|index|check|constraint|exclude)\b/i.test(raw)) continue;
      const col = /^([`"[\]\w]+)\s+([\w]+(?:\s*\([^)]*\))?(?:\s+(?:varying|precision|with(?:out)?\s+time\s+zone))*)(.*)$/is.exec(raw);
      if (!col) continue;
      const type = col[2].toLowerCase().replace(/\s+/g, " ");
      const rest = col[3].toLowerCase();
      const c: Column = { name: unq(col[1]), dbName: unq(col[1]), type: SQL_TYPES.find(([re]) => re.test(type))?.[1] ?? "string", optional: !/not\s+null|primary\s+key/.test(rest) };
      if (/primary\s+key/.test(rest)) c.id = true;
      if (/\bunique\b/.test(rest)) c.unique = true;
      if (/serial/.test(type) || /auto_?increment|identity|generated\s+(always|by\s+default)/.test(rest) || (c.id && /^integer$/.test(type) && /primary\s+key/.test(rest))) c.generated = "autoincrement";
      else if (/default\s+(gen_random_uuid|uuid_generate)/.test(rest)) c.generated = "uuid";
      else if (/default\s+(now\(\)|current_timestamp)/.test(rest)) c.generated = "now";
      else if (/\bdefault\b/.test(rest)) c.generated = "default";
      const ref = /references\s+([`"[\]\w.]+)\s*(?:\(([^)]+)\))?/i.exec(col[3]);
      if (ref) c.ref = { table: unq(ref[1]), column: ref[2] ? unq(ref[2]) : "id" };
      const en = /^enum\s*\(([^)]*)\)/i.exec(col[2] + col[3]) ?? /check\s*\(\s*\S+\s+in\s*\(([^)]*)\)/i.exec(col[3]);
      if (en) {
        c.type = "enum";
        c.enumValues = en[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")).filter(Boolean);
      }
      void lower;
      t.columns.push(c);
    }
    tables.set(name.toLowerCase(), t);
  }
  for (const m of sql.matchAll(/alter\s+table\s+(?:only\s+)?([`"[\]\w.]+)\s+add\s+(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]+)\)\s*references\s+([`"[\]\w.]+)\s*\(([^)]+)\)/gi)) {
    const t = tables.get(unq(m[1]).toLowerCase());
    const c = t?.columns.find((x) => x.name === unq(m[2].split(",")[0]));
    if (c) c.ref = { table: unq(m[3]), column: unq(m[4].split(",")[0]) };
  }
  for (const m of sql.matchAll(/create\s+unique\s+index\s+\S+\s+on\s+([`"[\]\w.]+)\s*\(([^)]+)\)/gi)) {
    const t = tables.get(unq(m[1]).toLowerCase());
    const cols = m[2].split(",").map(unq);
    if (t && cols.length === 1) t.columns.forEach((c) => c.name === cols[0] && (c.unique = true));
    else t?.uniques.push(cols);
  }
  // Table names in references may differ in case or quoting.
  const byLower = new Map([...tables.values()].map((t) => [t.name.toLowerCase(), t.name]));
  for (const t of tables.values()) for (const c of t.columns) if (c.ref) c.ref.table = byLower.get(c.ref.table.toLowerCase()) ?? c.ref.table;
  return [...tables.values()];
}

// ------------------------------------------------------------------ making rows

/** Parents before children; a cycle is broken at an optional reference. */
export function fillOrder(tables: Table[]): string[] {
  const names = new Set(tables.map((t) => t.name));
  const deps = new Map(tables.map((t) => [t.name, new Set(t.columns.filter((c) => c.ref && names.has(c.ref.table) && c.ref.table !== t.name && !c.optional).map((c) => c.ref!.table))]));
  const out: string[] = [];
  const left = new Set(names);
  while (left.size) {
    const ready = [...left].filter((n) => [...deps.get(n)!].every((d) => !left.has(d)));
    const next = ready.length ? ready : [[...left][0]];
    for (const n of next.sort()) {
      out.push(n);
      left.delete(n);
    }
  }
  return out;
}

const FIRST = ["Ava", "Liam", "Noor", "Mateo", "Yuki", "Amara", "Lucas", "Sofia", "Omar", "Mei", "Elena", "Kwame", "Hana", "Diego", "Zara", "Ivan", "Leila", "Theo", "Priya", "Jonas"];
const LAST = ["Okafor", "Lindqvist", "García", "Nakamura", "Haddad", "Novak", "Rossi", "Chen", "Silva", "Kowalski", "Dubois", "Mensah", "Petrov", "Kaya", "Moreau", "Fischer"];
const PRODUCTS = ["Blue mug", "Linen notebook", "Desk lamp", "Wool scarf", "Ceramic bowl", "Canvas tote", "Oak cutting board", "Steel water bottle", "Cotton apron", "Pocket knife", "Glass jar", "Leather wallet"];
const WORDS = ["quick", "notes", "about", "the", "new", "order", "arrived", "late", "but", "works", "well", "thanks", "great", "quality", "would", "buy", "again", "small", "issue", "with", "packaging"];
const CITIES = ["Lisbon", "Nairobi", "Osaka", "Montréal", "Kraków", "Bogotá", "Tbilisi", "Auckland", "Ghent", "Porto Alegre"];
const COUNTRIES = ["PT", "KE", "JP", "CA", "PL", "CO", "GE", "NZ", "BE", "BR"];
const STATUS = ["pending", "active", "paid", "shipped", "done", "cancelled"];
const LONG = "Maximilian Alexander Konstantin Bartholomew Fitzgerald-Wolfeschlegelsteinhausenbergerdorff the Third of the Very Long Family Name Society, who fills every field to the brim and then some more text to reach two hundred";

/** A small seeded random number generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OWNER = /^(users?|accounts?|customers?|members?|profiles?|people|persons?|authors?|clients?)$/i;
const isOwner = (t: Table) => OWNER.test(t.name) || OWNER.test(t.dbName);

export type Recipe = "typical" | "big-customer" | "first-time" | "empty";

export const RECIPES: Array<{ id: Recipe; name: string; about: string }> = [
  { id: "typical", name: "Typical", about: "a dozen users, each with a few of everything, and the edge cases: an empty one, a 200-character name, emoji, missing optional values, a deleted user who still has records" },
  { id: "big-customer", name: "Big customer", about: "the typical data, with one user who has 60 of everything: long lists, paging, slow pages" },
  { id: "first-time", name: "First-time user", about: "one user with nothing yet: empty states everywhere" },
  { id: "empty", name: "Empty", about: "no rows at all" },
];

/** Rows for every table, in fill order, from a recipe and a seed. */
export function makeRows(schema: DataSchema, recipe: Recipe = "typical", seed = 1): { order: string[]; rows: Rows } {
  const order = fillOrder(schema.tables);
  const rows: Rows = Object.fromEntries(order.map((n) => [n, []]));
  if (recipe === "empty") return { order, rows };
  const random = rng(seed);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const between = (a: number, b: number) => a + Math.floor(random() * (b - a + 1));
  const now = Date.UTC(2026, 10, 1, 12);
  const byName = new Map(schema.tables.map((t) => [t.name, t]));

  for (const name of order) {
    const t = byName.get(name)!;
    const refs = t.columns.filter((c) => c.ref && byName.has(c.ref.table));
    const required = refs.filter((c) => !c.optional && c.ref!.table !== name);
    const ownerRef = refs.find((c) => isOwner(byName.get(c.ref!.table)!));
    // How many rows: owners and lookup tables a dozen; children a few per parent, some none.
    let count: number;
    let ownerOf: (i: number) => number | undefined = () => undefined;
    if (!required.length) count = isOwner(t) ? (recipe === "first-time" ? 1 : 12) : 10;
    else {
      const parent = ownerRef ?? required[0];
      const parents = rows[parent.ref!.table]?.length ?? 0;
      if (!parents) continue; // nothing to belong to
      if (recipe === "first-time" && ownerRef) count = 0;
      else {
        // Parent 0 has none (an empty cart), the big customer (parent 1) has 60.
        const per = Array.from({ length: parents }, (_, p) => (p === 0 ? 0 : recipe === "big-customer" && p === 1 ? 60 : between(1, 5)));
        count = Math.min(400, per.reduce((a, b) => a + b, 0));
        const slots = per.flatMap((n, p) => Array.from({ length: n }, () => p));
        ownerOf = (i) => slots[i];
        const parentCol = parent;
        refs.splice(refs.indexOf(parentCol), 1);
        refs.unshift(parentCol);
      }
    }
    const seen = new Set<string>();
    for (let i = 0; i < count; i++) {
      const row: Record<string, unknown> = {};
      for (const c of t.columns) {
        if (c.ref && byName.has(c.ref.table)) {
          const parentRows = rows[c.ref.table];
          if (!parentRows?.length || (c.ref.table === name && i === 0)) {
            if (c.optional) row[c.name] = null;
            continue;
          }
          const p = c === refs[0] && ownerOf(i) !== undefined ? ownerOf(i)! : between(0, parentRows.length - 1 - (c.ref.table === name ? 1 : 0));
          row[c.name] = parentRows[Math.max(0, p)][byName.get(c.ref.table)!.columns.find((x) => x.name === c.ref!.column)?.name ?? c.ref.column];
          continue;
        }
        const v = valueFor(t, c, i, { random, pick, between, now });
        if (v !== undefined) row[c.name] = v;
      }
      // Composite uniques: skip a row that repeats one.
      const key = t.uniques.map((u) => u.map((k) => JSON.stringify(row[k])).join("|")).join("#");
      if (t.uniques.length && seen.has(key)) continue;
      seen.add(key);
      rows[name].push(row);
    }
  }
  return { order, rows };
}

interface Rand {
  random: () => number;
  pick: <T>(list: T[]) => T;
  between: (a: number, b: number) => number;
  now: number;
}

/** A believable value for a column, by its name and type. Row 0 and 1 carry the edge cases. */
function valueFor(t: Table, c: Column, i: number, r: Rand): unknown {
  const n = c.name.toLowerCase();
  const edge = i === 1; // the long, unicode, sparse row
  if (c.id && c.generated === "autoincrement") return i + 1;
  if (c.id && (c.type === "int" || c.type === "bigint")) return i + 1;
  if (c.id || c.generated === "uuid" || c.generated === "cuid") {
    if (c.type !== "string") return i + 1;
    const h = crypto.createHash("sha1").update(`${t.name}:${i}`).digest("hex");
    return c.generated === "cuid" ? `c${h.slice(0, 24)}` : `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  if (c.generated === "updatedAt" || (c.generated === "now" && c.type === "date")) return new Date(r.now - r.between(0, 90) * 86_400_000 - r.between(0, 86_399) * 1000).toISOString();
  if (c.optional && (edge || r.random() < 0.15) && !/name|title|email/.test(n)) return null;
  if (/deleted_?at|archived_?at|removed_?at/.test(n)) return i === 2 ? new Date(r.now - 5 * 86_400_000).toISOString() : c.optional ? null : new Date(r.now).toISOString();
  const first = FIRST[i % FIRST.length];
  const last = LAST[(i * 7) % LAST.length];
  if (c.type === "enum" && c.enumValues?.length) return c.enumValues[i % c.enumValues.length];
  if (c.list) return c.type === "string" ? ["one", "two"] : [];
  switch (c.type) {
    case "bool":
      return /verified|active|enabled|published|visible|confirmed/.test(n) ? i % 5 !== 3 : r.random() < 0.3;
    case "date":
      if (/birth|dob/.test(n)) return new Date(Date.UTC(r.between(1960, 2005), r.between(0, 11), r.between(1, 28))).toISOString();
      if (/due|expire|until|end|deadline/.test(n)) return new Date(r.now + r.between(1, 60) * 86_400_000).toISOString();
      if (edge) return new Date(Date.UTC(1999, 11, 31, 23, 59, 59)).toISOString();
      return new Date(r.now - r.between(0, 365) * 86_400_000).toISOString();
    case "int":
    case "bigint":
      if (/qty|quantity|count|stock|seats|items/.test(n)) return edge ? 0 : r.between(1, 9);
      if (/rating|stars|score/.test(n)) return r.between(1, 5);
      if (/age/.test(n)) return r.between(18, 90);
      if (/year/.test(n)) return r.between(1990, 2026);
      if (/price|amount|total|cost|cents/.test(n)) return edge ? 0 : r.between(100, 50_000);
      if (/position|order|sort|rank|index/.test(n)) return i;
      return r.between(1, 1000);
    case "float":
    case "decimal":
      if (/lat/.test(n)) return Math.round((r.random() * 140 - 70) * 1e5) / 1e5;
      if (/lng|lon/.test(n)) return Math.round((r.random() * 340 - 170) * 1e5) / 1e5;
      if (/rating|score/.test(n)) return Math.round(r.random() * 40 + 10) / 10;
      return edge ? 0 : Math.round(r.random() * 49_900 + 100) / 100;
    case "json":
      return edge ? {} : { source: "dx", tags: [r.pick(WORDS), r.pick(WORDS)] };
    case "bytes":
      return c.optional ? null : undefined;
  }
  // Strings, by what they're called.
  const u = c.unique || c.id;
  const tag = u ? `${i + 1}` : "";
  if (/e-?mail/.test(n)) return `${first}.${last}${tag || i}`.toLowerCase().normalize("NFD").replace(/[^\w.]/g, "") + "@example.com";
  if (/^(user_?name|handle|login|nick(name)?)$/.test(n)) return `${first.toLowerCase()}${i + 1}`;
  if (/^first_?name$|^given/.test(n)) return edge ? "Zoë 🌱" : first;
  if (/^last_?name$|^family|surname/.test(n)) return edge ? LONG.slice(0, 120) : last;
  if (/password|hash|secret|token|salt/.test(n)) return `dx-not-a-real-${n}-${crypto.createHash("sha1").update(`${t.name}${i}${n}`).digest("hex").slice(0, 24)}`;
  if (/phone|mobile|tel/.test(n)) return `+1 555 01${String(i % 100).padStart(2, "0")}`;
  if (/city|town/.test(n)) return CITIES[i % CITIES.length];
  if (/country/.test(n)) return COUNTRIES[i % COUNTRIES.length];
  if (/zip|postal|postcode/.test(n)) return String(10000 + i * 37);
  if (/street|address|line_?1/.test(n)) return `${r.between(1, 400)} ${last} Street`;
  if (/url|website|link|href/.test(n)) return `https://example.com/${t.name.toLowerCase()}/${i + 1}`;
  if (/image|avatar|photo|picture|logo|thumbnail/.test(n)) return `https://example.com/images/${t.name.toLowerCase()}-${i + 1}.png`;
  if (/color|colour/.test(n)) return `#${crypto.createHash("sha1").update(`${i}`).digest("hex").slice(0, 6)}`;
  if (/currency/.test(n)) return ["EUR", "USD", "JPY", "BRL"][i % 4];
  if (/locale|lang/.test(n)) return ["en", "pt-BR", "ja", "ar"][i % 4];
  if (/status|state/.test(n)) return STATUS[i % STATUS.length];
  if (/role|type|kind/.test(n)) return ["member", "admin", "guest"][i % 3];
  if (/slug/.test(n)) return `${(isOwner(t) ? `${first}-${last}` : PRODUCTS[i % PRODUCTS.length]).toLowerCase().normalize("NFD").replace(/[^\w]+/g, "-")}-${i + 1}`;
  if (/^(sku|code|ref(erence)?|number)$/.test(n)) return `${t.name.slice(0, 3).toUpperCase()}-${String(1000 + i)}`;
  if (/description|bio|body|content|text|comment|message|note|summary|about/.test(n)) {
    if (edge) return `${"🎉 Ünïcödé, <b>markup</b>, 'quotes' & \"more\" — ".repeat(3)}${LONG}`;
    return Array.from({ length: r.between(6, 18) }, () => r.pick(WORDS)).join(" ").replace(/^./, (x) => x.toUpperCase()) + ".";
  }
  if (/name|title|label|subject|heading/.test(n)) {
    if (isOwner(t) || /full|display|user|customer|author/.test(n)) return edge ? LONG.slice(0, 200) : i === 3 ? "Zoë O'Brien-Nakamura 🌱" : `${first} ${last}`;
    const base = PRODUCTS[i % PRODUCTS.length];
    return edge ? LONG.slice(0, 200) : `${base}${u || i >= PRODUCTS.length ? ` ${i + 1}` : ""}`;
  }
  return u ? `${t.name.toLowerCase()}-${i + 1}` : Array.from({ length: r.between(1, 3) }, () => r.pick(WORDS)).join(" ");
}

// ------------------------------------------------------------------ scenes on disk

function norm(p: string): string {
  const r = path.resolve(p);
  return process.platform === "linux" ? r : r.toLowerCase();
}

export function scenesFolder(dir: string): string {
  const name = path.basename(dir).replace(/[^\w.-]+/g, "-").slice(0, 40) || "project";
  return dxPath("data", `${name}-${crypto.createHash("sha1").update(norm(dir)).digest("hex").slice(0, 8)}`);
}

/** A scene's name, safe as a file name: letters, digits, spaces, dashes. */
export function sceneSlug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  if (!s) throw new Error("A scene needs a name with letters or digits.");
  return s;
}

export function saveScene(dir: string, scene: Scene): string {
  const folder = scenesFolder(dir);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${sceneSlug(scene.name)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(scene), { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  // Keep the newest 5 backups.
  const backups = listScenes(dir).filter((s) => s.kind === "backup");
  for (const b of backups.slice(5)) fs.rmSync(path.join(folder, `${b.slug}.json`), { force: true });
  return file;
}

export interface SceneInfo {
  slug: string;
  name: string;
  kind: Scene["kind"];
  createdAt: string;
  tables: number;
  rows: number;
  recipe?: string;
}

export function listScenes(dir: string): SceneInfo[] {
  const folder = scenesFolder(dir);
  let files: string[];
  try {
    files = fs.readdirSync(folder).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .flatMap((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(folder, f), "utf8")) as Scene;
        if (s.format !== "dx-scene") return [];
        return [{ slug: f.slice(0, -5), name: s.name, kind: s.kind, createdAt: s.createdAt, tables: Object.keys(s.rows).length, rows: Object.values(s.rows).reduce((n, r) => n + r.length, 0), recipe: s.recipe }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function loadScene(dir: string, slug: string): Scene {
  const safe = sceneSlug(slug);
  const file = path.join(scenesFolder(dir), `${safe}.json`);
  let s: Scene;
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8")) as Scene;
  } catch {
    throw new Error("That scene isn't there any more.");
  }
  if (s.format !== "dx-scene" || typeof s.rows !== "object" || !Array.isArray(s.order)) throw new Error("That file isn't a dx scene.");
  return s;
}

export function removeScene(dir: string, slug: string): void {
  fs.rmSync(path.join(scenesFolder(dir), `${sceneSlug(slug)}.json`), { force: true });
}

/** A scene made from a recipe. */
export function makeScene(schema: DataSchema, recipe: Recipe, seed = 1, name?: string): Scene {
  const { order, rows } = makeRows(schema, recipe, seed);
  return { format: "dx-scene", version: 1, name: name ?? RECIPES.find((x) => x.id === recipe)!.name, kind: "made", createdAt: new Date().toISOString(), order, rows, recipe, seed };
}
