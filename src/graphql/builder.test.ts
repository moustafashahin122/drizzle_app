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

  it("filters by where", async () => {
    const data: any = await run(
      `{ todos(where: { title: { like: "%PR%" } }) { title } }`,
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
      `{ todosSingle(where: { title: { eq: "deploy" } }) { id title } }`,
    );
    assert.equal(found.todosSingle.title, "deploy");

    const missing: any = await run(
      `{ todosSingle(where: { title: { eq: "nope" } }) { id } }`,
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
    const data: any = await run(`
      { todosSingle(where: { id: { eq: 1 } }) {
          assigneeId { todos(orderBy: { id: ASC }) { title } }
      } }
    `);
    assert.deepEqual(
      data.todosSingle.assigneeId.todos.map((t: any) => t.title),
      ["write tests", "review PR"],
    );
  });

  it("accepts where/limit on a 'many' relation field", async () => {
    const data: any = await run(`
      { assignees(where: { id: { eq: 1 } }) {
          todos(where: { title: { like: "%tests%" } }, limit: 1) { title }
      } }
    `);
    assert.deepEqual(data.assignees[0].todos.map((t: any) => t.title), ["write tests"]);
  });
});

describe("buildSchema — nested relation filters", () => {
  it("filters parent rows by a predicate on the forward 'one' relation (FK column shadow)", async () => {
    // The `assigneeId` field on TodosWhere keeps its column ops AND exposes
    // the referenced Assignees fields, so callers can write
    // `assigneeId: { email: { eq: ... } }` without losing `eq: 1` etc.
    const data: any = await run(`
      query {
        todos(
          where: { assigneeId: { email: { eq: "alice@example.com" } } }
          orderBy: { id: ASC }
        ) {
          title
          assigneeId { email }
        }
      }
    `);
    assert.deepEqual(
      data.todos.map((t: any) => [t.title, t.assigneeId?.email ?? null]),
      [
        ["write tests", "alice@example.com"],
        ["review PR", "alice@example.com"],
      ],
    );
  });

  it("still supports column-op filtering on the same FK field", async () => {
    const data: any = await run(`
      { todos(where: { assigneeId: { eq: 2 } }) { title } }
    `);
    assert.deepEqual(data.todos.map((t: any) => t.title), ["deploy"]);
  });

  it("mixes column ops and nested predicates in a single filter object", async () => {
    const data: any = await run(`
      query {
        todos(
          where: {
            completed: { eq: false }
            assigneeId: { name: { eq: "Alice" } }
          }
          orderBy: { id: ASC }
        ) { title }
      }
    `);
    assert.deepEqual(
      data.todos.map((t: any) => t.title),
      ["write tests", "review PR"],
    );
  });

  it("filters parents by an inverse 'many' relation field that doesn't shadow a column", async () => {
    // `todos` is the inverse-many on assignees — filter assignees that have
    // at least one matching todo.
    const data: any = await run(`
      query {
        assignees(
          where: { todos: { title: { eq: "deploy" } } }
        ) { name }
      }
    `);
    assert.deepEqual(data.assignees.map((a: any) => a.name), ["Bob"]);
  });

  it("composes nested filters with AND/OR", async () => {
    const data: any = await run(`
      query {
        todos(
          where: {
            OR: [
              { assigneeId: { email: { like: "alice%" } } }
              { title: { eq: "orphan" } }
            ]
          }
          orderBy: { id: ASC }
        ) { title }
      }
    `);
    assert.deepEqual(
      data.todos.map((t: any) => t.title),
      ["write tests", "review PR", "orphan"],
    );
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
      `mutation { updateTodos(set: { completed: true }, where: { id: { eq: ${newId} } }) { id completed } }`,
    );
    assert.equal(updated.updateTodos[0].completed, true);

    const deleted: any = await run(
      `mutation { deleteFromTodos(where: { id: { eq: ${newId} } }) { id title } }`,
    );
    assert.equal(deleted.deleteFromTodos[0].title, "new-mutation-roundtrip");

    // Confirm row is actually gone.
    const after: any = await run(
      `{ todosSingle(where: { id: { eq: ${newId} } }) { id } }`,
    );
    assert.equal(after.todosSingle, null);
  });
});
