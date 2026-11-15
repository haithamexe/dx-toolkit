import assert from "node:assert/strict";
import { test } from "node:test";

const { parseMongoQuery, mongoScript, mongoTable, kindOfImage } = await import("../index.js");

test("a MongoDB image is a database dx can read", () => {
  assert.equal(kindOfImage("mongo:7"), "mongo");
  assert.equal(kindOfImage("docker.io/library/mongo@sha256:abc"), "mongo");
  assert.equal(kindOfImage("percona/percona-server-mongodb:7"), "mongo");
  assert.equal(kindOfImage("postgres:16"), "postgres");
});

test("reading queries are read into parts, in the shell's own words", () => {
  assert.deepEqual(parseMongoQuery(""), { op: "collections" });
  assert.deepEqual(parseMongoQuery("show collections"), { op: "collections" });
  assert.deepEqual(parseMongoQuery("db.stats()"), { op: "stats" });
  assert.deepEqual(parseMongoQuery('db.orders.find({ status: "paid", total: { $gt: 10 } }, { _id: 0, total: 1 }).sort({ total: -1 }).skip(5).limit(20);'), {
    op: "find",
    collection: "orders",
    filter: { status: "paid", total: { $gt: 10 } },
    projection: { _id: 0, total: 1 },
    sort: { total: -1 },
    skip: 5,
    limit: 20,
  });
  assert.deepEqual(parseMongoQuery("db.orders.find()"), { op: "find", collection: "orders", filter: {} });
  assert.deepEqual(parseMongoQuery("db.orders.findOne({ id: 3 })"), { op: "find", collection: "orders", filter: { id: 3 }, limit: 1 });
  assert.deepEqual(parseMongoQuery("db.orders.countDocuments({ status: 'paid' })"), { op: "count", collection: "orders", filter: { status: "paid" } });
  assert.deepEqual(parseMongoQuery("db.orders.estimatedDocumentCount()"), { op: "estimate", collection: "orders" });
  assert.deepEqual(parseMongoQuery('db.orders.distinct("status")'), { op: "distinct", collection: "orders", field: "status", filter: {} });
  assert.deepEqual(parseMongoQuery('db.getCollection("order-items").aggregate([{ $match: { qty: { $gt: 1 } } }, { $group: { _id: "$sku", n: { $sum: 1 } } }])'), {
    op: "aggregate",
    collection: "order-items",
    pipeline: [{ $match: { qty: { $gt: 1 } } }, { $group: { _id: "$sku", n: { $sum: 1 } } }],
  });
  // A quote or a colon inside a string isn't a key.
  assert.deepEqual(parseMongoQuery(`db.notes.find({ text: "a: b, 'c'" })`), { op: "find", collection: "notes", filter: { text: "a: b, 'c'" } });
});

test("everything that writes or runs code is refused, whatever it's wrapped in", () => {
  const refused = [
    "db.orders.insertOne({ a: 1 })",
    "db.orders.deleteMany({})",
    "db.orders.drop()",
    "db.dropDatabase()",
    'db.orders.find({ $where: "sleep(10000)" })',
    'db.orders.find({ a: { $function: { body: "function(){}", args: [], lang: "js" } } })',
    "db.orders.aggregate([{ $out: 'copy' }])",
    "db.orders.aggregate([{ $merge: { into: 'copy' } }])",
    "db.orders.find({}).forEach(printjson)",
    "db.orders.find({}).toArray().map(x => x)",
    "db.system.users.find()",
    'db.getCollection("system.users").find()',
    "db.orders.find({ a: ObjectId('507f1f77bcf86cd799439011') })",
    'db.orders.find({}); db.orders.drop()',
    "db.orders.find({}).limit(-1)",
    "use admin",
    "load('/etc/passwd')",
    "db.orders.find({ a: 1 }).hint({ $natural: 1 }).explain()",
    "db.orders.aggregate([{ $match: {} }]).forEach(x => x)",
    "db.orders.countDocuments({}).foo()",
    "db.orders.find({ a: ",
  ];
  for (const q of refused) assert.throws(() => parseMongoQuery(q), Error, q);
});

test("the script the container runs is built from checked JSON only, never from the text typed", () => {
  const typed = 'db.orders.find({ name: "x\\"); db.dropDatabase(); (\\"" })';
  // A string that tries to close the script: it stays a string value, written as JSON.
  const script = mongoScript(parseMongoQuery(typed));
  assert.ok(script.includes('db.getCollection("orders").find({"name":"x\\"); db.dropDatabase(); (\\""}).limit(201).toArray()'), script);
  // The same query with a limit: capped.
  assert.ok(mongoScript(parseMongoQuery("db.orders.find().limit(100000)")).includes(".limit(201)"));
  // The pipeline always ends in a limit of its own.
  assert.ok(mongoScript(parseMongoQuery("db.orders.aggregate([{ $match: {} }])")).includes('{"$limit":201}'));
  // Every script prints one line of data through one function.
  for (const q of ["", "db.stats()", "db.a.find()", "db.a.countDocuments()", "db.a.estimatedDocumentCount()", 'db.a.distinct("x")', "db.a.aggregate([])"]) {
    const s = mongoScript(parseMongoQuery(q));
    assert.equal(s.split("print(").length, 2, q);
    assert.ok(!/\b(eval|require|process|insert|update|delete|drop|remove)\w*\(/i.test(s.replace(/"[^"]*"/g, '""')), `${q}: ${s}`);
  }
});

test("what the shell printed becomes a table: the first documents' keys as columns, values as text", () => {
  const printed = 'some banner\n[{"_id":{"$oid":"507f1f77bcf86cd799439011"},"name":"Mug","tags":["a","b"],"price":9},{"name":"Cup","price":7,"extra":null}]\n';
  const t = mongoTable(printed);
  assert.deepEqual(t.columns, ["_id", "name", "tags", "price", "extra"]);
  assert.deepEqual(t.rows[0], ['{"$oid":"507f1f77bcf86cd799439011"}', "Mug", '["a","b"]', "9", ""]);
  assert.deepEqual(t.rows[1], ["", "Cup", "", "7", "null"]);
  assert.equal(t.truncated, false);
  const many = JSON.stringify(Array.from({ length: 250 }, (_, i) => ({ i })));
  const big = mongoTable(many);
  assert.equal(big.rows.length, 200);
  assert.equal(big.truncated, true);
  assert.throws(() => mongoTable("MongoServerError: not authorized\nmore"), /not authorized/);
  assert.throws(() => mongoTable("[not json"), /couldn't|wasn't|something/i);
});
