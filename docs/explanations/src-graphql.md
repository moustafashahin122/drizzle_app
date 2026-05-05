# Understanding `src/graphql` — How a Drizzle Schema Becomes a GraphQL API

## The big picture

Imagine you've defined a couple of database tables in Drizzle — `todos` and `assignees`, with a foreign key linking them. Normally, exposing them through GraphQL would mean writing:

- An ObjectType for each table
- Input types for filtering, ordering, inserting, updating
- Resolvers for queries and mutations
- Relation resolvers so `todos { assignee { name } }` works
- Custom code every time you add a column

That's a lot of boilerplate. And every schema change means editing two places — the database and the GraphQL layer.

`src/graphql` exists to remove that whole tier. You hand it your Drizzle DB and your schema namespace, and it gives you back a fully working `GraphQLSchema` — queries, mutations, filters, ordering, pagination, and recursive nested relations included. Add a column, restart, done. There's no "graphql layer" you have to maintain anymore.

Despite what the README hints at, this is **not** the `drizzle-graphql` npm package. It's a hand-written generator that lives entirely in this folder.

## What you put in, what you get out

You call:

```ts
import * as schemaModule from "./db.js";
const { schema } = buildSchema(db, schemaModule);
```

What comes back is a schema where, for each table, you automatically have:

- `Query.todos(where, orderBy, limit, offset)` — paginated list
- `Query.todosSingle(where, orderBy)` — first match or null
- `Mutation.insertIntoTodos`, `updateTodos`, `deleteFromTodos`
- A `Todos` object type with every column as a field
- Foreign-key columns auto-promoted into traversable relation objects
- Filter inputs that support `eq`, `like`, `gt`, `in`, `AND/OR/NOT`, and even nested predicates like *"todos whose assignee's email is X"*

You did nothing extra to make any of that exist.

## The mental model: two passes over your schema

The trick to building this without your code blowing up on circular references is doing it in **two passes**.

Think of it like furnishing a house. In the first pass you put down empty placeholder boxes labeled "Todo type", "Assignee type", "TodoWhere", "AssigneeWhere", etc. You don't fill them yet — you just register that these things will exist. In the second pass, when every placeholder exists, you fill in their contents. By that point, when "Todo's relation field" needs to refer to "Assignee type", the Assignee box already exists in the registry, so the reference works.

GraphQL has built-in support for this idea: you can give a type a `fields: () => ({...})` thunk instead of a plain object. The thunk only runs when GraphQL actually needs to look at the fields, which happens at request time — long after both passes have finished. So you can freely reference types that haven't been built yet, knowing they will be by the time anyone actually reads them.

That's why almost every `fields:` in this codebase is a function. It's not a quirk; it's the whole reason cycles work.

## How a single table flows through the pipeline

Let's follow `todos` from "Drizzle table definition" to "fully working GraphQL surface."

### Step 1 — Introspection (`relations.ts`)

`introspectSchema(schema)` walks your schema namespace and builds a structured view:

- Every value that looks like a Drizzle Table (Drizzle marks them with a brand symbol) gets indexed twice — once by SQL table name, once by the JS key you used in the export.
- Every `relations(...)` declaration is unpacked. Drizzle stores the config as a callback expecting helpers; we feed it the official `createTableRelationsHelpers` so we get back the same `One`/`Many` objects Drizzle itself sees.
- Then we look at each table for **inline foreign keys** — single-column `.references(...)` calls. We auto-promote each one into two relations:
  - A forward "one": on the source table, named after the FK column. So `todos.assigneeId` becomes a relation called `assigneeId` pointing at the matching assignee row.
  - An inverse "many": on the referenced table, named after the source table's JS key. So `assignees` gets a relation called `todos`.

If you wrote an explicit `relations()` declaration, that wins. We only auto-promote field names that are still free.

There's one detail worth noting: composite (multi-column) FKs are skipped by the auto-promotion. You can still use them, but you'd need to declare an explicit `relations()` for them. The auto-detector only handles the common single-column case.

### Step 2 — Pass 1: type construction (`builder.ts`)

For each table we build a `TableMeta` — a little internal record that holds:

- The Drizzle table reference and its column map
- The list of relations on this table
- Every GraphQL type derived from the table: `objectType`, `insertInput`, `updateInput`, `whereInput`, `orderByInput`

The object type's fields are a thunk that calls `buildObjectFields` later. That function does two things:

1. Add one field per scalar column, mapped through `columnToBaseType` (which decides between `Int`, `String`, `Float`, `ID`, `Boolean`, etc., based on Drizzle's `dataType` and a few hints).
2. **Overlay relation fields**. Here's a subtle point: when a relation has the same name as a column (like `assigneeId`), the relation **replaces the scalar column on the output type**. So `todos { assigneeId }` doesn't return the integer — it returns the related row, and you write `todos { assigneeId { name } }` to traverse.

But — and this is the key — the column itself is still in `meta.columns`. So `where`, `set`, Insert, and Update inputs all keep using the scalar. Only the *output side* gets replaced. This dual-life behavior is intentional: it gives you the convenience of relation traversal without losing the ability to write `where: { assigneeId: { eq: 5 } }`.

### Step 3 — Where input gets a little fancier

The `whereInput` is built by `buildWhereInput`. Inside its lazy thunk:

- It self-references for `AND`, `OR`, `NOT` (recursion, broken safely by the thunk).
- It builds a per-column `<Table>_<col>_Filter` input with the operator vocabulary: `eq, ne, gt, gte, lt, lte, in, notIn, like, ilike, isNull`.
- **For columns that have a same-named single-column relation**, it spreads the referenced table's `Where` fields directly into that filter. So `Todos_assigneeId_Filter` ends up with `eq, ne, gt, ..., id, name, email, AND, OR, NOT` — operator vocab AND the assignee table's where shape, side by side. Operator names always win on collision so the operator vocabulary stays predictable.
- For relations that **don't** shadow a column (e.g. `todos` on `assignees`, the inverse-many), the relation is added as a plain field on `<TypeName>Where` typed as the referenced table's `<RefType>Where`.

This is what makes `where: { assigneeId: { email: { eq: "x@y" } } }` legal at the type level. Translation happens later.

### Step 4 — Pass 2: root fields

Now `metas` is fully populated. We loop over it once more and call `addRootFields`, which attaches the standard CRUD shape to `Query` and `Mutation`. Each resolver gets a `WhereContext` — a small bundle holding the DB handle, the relations on this table, and a `lookup(refSqlName)` function that returns the referenced table's columns and relations. This context is what lets the where-translator hop across tables.

The mutation resolvers all use Drizzle's `.returning()` so they emit the rows they affected. That's why `insertIntoTodos`, `updateTodos`, and `deleteFromTodos` all return arrays of rows you can select fields from.

## Resolving relations at query time

When you write:

```graphql
{ todos { assigneeId { name } } }
```

Here's what happens. The `todos` resolver runs `db.select().from(todos)` and returns rows. Each row has an `assigneeId` integer. GraphQL then asks the `Todos` object type to resolve its `assigneeId` field — but that field is no longer the scalar; it's the **relation field** built by `buildRelationField`.

The relation resolver:

1. Looks at the parent row, reads the local key (`assigneeId`).
2. If it's null, returns `null` immediately — no query.
3. Otherwise builds a join condition (`eq(assignees.id, parent.assigneeId)`) and runs another select on the referenced table.
4. For "one" returns the first row or null. For "many" returns an array.

There's no batching. If you fetch 100 todos and ask for each one's assignee, that's 100 follow-up queries. For this app's scale that's fine; for a bigger system you'd add DataLoader. The SDD calls this out as known future work.

For "many" relations, the resolver also accepts `where`, `orderBy`, `limit`, `offset` arguments — they compose with the parent-row join condition by AND-ing. This is what makes things like `assignees(...) { todos(where: { completed: { eq: false } }, limit: 5) { title } }` work.

## How `where` becomes SQL

`whereToSql(where, columns, ctx?)` is the translator. It's recursive, and it has to handle four shapes per key:

- A **logical combinator** (`AND`, `OR`, `NOT`): recurse, drop empty results, wrap with the matching Drizzle helper (`and`, `or`, `not`).
- A **column with operators**: switch on each operator name and emit the matching Drizzle fragment (`eq(col, val)`, `like(col, "%x%")`, etc.).
- A **column whose value also includes nested-relation keys** (only possible because of the spread we did during input construction): split the value's keys into "operator names" vs "everything else" and handle each side separately.
- A **relation-only key** (no matching column): treat the value as a where against the referenced table.

For nested predicates, we don't do a SQL JOIN — we emit a subquery:

```sql
parent.<localCol> IN (SELECT ref.<remoteCol> FROM ref WHERE <inner>)
```

So `where: { assigneeId: { email: { eq: "x@y" } } }` compiles to roughly `todos.assignee_id IN (SELECT assignees.id FROM assignees WHERE email = 'x@y')`. The same pattern works in both directions — for forward "one" and inverse "many" — because both relation kinds share the same join shape (`parent.fields[i] === ref.references[i]`).

One small but important detail: if the inner where translates to nothing (empty object, all unknown keys), we *drop* the predicate entirely. We don't emit `IN (SELECT col FROM ref)` because that would mean "any row where the parent's FK matches anything that exists" — which is almost certainly not what the user meant. Empty in, empty out.

## Why unknown keys are silently dropped

Look closely at `whereToSql` and you'll notice it never throws on unknown column or operator keys. That's intentional. By the time a request reaches a resolver, GraphQL's parse-and-validate phase has already enforced the schema. If something invalid somehow makes it through, treating it as benign noise is safer than throwing — and the published schema is the contract anyway. Clients can't synthesize columns or relations that aren't declared, because the input types simply don't have those fields.

## A few things worth knowing if you go modify this

**Field names equal Drizzle JS keys.** The whole layer assumes the GraphQL field name and the JS object key in your `sqliteTable("...", { id: ..., title: ... })` definition are the same string. That's how resolvers look up columns from the keys clients send in `where` / `orderBy` / `set`. If you renamed at one layer without the other, things would break.

**Operator names are reserved.** A column literally named `eq` would be unreachable through nested filtering on a parent FK, because the operator branch wins on collision in the spread. In practice nobody names columns `eq` or `isNull`, but it's worth knowing the rule.

**Lazy thunks are load-bearing.** If you ever change a `fields: () => ...` to a plain `fields: { ... }`, you'll likely break recursive types. Cycles only resolve because GraphQL defers field resolution.

**Drizzle's `.returning()` is a hard dependency.** All mutation resolvers chain `.returning()`. SQLite, Postgres, and MySQL all support it via Drizzle, but if you ported this to a dialect that didn't, mutations would need a different strategy.

**Per-relation queries multiply.** If you fetch 1000 todos with their assignees, that's 1001 queries. For this app it's fine; for production at scale, you'd want DataLoader batching layered into the relation resolver.

## What you should walk away with

You should now be able to picture the whole flow:

1. Drizzle schema goes in.
2. Introspection extracts tables and relations (explicit + auto-promoted from FKs).
3. Pass 1 builds every per-table GraphQL type, with lazy field thunks so cycles work.
4. Pass 2 attaches root queries and mutations, each carrying a `WhereContext` that tells the filter translator how to hop between tables.
5. At request time, scalar columns resolve directly, relations resolve by reading parent keys and running follow-up queries, and `where` clauses turn into Drizzle SQL — including subqueries for nested predicates.

If you added a new column to `todos`, none of this code changes. If you added a new table with a foreign key, also no changes — the auto-FK promotion picks it up. The only time you touch this folder is when you want a new operator, a new filter shape, or a new column type mapping.

That's the whole system.
