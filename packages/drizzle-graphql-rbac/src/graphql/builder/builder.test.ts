import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { graphql, type GraphQLSchema } from "graphql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

import { buildSchema } from "./builder.js";

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

let schema: GraphQLSchema;
let db: ReturnType<typeof drizzle>;

before(async () => {
  // Set up a new in-memory SQLite database instance for isolated test execution.
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE assignees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL
    );
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      assignee_id INTEGER REFERENCES assignees(id)
    );
    INSERT INTO assignees (name, email) VALUES
      ('Alice', 'alice@example.com'),
      ('Bob', 'bob@example.com');
    INSERT INTO todos (title, assignee_id) VALUES
      ('write tests', 1),
      ('review PR', 1),
      ('deploy', 2),
      ('orphan', NULL);
  `);
  db = drizzle(sqlite);
  schema = buildSchema(db, { assignees, todos }).schema;
});

async function run(query: string, variables?: Record<string, unknown>) {
  const result = await graphql({ schema, source: query, variableValues: variables });
  // Surfacing errors makes failures readable in test output.
  if (result.errors?.length) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  return result.data;
}

describe("buildSchema — root surface", () => {
  it("exposes per-table list and Single queries", async () => {
    const data: any = await run(`{ __schema { queryType { fields { name } } } }`);
    const names = data.__schema.queryType.fields.map((f: any) => f.name).sort();
    assert.deepEqual(names, ["assignees", "assigneesSingle", "todos", "todosSingle"]);
  });

  it("exposes insertInto / update / deleteFrom mutations per table", async () => {
    const data: any = await run(`{ __schema { mutationType { fields { name } } } }`);
    const names = data.__schema.mutationType.fields.map((f: any) => f.name).sort();
    assert.deepEqual(names, [
      "deleteFromAssignees",
      "deleteFromTodos",
      "insertIntoAssignees",
      "insertIntoTodos",
      "updateAssignees",
      "updateTodos",
    ]);
  });
});

describe("buildSchema — list query", () => {
  it("returns all rows when no args given", async () => {
    const data: any = await run(`{ todos { id title } }`);
    assert.equal(data.todos.length, 4);
  });

  it("filters by where (JSON domain)", async () => {
    const data: any = await run(
      `query ($w: JSON) { todos(where: $w) { title } }`,
      { w: [["title", "like", "%PR%"]] },
    );
    assert.deepEqual(data.todos.map((t: any) => t.title), ["review PR"]);
  });

  it("orders, limits, and offsets", async () => {
    const data: any = await run(
      `{ todos(orderBy: { id: DESC }, limit: 2, offset: 1) { id title } }`,
    );
    assert.deepEqual(data.todos.map((t: any) => t.title), ["deploy", "review PR"]);
  });
});

describe("buildSchema — Single query", () => {
  it("returns the first match or null", async () => {
    const found: any = await run(
      `query ($w: JSON) { todosSingle(where: $w) { id title } }`,
      { w: [["title", "=", "deploy"]] },
    );
    assert.equal(found.todosSingle.title, "deploy");

    const missing: any = await run(
      `query ($w: JSON) { todosSingle(where: $w) { id } }`,
      { w: [["title", "=", "nope"]] },
    );
    assert.equal(missing.todosSingle, null);
  });
});

describe("buildSchema — recursive relation traversal", () => {
  it("resolves the forward 'one' relation under the FK column's name", async () => {
    const data: any = await run(`
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
    const data: any = await run(`
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
    const data: any = await run(
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
    const data: any = await run(
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
    const data: any = await run(
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
    const data: any = await run(
      `query ($w: JSON) { todos(where: $w) { title } }`,
      { w: [["assigneeId", "=", 2]] },
    );
    assert.deepEqual(data.todos.map((t: any) => t.title), ["deploy"]);
  });

  it("mixes column ops and dotted predicates in a single domain", async () => {
    const data: any = await run(
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
    const data: any = await run(
      `query ($w: JSON) { assignees(where: $w) { name } }`,
      { w: [["todos.title", "=", "deploy"]] },
    );
    assert.deepEqual(data.assignees.map((a: any) => a.name), ["Bob"]);
  });

  it("composes domain combinators (OR) with dotted predicates", async () => {
    const data: any = await run(
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
  // Wrap the better-sqlite3 instance with a query counter that observes the
  // raw SQL fired by Drizzle. Reusing the suite-wide `db` would require
  // mutating it; instead we build a fresh schema bound to a counted DB and
  // reuse the same in-memory data via ATTACH would be overkill — just rebuild
  // a tiny isolated DB.
  let countedSchema: GraphQLSchema;
  let selectCount = 0;
  before(() => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE assignees (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL);
      CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, assignee_id INTEGER REFERENCES assignees(id));
      INSERT INTO assignees (name, email) VALUES ('Alice','a@x'), ('Bob','b@x'), ('Cara','c@x');
      INSERT INTO todos (title, assignee_id) VALUES ('t1',1),('t2',2),('t3',1),('t4',3),('t5',2);
    `);
    const counted = drizzle(sqlite, {
      logger: { logQuery: (q) => { if (q.startsWith("select")) selectCount++; } },
    });
    countedSchema = buildSchema(counted, { assignees, todos }).schema;
  });

  it("coalesces forward 'one' lookups into a single IN-query when context.batch is provided", async () => {
    selectCount = 0;
    const result = await graphql({
      schema: countedSchema,
      source: `{ todos(orderBy: { id: ASC }) { title assigneeId { name } } }`,
      contextValue: { batch: new Map() },
    });
    assert.equal(result.errors, undefined);
    // 1 query for the parent todos list + 1 batched IN-query for all assignees.
    assert.equal(selectCount, 2);
    const data: any = result.data;
    assert.deepEqual(
      data.todos.map((t: any) => [t.title, t.assigneeId.name]),
      [["t1","Alice"],["t2","Bob"],["t3","Alice"],["t4","Cara"],["t5","Bob"]],
    );
  });

  it("falls back to per-parent queries when no batch context is provided", async () => {
    selectCount = 0;
    const result = await graphql({
      schema: countedSchema,
      source: `{ todos(orderBy: { id: ASC }) { title assigneeId { name } } }`,
    });
    assert.equal(result.errors, undefined);
    // 1 parent query + 5 child queries (one per todo).
    assert.equal(selectCount, 6);
  });
});

describe("buildSchema — mutations round-trip", () => {
  it("insert / update / delete each return the affected rows", async () => {
    const inserted: any = await run(`
      mutation {
        insertIntoTodos(values: [{ title: "new-mutation-roundtrip", assigneeId: 2 }]) { id title }
      }
    `);
    const newId = inserted.insertIntoTodos[0].id;
    assert.equal(inserted.insertIntoTodos[0].title, "new-mutation-roundtrip");

    const updated: any = await run(
      `mutation ($w: JSON) { updateTodos(set: { completed: true }, where: $w) { id completed } }`,
      { w: [["id", "=", newId]] },
    );
    assert.equal(updated.updateTodos[0].completed, true);

    const deleted: any = await run(
      `mutation ($w: JSON) { deleteFromTodos(where: $w) { id title } }`,
      { w: [["id", "=", newId]] },
    );
    assert.equal(deleted.deleteFromTodos[0].title, "new-mutation-roundtrip");

    // Confirm row is actually gone.
    const after: any = await run(
      `query ($w: JSON) { todosSingle(where: $w) { id } }`,
      { w: [["id", "=", newId]] },
    );
    assert.equal(after.todosSingle, null);
  });
});
