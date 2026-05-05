# Software Design Document — `src/graphql`

Companion to [SRS.md](./SRS.md). Describes how the requirements are realised in code.

## 1. Module Layout

```
src/graphql/
├── index.ts       Public entry — re-exports buildSchema + scalars.
├── builder.ts     Two-pass schema construction; root field resolvers.
├── filters.ts     Where / OrderBy input types + SQL translators.
├── relations.ts   Schema introspection; relation graph extraction.
├── types.ts       Drizzle column → GraphQL base-type mapping.
├── scalars.ts     Custom scalars (JSON, BigIntString).
└── util.ts        Tiny helpers (jsKeyOf).
```

Dependency direction is strictly downward: `index → builder → {filters, relations, types, scalars, util}`. `filters.ts` imports `ExtractedRelation` (a type) from `relations.ts`; no other cross-edges exist between leaf modules.

## 2. Data Model

### 2.1 `SchemaIntrospection` (`relations.ts`)
```ts
{
  tables:           Map<sqlName, Table>
  tablesByKey:      Map<jsKey,   Table>
  keyByTableName:   Map<sqlName, jsKey>
  relations:        Map<sqlName, ExtractedRelation[]>
}
```

### 2.2 `ExtractedRelation` (`relations.ts`)
```ts
{
  fieldName:       string        // GraphQL field name on the source object
  kind:            "one" | "many"
  sourceTable:     Table
  referencedTable: Table
  fields?:         Column[]      // local join cols on sourceTable
  references?:     Column[]      // foreign join cols on referencedTable
  relationName?:   string        // pairs one/many sides when ambiguous
}
```
Invariant: `parent.fields[i] === referenced.references[i]` whenever both arrays are populated. The same shape encodes forward FK relations and inverse "many" relations.

### 2.3 `TableMeta` (internal to `builder.ts`)
Per-table working set carried between passes — Drizzle handles + every constructed GraphQL type for that table + the relation array. Keyed by SQL table name in `metas: Map<string, TableMeta>`.

### 2.4 `WhereContext` (`filters.ts`)
```ts
{
  db:        { select(...): any }
  relations: ExtractedRelation[]   // relations on the current table
  lookup:    (refSqlName) => { table, columns, relations } | undefined
}
```
Threaded into every `whereToSql` / `applyListArgs` call so nested-relation predicates can build subqueries against the correct referenced table info, regardless of which resolver dispatched the query.

## 3. Build Pipeline

`buildSchema(db, schema, options)` runs in two passes after introspection.

### 3.1 Introspection
`introspectSchema(schema)`:
1. Walk schema namespace; index every `Table` by SQL name and JS key.
2. Walk again; for every `Relations`, run its config through `createTableRelationsHelpers` and record `One`/`Many` declarations.
3. Walk tables; for each single-column inline FK (read via the dialect-specific `Symbol.for("drizzle:<dialect>InlineForeignKeys")`), auto-promote a forward "one" + inverse "many" unless the field name is already taken by an explicit relation.
4. Back-fill `fields`/`references` on declared "many" relations whose paired "one" supplied them.

### 3.2 Pass 1 — Type Construction
For each `[jsKey, table]`:
- `objectType` — `GraphQLObjectType` with **lazy** `fields` thunk that calls `buildObjectFields(meta, intro, metas, db, whereCtxFor)`. Lazy because cyclic relation types must be able to refer back to types still being constructed.
- `insertInput` / `updateInput` — column-driven; required-field rule applies only to Insert.
- `whereInput` — `buildWhereInput(typeName, columns, { relations, getRefWhereInput })`. The `getRefWhereInput` callback is invoked **inside the fields thunk**, after every table's `whereInput` has been registered, so cyclic where types resolve.
- `orderByInput` — column-driven, single direction enum per field.

Each meta is registered in `metas` keyed by SQL table name.

### 3.3 Pass 2 — Root Fields
For each meta, `addRootFields` attaches:
- `Query.<jsKey>` — list with `(where, orderBy, limit, offset)`.
- `Query.<jsKey>Single` — list-style query capped at `.limit(1)`.
- `Mutation.insertInto<Type>` — `db.insert().values().returning()`.
- `Mutation.update<Type>` — `db.update().set().where().returning()`.
- `Mutation.deleteFrom<Type>` — `db.delete().where().returning()`.

A `WhereContext` is built once per meta (`whereCtxFor(meta)`) and passed into every resolver that runs `whereToSql` / `applyListArgs`.

### 3.4 Where-Input Construction Order

`buildWhereInput` returns immediately with a placeholder `GraphQLInputObjectType`; its real fields are populated lazily by the `fields: () => ...` thunk. Inside the thunk:
1. `AND`, `OR`, `NOT` use `self` directly (recursive reference).
2. For each column, build a `<TableName>_<col>_Filter`:
   - Always include the operator fields.
   - If the column has a same-named single-column relation, **spread the referenced table's where fields into the filter** (operator names win on collision).
3. For each relation that does **not** shadow a column, append a plain field of type `<RefType>Where`.

The two callbacks (`getRefWhereInput`, `whereInput.getFields()`) are only ever invoked after pass 1 finishes, because GraphQL only calls input-type field thunks at first access — usually during request validation, well after `buildSchema` has returned.

## 4. Object-Field Resolution

`buildObjectFields(meta, ...)`:
1. Emit one field per scalar column (`columnToBaseType`, wrapped in `NonNull` per `notNull`).
2. Overlay relation fields. **A relation field replaces a same-named scalar column on the output type** — but only on the output type. The column remains in `meta.columns`, so all input types (`Where`, `Insert`, `Update`, `set`) keep the scalar reachable.

Lazy thunks throughout — referenced object types may not yet exist when this function is referenced.

## 5. Relation Field Resolver

`buildRelationField(rel, parentMeta, refMeta, db, refCtx)` returns a field config:

**Type:**
- "one" → `refMeta.objectType` (nullable).
- "many" → `[<RefType>!]!`.

**Args:**
- "one" → none.
- "many" → `(where, orderBy, limit, offset)` against the referenced table's inputs.

**Resolve:**
1. For each pair `(local[i], remote[i])`, look up the parent's local JS key via `jsKeyOf(parentMeta.columns, local[i])` and read `parent[localKey]`.
2. If any local value is missing → `null` for "one", `[]` for "many".
3. Build join SQL: `and(eq(remote[0], v0), eq(remote[1], v1), ...)`.
4. Run `applyListArgs(db.select().from(refMeta.table), args, refMeta.columns, joinSql, refCtx)` so user-supplied filters compose with the join.
5. Return rows (many) or `rows[0] ?? null` (one).

## 6. Where → SQL Translation

`whereToSql(where, columns, ctx?)`:
- Empty / `null` / `undefined` → `undefined` (no condition).
- For each top-level entry:
  - `AND` / `OR` arrays: recurse, drop falsy results, combine with `and(...)` / `or(...)`.
  - `NOT`: recurse, wrap with `not(...)`.
  - Otherwise the key may be a column, a relation, or both:
    - **Column ops**: switch on `eq/ne/gt/gte/lt/lte/in/notIn/like/ilike/isNull` → corresponding Drizzle helper.
    - **Nested predicate** (column has a same-named relation, or key is a relation-only field): build subquery via `nestedRelationToSql`.
    - When a key is **both** a column and a relation, the value's keys are split — operator names go to the column branch, others to the nested branch.
- Result: single fragment, or `and(...parts)` if more than one, or `undefined` if none.

`nestedRelationToSql(rel, refWhere, ctx)`:
1. Look up referenced table info via `ctx.lookup(getTableName(rel.referencedTable))`.
2. Recursively translate `refWhere` using a new `WhereContext` rooted at the referenced table.
3. If the inner translation is `undefined`, return `undefined` (an empty inner where MUST NOT generate `IN (SELECT col FROM ref)`).
4. Otherwise emit `inArray(rel.fields[0], db.select({__ref: rel.references[0]}).from(refTable).where(inner))`.

Multi-column relations skip nested-filter generation (FR-4.5); they still resolve as join targets in the relation field resolver.

## 7. List-Args Composition

`applyListArgs(query, args, columns, extraWhere?, ctx?)`:
1. `userWhere = whereToSql(args.where, columns, ctx)`.
2. `combined = and(extraWhere, userWhere)` (whichever subset is defined).
3. `query.where(combined).orderBy(...orderByToSql(args.orderBy, columns)).limit(...).offset(...)`.
4. Returns the same builder instance — caller can chain (`.limit(1)` for Single).

`extraWhere` is the relation-join condition supplied by `buildRelationField`; it is always AND-combined with the caller's filter.

## 8. Type Mapping

`columnToBaseType(col)`:
- `primary` → `ID` (regardless of underlying type).
- `dataType: "number"` with column type matching `/real|double|float|decimal|numeric/i` → `Float`.
- `dataType: "number"` otherwise → `Int`.
- `dataType: "bigint"` → `BigIntString` (custom scalar).
- `dataType: "boolean"` → `Boolean`.
- `dataType: "json" | "array"` → `JSON` (custom scalar).
- Any string-like / fallback → `String`.

`wrapNonNull(type, notNull)` applies `NonNull` only on the **output** side (and on Insert when the required-field rule fires). Where / OrderBy / Update inputs keep all fields optional.

## 9. Cycle & Recursion Story

Every cycle hazard is broken by lazy field thunks:
- `GraphQLObjectType.fields: () => ...` for object types.
- `GraphQLInputObjectType.fields: () => ...` for `<TypeName>Where` and per-column filter inputs.

Both thunks are first invoked at GraphQL request-validation time, never during `buildSchema`. By then `metas` is fully populated and every cross-reference resolves.

This is what enables:
- `todos { assigneeId { todos { assigneeId { name } } } }` recursive selections.
- `where: { assigneeId: { todos: { title: { eq: "..." } } } }` recursive filters.
- Cyclic input-type registration (`TodosWhere` ↔ `AssigneesWhere`).

## 10. Error Handling Philosophy

- Unknown columns / relations / operator keys are **dropped silently**. Validation against the published schema happens at GraphQL parse/validation time (before resolvers run); if anything reaches a translator, treat it as benign noise.
- Resolvers do not catch DB errors — they bubble up so graphql-yoga returns a structured error response.
- Empty inputs (`{}`, `null`, `undefined`) translate to no-op SQL clauses, never to "match nothing" / "match all" hard-coded predicates.

## 11. Extensibility Hooks

| Extension | How |
|---|---|
| Override a generated type name | `buildSchema(db, schema, { typeNames: { jsKey: "MyName" } })`. |
| Add a new column type | Extend `columnToBaseType` in `types.ts`. |
| Add a new filter operator | Add the field in `buildColumnFilterInput` and the case in `whereToSql`. Update `COLUMN_OPS` so it isn't routed to the nested-predicate branch. |
| Add a new scalar | Define in `scalars.ts`, re-export through `index.ts`, return it from `columnToBaseType`. |
| Override resolver logic | Out of scope today — would require introducing an options hook on `BuildSchemaOptions`. |

## 12. Testing Strategy

- **Translator unit tests** (`filters.test.ts`): `whereToSql`, `orderByToSql`, `applyListArgs` exercised in isolation against in-memory SQLite — no GraphQL needed.
- **Introspection unit tests** (`relations.test.ts`): tables-by-key indexing, FK auto-detection (forward + inverse), explicit-relations precedence, `fields`/`references` back-fill.
- **End-to-end schema tests** (`builder.test.ts`): exercise the published schema through `graphql({ schema, source })`. Covers root surface, list/single queries, mutations round-trip, recursive relation traversal, and nested relation filters (FR-4 in all forms).
- All tests use Node's built-in `node:test` runner; no Jest / Mocha. Run via `npm test`.

## 13. Known Limits & Future Work

- No DataLoader batching → "many" relations on N parents issue N queries.
- Composite-column relations have no nested-filter surface (joins still resolve).
- No projection: relation resolvers `SELECT *` from the referenced table even when the GraphQL selection asks for only one field.
- `ilike` is emitted unchanged on dialects that lack it (e.g. SQLite). Callers must avoid it on those backends.
- No customization hook for resolvers; the only extensibility today is `typeNames`.
