import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dx-data-test-"));
const { parsePrisma, parseSql, readDataSchema, makeRows, makeScene, fillOrder, saveScene, listScenes, loadScene, dataTarget, loadData, saveCurrentData, sceneSlug } = await import("../index.js");

const PRISMA = `
datasource db { provider = "postgresql" url = env("DATABASE_URL") }
enum Role { MEMBER ADMIN }
model User {
  id        Int       @id @default(autoincrement())
  email     String    @unique
  name      String?
  role      Role      @default(MEMBER)
  deletedAt DateTime?
  orders    Order[]
  @@map("users")
}
model Order {
  id     String @id @default(uuid())
  user   User   @relation(fields: [userId], references: [id])
  userId Int    @map("user_id")
  total  Decimal
  items  Item[]
}
model Item {
  id       Int   @id @default(autoincrement())
  order    Order @relation(fields: [orderId], references: [id])
  orderId  String
  quantity Int
  @@unique([orderId, quantity])
}`;

test("a Prisma schema: models, relations, enums, maps and the provider", () => {
  const s = parsePrisma(PRISMA);
  assert.equal(s.provider, "postgresql");
  assert.deepEqual(s.tables.map((t) => t.name), ["User", "Order", "Item"]);
  const user = s.tables[0];
  assert.equal(user.dbName, "users");
  assert.deepEqual(user.columns.map((c) => c.name), ["id", "email", "name", "role", "deletedAt"], "relation lists aren't columns");
  assert.deepEqual(user.columns.find((c) => c.name === "role")!.enumValues, ["MEMBER", "ADMIN"]);
  const order = s.tables[1];
  assert.deepEqual(order.columns.find((c) => c.name === "userId")!.ref, { table: "User", column: "id" });
  assert.equal(order.columns.find((c) => c.name === "userId")!.dbName, "user_id");
  assert.equal(order.columns.find((c) => c.name === "id")!.generated, "uuid");
  assert.deepEqual(s.tables[2].uniques, [["orderId", "quantity"]]);
  assert.deepEqual(fillOrder(s.tables), ["User", "Order", "Item"]);
});

test("SQL migrations: columns, keys, foreign keys from REFERENCES and ALTER TABLE", () => {
  const tables = parseSql(`
    CREATE TABLE "public"."customers" (id SERIAL PRIMARY KEY, email VARCHAR(200) NOT NULL UNIQUE, joined_at TIMESTAMP WITH TIME ZONE DEFAULT now());
    CREATE TABLE IF NOT EXISTS orders (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL CHECK (status IN ('new', 'paid')),
      amount NUMERIC(10, 2),
      meta JSONB
    );
    CREATE TABLE \`line_items\` (\`id\` int NOT NULL AUTO_INCREMENT, \`order_id\` bigint NOT NULL, \`qty\` int, PRIMARY KEY (\`id\`)) ENGINE=InnoDB;
    ALTER TABLE line_items ADD CONSTRAINT fk FOREIGN KEY (order_id) REFERENCES orders (id);
  `);
  assert.deepEqual(tables.map((t) => t.name), ["customers", "orders", "line_items"]);
  const orders = tables[1];
  assert.equal(orders.columns.find((c) => c.name === "id")!.generated, "autoincrement");
  assert.deepEqual(orders.columns.find((c) => c.name === "customer_id")!.ref, { table: "customers", column: "id" });
  assert.deepEqual(orders.columns.find((c) => c.name === "status")!.enumValues, ["new", "paid"]);
  assert.equal(orders.columns.find((c) => c.name === "amount")!.type, "decimal");
  assert.deepEqual(tables[2].columns.find((c) => c.name === "order_id")!.ref, { table: "orders", column: "id" });
  assert.equal(tables[2].columns.find((c) => c.name === "id")!.id, true);
});

test("rows: connected, deterministic, with the edge cases and the recipes", () => {
  const schema = { ...parsePrisma(PRISMA), file: "prisma/schema.prisma" };
  const a = makeRows(schema, "typical", 7);
  assert.deepEqual(a, makeRows(schema, "typical", 7), "the same seed, the same rows");
  assert.notDeepEqual(a.rows.Order, makeRows(schema, "typical", 8).rows.Order);
  const users = a.rows.User;
  assert.equal(users.length, 12);
  assert.equal(new Set(users.map((u) => u.email)).size, 12, "unique emails");
  assert.ok(users.every((u) => /@example\.com$/.test(String(u.email))));
  assert.equal(String(users[1].name).length, 200, "a 200-character name");
  assert.ok(users.some((u) => /🌱/.test(String(u.name))), "emoji");
  assert.ok(users[2].deletedAt, "a deleted user…");
  const ids = new Set(users.map((u) => u.id));
  assert.ok(a.rows.Order.every((o) => ids.has(o.userId as number)), "every order belongs to a user");
  assert.ok(a.rows.Order.some((o) => o.userId === users[2].id), "…who still has orders");
  assert.ok(!a.rows.Order.some((o) => o.userId === users[0].id), "the first user has none (empty states)");
  const orderIds = new Set(a.rows.Order.map((o) => o.id));
  assert.ok(a.rows.Item.every((i) => orderIds.has(i.orderId as string)));
  assert.equal(new Set(a.rows.Item.map((i) => `${i.orderId}|${i.quantity}`)).size, a.rows.Item.length, "composite uniques hold");
  const big = makeRows(schema, "big-customer", 7);
  assert.equal(big.rows.Order.filter((o) => o.userId === users[1].id).length, 60);
  const first = makeRows(schema, "first-time", 7);
  assert.deepEqual([first.rows.User.length, first.rows.Order.length], [1, 0]);
  assert.deepEqual(Object.values(makeRows(schema, "empty").rows).flat(), []);
});

test("scenes are kept per project, readable by you only, named safely", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shop-website-"));
  const schema = { ...parsePrisma(PRISMA), file: "prisma/schema.prisma" };
  saveScene(dir, makeScene(schema, "typical", 3, "Demo for Friday"));
  const list = listScenes(dir);
  assert.equal(list[0].slug, "demo-for-friday");
  assert.equal(list[0].tables, 3);
  assert.equal(loadScene(dir, "demo-for-friday").seed, 3);
  assert.throws(() => sceneSlug("../.."), /needs a name/);
  assert.throws(() => loadScene(dir, "nope"), /isn't there/);
});

test("loading: only a database on this computer, through the project's own Prisma client, after a backup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-app-"));
  fs.mkdirSync(path.join(dir, "prisma"));
  fs.writeFileSync(path.join(dir, "prisma", "schema.prisma"), PRISMA);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "todo-app" }));
  const schema = readDataSchema(dir)!;
  assert.equal(schema.source, "prisma");
  const project = { name: "todo-app", dir };
  assert.match(dataTarget(project, schema).why!, /@prisma\/client isn't installed/);

  // A stand-in @prisma/client that keeps its "database" in a JSON file.
  const client = path.join(dir, "node_modules", "@prisma", "client");
  fs.mkdirSync(client, { recursive: true });
  fs.writeFileSync(path.join(client, "package.json"), JSON.stringify({ name: "@prisma/client", main: "index.js" }));
  fs.writeFileSync(
    path.join(client, "index.js"),
    `const fs = require("fs"); const path = require("path");
     const file = path.join(process.cwd(), "db.json");
     const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { user: [{ id: 99, email: "old@example.com" }], order: [], item: [] });
     class PrismaClient {
       constructor() { this.data = read(); for (const m of ["user", "order", "item"]) this[m] = this.delegate(m); }
       delegate(m) { const d = this.data; return { deleteMany: async () => { d[m] = []; }, createMany: async ({ data }) => { d[m].push(...data); }, create: async ({ data }) => { d[m].push(data); }, findMany: async () => d[m] }; }
       async $transaction(fn) { await fn(this); fs.writeFileSync(file, JSON.stringify(this.data)); }
       async $executeRawUnsafe(sql) { fs.appendFileSync(path.join(process.cwd(), "sql.log"), sql + "\\n"); }
       async $disconnect() {}
     }
     module.exports = { PrismaClient };`,
  );
  fs.writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgresql://dev:dev@prod-db.example.com:5432/shop\n");
  assert.match(dataTarget(project, schema).why!, /not on this computer/);
  await assert.rejects(loadData(project, schema, makeScene(schema, "typical", 1)), /not on this computer/);

  fs.writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgresql://dev:dev@localhost:5432/shop\n");
  assert.equal(dataTarget(project, schema).how, "prisma");
  const r = await loadData(project, schema, makeScene(schema, "typical", 1), { source: "cli" });
  assert.ok(r.rows > 20);
  assert.match(r.backup!, /^Before Typical/, "the data that was there was saved first");
  const db = JSON.parse(fs.readFileSync(path.join(dir, "db.json"), "utf8"));
  assert.equal(db.user.length, 12);
  assert.ok(!db.user.some((u: { id: number }) => u.id === 99), "replaced, not added to");
  assert.match(fs.readFileSync(path.join(dir, "sql.log"), "utf8"), /setval\(pg_get_serial_sequence\('"users"', 'id'\)/, "Postgres counters moved past the ids used");
  const backup = listScenes(dir).find((s) => s.kind === "backup")!;
  assert.equal(loadScene(dir, backup.slug).rows.User[0].email, "old@example.com");
  const saved = await saveCurrentData(project, schema, "After load");
  assert.equal(saved.rows.User.length, 12);
});
