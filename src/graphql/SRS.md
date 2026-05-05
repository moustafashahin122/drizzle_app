# Software Requirements Specification — `src/graphql`

## 1. Purpose

`src/graphql` auto-generates an executable GraphQL schema from a Drizzle ORM schema namespace and a Drizzle DB instance. It exists so that adding or changing a table in `src/db.ts` requires no hand-written GraphQL types or resolvers — the API surface (queries, mutations, filters, ordering, pagination, relation traversal) is derived at startup.

## 2. Scope

- **In scope:** introspection of Drizzle tables and `relations(...)`; per-table `GraphQLObjectType`, `Insert`, `Update`, `Where`, `OrderBy` inputs; root CRUD fields; recursive nested-relation traversal in selections; nested-relation predicates in filters.
- **Out of scope:** authentication / authorization, rate limiting, request logging, dataloader-style batching, schema stitching, subscriptions, SDL-first definitions, custom user-supplied resolvers.

## 3. Definitions

| Term | Meaning |
|---|---|
| Schema namespace | The `import * as schema from "./db.js"` object — values are Drizzle `Table`s and/or `Relations` declarations. |
| JS key | The string key under which a table is exported in the schema namespace (`todos`, `assignees`). Drives root field naming. |
| Type name | The GraphQL ObjectType name; defaults to `cap(jsKey)` (`Todos`). Overridable via `BuildSchemaOptions.typeNames`. |
| FK relation | A relation derived from a single-column `.references(...)` foreign key. Forward = "one"; inverse = "many". |
| Explicit relation | A relation declared via Drizzle's `relations(table, ({ one, many }) => ({ ... }))`. |

## 4. Functional Requirements

### FR-1 Schema Introspection
- FR-1.1 The system SHALL discover every Drizzle `Table` in the schema namespace via `is(value, Table)` and index it by SQL table name and JS key.
- FR-1.2 The system SHALL discover every `Relations` value via `is(value, Relations)` and execute its config with `createTableRelationsHelpers` to capture `One`/`Many` declarations including `fields` and `references`.
- FR-1.3 The system SHALL detect single-column inline foreign keys across SQLite, Postgres, and MySQL dialects and auto-promote them to a forward "one" relation (named after the FK column's JS key) plus an inverse "many" relation on the referenced table (named after the source table's JS key).
- FR-1.4 Explicit `relations(...)` MUST take precedence over auto-FK relations with the same field name.
- FR-1.5 The system MUST NOT auto-promote composite (multi-column) FKs.
- FR-1.6 When an explicit "one" provides `fields`/`references` and a paired "many" does not, the system SHALL back-fill the "many" with mirrored columns.

### FR-2 Object Types
- FR-2.1 For each table, the system SHALL emit a `GraphQLObjectType` whose fields include every Drizzle column mapped to the corresponding GraphQL type.
- FR-2.2 Primary-key columns MUST map to `ID`; numeric, boolean, JSON, bigint, date/string columns MUST map per the rules in `types.ts`.
- FR-2.3 A column's GraphQL type MUST be wrapped in `NonNull` iff the Drizzle column is `notNull`.
- FR-2.4 A relation field whose name equals an existing column field MUST replace that column on the **output** type; the column SHALL remain accessible on `Where`, Insert, Update, and `set` inputs.
- FR-2.5 The fields configuration MUST be lazy (thunk) to support cyclic relation graphs.

### FR-3 Input Types
- FR-3.1 `<TypeName>Insert`: one field per column. A field is required iff `notNull && !hasDefault && !generated`.
- FR-3.2 `<TypeName>Update`: one optional field per column.
- FR-3.3 `<TypeName>Where`: per-column filter inputs, plus `AND: [Where!]`, `OR: [Where!]`, `NOT: Where`. Recursive via thunk.
- FR-3.4 Per-column filter inputs MUST expose `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `like`, `ilike`, `isNull`.
- FR-3.5 `<TypeName>OrderBy`: one optional field per column, valued by the shared `OrderDirection` enum (`ASC` | `DESC`).

### FR-4 Nested Relation Filters
- FR-4.1 When a column has a same-named single-column relation, the column's filter input MUST also expose the referenced table's `<RefType>Where` fields. Operator names take precedence on collision so the column-op vocabulary stays stable.
- FR-4.2 When a relation does not shadow a column (e.g. inverse `many`), it MUST appear as a plain field on `<TypeName>Where` whose type is `<RefType>Where`.
- FR-4.3 Nested predicates MUST translate to `parent.<localCol> IN (SELECT ref.<remoteCol> FROM ref WHERE inner)` where `inner` is the recursive translation of the nested where.
- FR-4.4 Nested filters MUST be composable with `AND`/`OR`/`NOT` at any depth and on any table.
- FR-4.5 Multi-column relation joins MUST NOT generate nested-filter inputs (skipped silently).
- FR-4.6 An empty inner where (no usable conditions) MUST be omitted from the SQL — it MUST NOT degenerate into "any related row exists".

### FR-5 Root Query Fields
- FR-5.1 `Query.<jsKey>(where, orderBy, limit, offset): [<Type>!]!` — paginated list.
- FR-5.2 `Query.<jsKey>Single(where, orderBy): <Type>` — first match or `null`.
- FR-5.3 List args MUST compose as: filter → order → limit → offset.

### FR-6 Root Mutation Fields
- FR-6.1 `Mutation.insertInto<TypeName>(values: [<Insert>!]!): [<Type>!]!`.
- FR-6.2 `Mutation.update<TypeName>(set: <Update>!, where): [<Type>!]!`.
- FR-6.3 `Mutation.deleteFrom<TypeName>(where): [<Type>!]!`.
- FR-6.4 All mutations MUST use Drizzle's `.returning()` so the affected rows are emitted.
- FR-6.5 If no tables produce mutation fields, the schema MUST omit the `Mutation` root.

### FR-7 Recursive Relation Traversal
- FR-7.1 Each relation field MUST type-reference the same registered `GraphQLObjectType` of the referenced table so arbitrary nested selections work without further registration.
- FR-7.2 "many" relation fields MUST accept `where`, `orderBy`, `limit`, `offset` arguments and apply them composably with the parent-row join condition.
- FR-7.3 If parent local-key columns are `null`/`undefined`, a "one" relation MUST resolve to `null` and a "many" relation to `[]` without issuing a query.

### FR-8 Filter Translation Rules
- FR-8.1 `null`/`undefined`/`{}` `where` → no SQL condition.
- FR-8.2 Multiple operators on the same column → AND-combined.
- FR-8.3 Top-level entries → AND-combined.
- FR-8.4 Unknown column / relation keys MUST be silently ignored — clients MUST NOT be able to synthesize predicates against undeclared fields.

### FR-9 Type-Name Customization
- FR-9.1 `BuildSchemaOptions.typeNames[jsKey]` MUST override the generated GraphQL ObjectType name.
- FR-9.2 The override MUST propagate to all per-table input names (`<TypeName>Insert`, `<TypeName>Update`, `<TypeName>Where`, `<TypeName>OrderBy`, `<TypeName>_<col>_Filter`).

## 5. Non-Functional Requirements

### NFR-1 Dialect Portability
The builder MUST run unchanged on SQLite, Postgres, and MySQL Drizzle drivers. The only hard dependency on dialect features is `.returning()` on mutations.

### NFR-2 Build-Time Performance
Schema construction MUST be O(tables + columns + relations) with no per-request cost beyond what GraphQL execution incurs. All registered types MUST be reused; no per-resolver type construction.

### NFR-3 Query-Time Behaviour
- Each list/single resolver issues exactly one SELECT.
- Each relation field issues one query per parent row (no DataLoader). This is acceptable for the app's scale; document, do not optimize.
- Nested filters add one subquery per nested level, executed in-database.

### NFR-4 Type Safety
The public API (`buildSchema`, `BuildSchemaOptions`, `DrizzleLike`) MUST be fully typed. Internal `any` is acceptable where Drizzle's generic types defeat structural typing.

### NFR-5 Testability
Translator functions (`whereToSql`, `orderByToSql`, `applyListArgs`) MUST be importable and exercisable without spinning up the full schema. End-to-end behavior is verified through `graphql({ schema, source })` calls against an in-memory SQLite.

### NFR-6 No Hidden State
The module MUST NOT register globals, monkey-patch GraphQL, or read environment variables. All inputs flow through `buildSchema(db, schema, options)`.

## 6. Constraints & Assumptions

- C-1 GraphQL field names equal Drizzle JS keys (the keys in the user's `sqliteTable("...", { ... })` definition). The builder relies on this for column lookup in `where` / `orderBy` / `set`.
- C-2 The Drizzle DB instance must expose `select`, `insert`, `update`, `delete` and produce builders that support `.returning()` on mutations.
- C-3 Composite primary keys are accepted on tables but only single-column relations participate in the nested-filter surface.
- C-4 Operator field names (`eq, ne, gt, gte, lt, lte, in, notIn, like, ilike, isNull`) are reserved on per-column filter inputs and shadow same-named referenced-table columns. Naming a column `eq` will cause it to be unreachable through nested filtering on a parent FK.

## 7. Acceptance Criteria

- AC-1 All tests under `src/graphql/*.test.ts` pass.
- AC-2 A schema with two tables joined by a single-column FK exposes: list/single queries, three mutations per table, forward-one + inverse-many relation traversal, and nested filters in both directions.
- AC-3 The translators handle all combinations described in FR-8 and FR-4 without throwing; unknown keys are dropped.
- AC-4 Adding a new table to the Drizzle schema requires no edits inside `src/graphql`.
