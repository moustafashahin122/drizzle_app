import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { GraphQLInputObjectType, GraphQLObjectType } from "graphql";

import { makeBuilderFixture, type BuilderFixture } from "./__helpers__.js";

// End-to-end tests against an in-memory SQLite. We define a small two-table
// schema with a single FK so we can verify root CRUD, recursive relation
// traversal, and the auto-introspection pipeline all at once.

const assignees = sqliteTable("assignees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
});

const todos = sqliteTable("todos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  assigneeId: integer("assignee_id").references(() => assignees.id),
});

const baseTables = { assignees, todos };

let fx: BuilderFixture;

before(async () => {
  fx = await makeBuilderFixture({
    tables: baseTables,
    seed: async (db) => {
      await db.insert(assignees).values([
        { name: "Alice", email: "alice@example.com" },
        { name: "Bob", email: "bob@example.com" },
      ]);
      await db.insert(todos).values([
        { title: "write tests", assigneeId: 1 },
        { title: "review PR", assigneeId: 1 },
        { title: "deploy", assigneeId: 2 },
        { title: "orphan", assigneeId: null },
      ]);
    },
  });
});

describe("buildSchema — root surface", () => {
  it("exposes per-table list and Single queries", async () => {
    const data = await fx.run(`{ __schema { queryType { fields { name } } } }`);
    const names = new Set(data.__schema.queryType.fields.map((f: any) => f.name));
    assert.deepEqual(names, new Set(["assignees", "assigneesSingle", "todos", "todosSingle"]));
  });

  it("exposes insertInto / update / deleteFrom mutations per table", async () => {
    const data = await fx.run(`{ __schema { mutationType { fields { name } } } }`);
    const names = new Set(data.__schema.mutationType.fields.map((f: any) => f.name));
    assert.deepEqual(
      names,
      new Set([
        "deleteFromAssignees",
        "deleteFromTodos",
        "insertIntoAssignees",
        "insertIntoTodos",
        "updateAssignees",
        "updateTodos",
      ]),
    );
  });
});

describe("buildSchema — list query", () => {
  it("returns all rows when no args given", async () => {
    const data = await fx.run(`{ todos(orderBy: { id: ASC }) { id title } }`);
    assert.equal(data.todos.length, 4);
    assert.deepEqual(
      data.todos.map((t: any) => t.title),
      ["write tests", "review PR", "deploy", "orphan"],
      "zero-arg list must return every seeded title in insertion order",
    );
  });

  it("filters by where (JSON domain)", async () => {
    const data = await fx.run(
      `query ($w: JSON) { todos(where: $w) { title } }`,
      { w: [["title", "like", "%PR%"]] },
    );
    assert.deepEqual(data.todos.map((t: any) => t.title), ["review PR"]);
  });

  it("orders, limits, and offsets", async () => {
    const data = await fx.run(
      `{ todos(orderBy: { id: DESC }, limit: 2, offset: 1) { id title } }`,
    );
    assert.deepEqual(data.todos.map((t: any) => t.title), ["deploy", "review PR"]);
  });
});

describe("buildSchema — Single query", () => {
  it("returns the first match or null", async () => {
    const found = await fx.run(
      `query ($w: JSON) { todosSingle(where: $w) { id title } }`,
      { w: [["title", "=", "deploy"]] },
    );
    assert.equal(found.todosSingle.title, "deploy");

    const missing = await fx.run(
      `query ($w: JSON) { todosSingle(where: $w) { id } }`,
      { w: [["title", "=", "nope"]] },
    );
    assert.equal(missing.todosSingle, null);
  });
});

describe("buildSchema — recursive relation traversal", () => {
  it("resolves the forward 'one' relation under the FK column's name", async () => {
    const data = await fx.run(`
      { todos(orderBy: { id: ASC }) { title assigneeId { name } } }
    `);
    assert.deepEqual(
      data.todos.map((t: any) => [t.title, t.assigneeId?.name ?? null]),
      [
        ["write tests", "Alice"],
        ["review PR", "Alice"],
        ["deploy", "Bob"],
        ["orphan", null],
      ],
    );
  });

  it("resolves the inverse 'many' relation on the referenced table", async () => {
    const data = await fx.run(`
      { assignees(orderBy: { id: ASC }) { name todos(orderBy: { id: ASC }) { title } } }
    `);
    assert.deepEqual(
      data.assignees.map((a: any) => [a.name, a.todos.map((t: any) => t.title)]),
      [
        ["Alice", ["write tests", "review PR"]],
        ["Bob", ["deploy"]],
      ],
    );
  });

  it("recurses through multiple relation hops", async () => {
    const data = await fx.run(
      `query ($w: JSON) { todosSingle(where: $w) {
          assigneeId { todos(orderBy: { id: ASC }) { title } }
      } }`,
      { w: [["id", "=", 1]] },
    );
    assert.deepEqual(
      data.todosSingle.assigneeId.todos.map((t: any) => t.title),
      ["write tests", "review PR"],
    );
  });

  it("accepts where/limit on a 'many' relation field", async () => {
    const data = await fx.run(
      `query ($a: JSON, $t: JSON) { assignees(where: $a) {
          todos(where: $t, limit: 1) { title }
      } }`,
      {
        a: [["id", "=", 1]],
        t: [["title", "like", "%tests%"]],
      },
    );
    assert.deepEqual(data.assignees[0].todos.map((t: any) => t.title), ["write tests"]);
  });
});

describe("buildSchema — nested relation filters (dotted domain paths)", () => {
  it("filters parent rows via a dotted path through the forward 'one' relation", async () => {
    const data = await fx.run(
      `query ($w: JSON) {
        todos(where: $w, orderBy: { id: ASC }) {
          title
          assigneeId { email }
        }
      }`,
      { w: [["assigneeId.email", "=", "alice@example.com"]] },
    );
    assert.deepEqual(
      data.todos.map((t: any) => [t.title, t.assigneeId?.email ?? null]),
      [
        ["write tests", "alice@example.com"],
        ["review PR", "alice@example.com"],
      ],
    );
  });

  it("still supports column-op filtering on the same FK column", async () => {
    const data = await fx.run(
      `query ($w: JSON) { todos(where: $w) { title } }`,
      { w: [["assigneeId", "=", 2]] },
    );
    assert.deepEqual(data.todos.map((t: any) => t.title), ["deploy"]);
  });

  it("mixes column ops and dotted predicates in a single domain", async () => {
    const data = await fx.run(
      `query ($w: JSON) { todos(where: $w, orderBy: { id: ASC }) { title } }`,
      {
        w: [
          ["completed", "=", false],
          ["assigneeId.name", "=", "Alice"],
        ],
      },
    );
    assert.deepEqual(
      data.todos.map((t: any) => t.title),
      ["write tests", "review PR"],
    );
  });

  it("filters parents by an inverse 'many' relation via dotted path", async () => {
    const data = await fx.run(
      `query ($w: JSON) { assignees(where: $w) { name } }`,
      { w: [["todos.title", "=", "deploy"]] },
    );
    assert.deepEqual(data.assignees.map((a: any) => a.name), ["Bob"]);
  });

  it("composes domain combinators (OR) with dotted predicates", async () => {
    const data = await fx.run(
      `query ($w: JSON) { todos(where: $w, orderBy: { id: ASC }) { title } }`,
      {
        w: [
          "|",
          ["assigneeId.email", "like", "alice%"],
          ["title", "=", "orphan"],
        ],
      },
    );
    assert.deepEqual(
      data.todos.map((t: any) => t.title),
      ["write tests", "review PR", "orphan"],
    );
  });
});

describe("buildSchema — relation batching", () => {
  let batchFx: BuilderFixture;
  before(async () => {
    batchFx = await makeBuilderFixture({
      tables: baseTables,
      countQueries: true,
      seed: async (db) => {
        await db.insert(assignees).values([
          { name: "Alice", email: "a@x" },
          { name: "Bob",   email: "b@x" },
          { name: "Cara",  email: "c@x" },
        ]);
        await db.insert(todos).values([
          { title: "t1", assigneeId: 1 },
          { title: "t2", assigneeId: 2 },
          { title: "t3", assigneeId: 1 },
          { title: "t4", assigneeId: 3 },
          { title: "t5", assigneeId: 2 },
        ]);
      },
    });
  });

  it("coalesces forward 'one' lookups into a single IN-query when context.batch is provided", async () => {
    batchFx.resetCounter();
    const data = await batchFx.run(
      `{ todos(orderBy: { id: ASC }) { title assigneeId { name } } }`,
      undefined,
      { batch: new Map() },
    );
    // 1 query for the parent todos list + 1 batched IN-query for all assignees.
    assert.equal(batchFx.selects(), 2);
    assert.deepEqual(
      data.todos.map((t: any) => [t.title, t.assigneeId.name]),
      [["t1","Alice"],["t2","Bob"],["t3","Alice"],["t4","Cara"],["t5","Bob"]],
    );
  });

  it("falls back to per-parent queries when no batch context is provided", async () => {
    batchFx.resetCounter();
    await batchFx.run(
      `{ todos(orderBy: { id: ASC }) { title assigneeId { name } } }`,
    );
    // 1 parent query + 5 child queries (one per todo).
    assert.equal(batchFx.selects(), 6);
  });

  it("chunks the IN-list query when relationBatchSize < unique-fk-count", async () => {
    const chunkFx = await makeBuilderFixture({
      tables: baseTables,
      countQueries: true,
      builder: { relationBatchSize: 2 },
      seed: async (db) => {
        await db.insert(assignees).values([
          { name: "A", email: "a@x" },
          { name: "B", email: "b@x" },
          { name: "C", email: "c@x" },
          { name: "D", email: "d@x" },
        ]);
        await db.insert(todos).values([
          { title: "t1", assigneeId: 1 },
          { title: "t2", assigneeId: 2 },
          { title: "t3", assigneeId: 3 },
          { title: "t4", assigneeId: 4 },
        ]);
      },
    });
    chunkFx.resetCounter();
    const data = await chunkFx.run(
      `{ todos(orderBy: { id: ASC }) { title assigneeId { name } } }`,
      undefined,
      { batch: new Map() },
    );
    // 1 parent query + 2 chunked IN-queries (4 unique FKs split into batches of 2).
    assert.equal(chunkFx.selects(), 3);
    assert.deepEqual(
      data.todos.map((t: any) => [t.title, t.assigneeId.name]),
      [["t1","A"],["t2","B"],["t3","C"],["t4","D"]],
    );
  });
});

describe("buildSchema — hiddenInputColumns", () => {
  // Use a small users-like table to exercise the option without disturbing
  // the shared `fx` setup above.
  const users = sqliteTable("users", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
  });

  // Table-driven: covers Insert/Update presence/absence of hidden columns + the
  // "default (option omitted): all columns appear" baseline in one place. Each
  // row is its own subtest so a single failing case names itself in the report.
  it("hidden-input column presence per (inputType, field, expectPresent)", async (t) => {
    const cases: Array<{
      configHidden: { users: string[] } | undefined;
      inputType: "UsersInsert" | "UsersUpdate";
      field: "passwordHash" | "email" | "name";
      expectPresent: boolean;
    }> = [
      { configHidden: { users: ["passwordHash"] }, inputType: "UsersInsert", field: "passwordHash", expectPresent: false },
      { configHidden: { users: ["passwordHash"] }, inputType: "UsersUpdate", field: "passwordHash", expectPresent: false },
      // Non-hidden columns must still appear on the same input types.
      { configHidden: { users: ["passwordHash"] }, inputType: "UsersInsert", field: "email", expectPresent: true },
      { configHidden: { users: ["passwordHash"] }, inputType: "UsersUpdate", field: "name", expectPresent: true },
      // Default (option omitted): every column appears on Insert.
      { configHidden: undefined, inputType: "UsersInsert", field: "passwordHash", expectPresent: true },
    ];
    for (const c of cases) {
      const label = `${c.inputType}/${c.field}/hidden=${!c.expectPresent}`;
      await t.test(label, async () => {
        const f = await makeBuilderFixture({
          tables: { users },
          builder: c.configHidden ? { hiddenInputColumns: c.configHidden } : undefined,
        });
        const inputType = f.schema.getType(c.inputType) as GraphQLInputObjectType;
        const field = inputType.getFields()[c.field];
        if (c.expectPresent) {
          assert.ok(field, `${c.field} must be present on ${c.inputType}`);
        } else {
          assert.equal(field, undefined, `${c.field} must NOT be present on ${c.inputType}`);
        }
      });
    }
  });

  it("does not affect the output object type (independent from hiddenOutputColumns)", async () => {
    // Hide `name` from inputs only — confirm it stays on the Users output.
    const f = await makeBuilderFixture({
      tables: { users },
      builder: { hiddenInputColumns: { users: ["name"] } },
    });
    const usersOut = f.schema.getType("Users") as GraphQLObjectType;
    const outFields = usersOut.getFields();
    assert.ok(outFields.name, "Users output type must still expose `name`");
    assert.ok(outFields.passwordHash, "Users output type must still expose `passwordHash`");
    const insertType = f.schema.getType("UsersInsert") as GraphQLInputObjectType;
    assert.equal(insertType.getFields().name, undefined);
  });
});

describe("buildSchema — maxListLimit clamp", () => {
  // Table-driven: the three clamp behaviours share an identical "build schema
  // with cap=5, seed 10 rows, run list query" flow — only the query's `limit`
  // argument varies. `queryLimit: null` means omit `limit` from the query.
  it("clamp behaviour per (configCap, queryLimit, expectedRows)", async (t) => {
    const cases: Array<{ configCap: number; queryLimit: number | null; expected: number }> = [
      { configCap: 5, queryLimit: 100, expected: 5 }, // over cap → clamped
      { configCap: 5, queryLimit: 3, expected: 3 },   // under cap respected
      { configCap: 5, queryLimit: null, expected: 5 }, // omitted → defaults to cap
    ];
    for (const c of cases) {
      const label = `cap=${c.configCap}/limit=${c.queryLimit ?? "omitted"}→${c.expected}`;
      await t.test(label, async () => {
        const f = await makeBuilderFixture({
          tables: { assignees },
          builder: { maxListLimit: c.configCap },
          seed: async (db) => {
            await db
              .insert(assignees)
              .values(Array.from({ length: 10 }, (_, i) => ({ name: `u${i}`, email: `u${i}@x` })));
          },
        });
        const source =
          c.queryLimit === null
            ? `{ assignees { id } }`
            : `{ assignees(limit: ${c.queryLimit}) { id } }`;
        const data = await f.run(source);
        assert.equal(data.assignees.length, c.expected);
      });
    }
  });

  it("default cap is 200 when maxListLimit is unspecified", async () => {
    // Strengthened: pin not just cardinality but the first/last identities so a
    // regression that returns 200 *random* rows (e.g. accidental ORDER BY drop)
    // fails here.
    const f = await makeBuilderFixture({
      tables: { assignees },
      seed: async (db) => {
        await db
          .insert(assignees)
          .values(Array.from({ length: 250 }, (_, i) => ({ name: `u${i}`, email: `u${i}@x` })));
      },
    });
    const data = await f.run(`{ assignees(orderBy: { id: ASC }, limit: 1000) { id name } }`);
    assert.equal(data.assignees.length, 200);
    // Use loose equality on `id` — the builder maps the PK to GraphQL's `ID`
    // scalar which is serialized as a string. The point of these asserts is
    // identity + ordering, not scalar shape.
    assert.equal(String(data.assignees[0].id), "1");
    assert.equal(data.assignees[0].name, "u0", "first row should be the first seeded row");
    assert.equal(String(data.assignees[199].id), "200");
    assert.equal(
      data.assignees[199].name,
      "u199",
      "200th row should be the 200th seeded row — proves we got the FIRST 200, not a random 200",
    );
  });
});

describe("buildSchema — mutations round-trip", () => {
  it("insert / update / delete each return the affected rows", async () => {
    const inserted = await fx.run(`
      mutation {
        insertIntoTodos(values: [{ title: "new-mutation-roundtrip", assigneeId: 2 }]) { id title }
      }
    `);
    const newId = inserted.insertIntoTodos[0].id;
    assert.equal(inserted.insertIntoTodos[0].title, "new-mutation-roundtrip");

    const updated = await fx.run(
      `mutation ($w: JSON) { updateTodos(set: { completed: true }, where: $w) { id completed } }`,
      { w: [["id", "=", newId]] },
    );
    assert.equal(updated.updateTodos[0].completed, true);

    const deleted = await fx.run(
      `mutation ($w: JSON) { deleteFromTodos(where: $w) { id title } }`,
      { w: [["id", "=", newId]] },
    );
    assert.equal(deleted.deleteFromTodos[0].title, "new-mutation-roundtrip");

    // Confirm row is actually gone.
    const after = await fx.run(
      `query ($w: JSON) { todosSingle(where: $w) { id } }`,
      { w: [["id", "=", newId]] },
    );
    assert.equal(after.todosSingle, null);
  });
});
