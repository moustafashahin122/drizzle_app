# `graphql/builder` — auto-schema generator

Hand-rolled equivalent of `drizzle-graphql`. Takes a Drizzle DB instance + a
schema namespace (`import * as schema from "../db.js"`) and produces an
executable `GraphQLSchema` with per-table CRUD, filtering, ordering,
pagination, and recursive nested-relation traversal.

This module is the **main** building block of the GraphQL layer. The `rbac/`
module plugs into it through the `rbac` option on `buildSchema`. Authentication
itself is **not** part of the GraphQL surface — it lives behind REST endpoints
under `/auth/*` (see `src/auth/`). The `extraQueryFields` / `extraMutationFields`
hooks remain on `buildSchema` for any future bespoke fields, but are unused by
the default app.

## Files

| File           | Role                                                                                  |
|----------------|---------------------------------------------------------------------------------------|
| `builder.ts`   | The main pipeline: introspect → object/input types → root fields. Public entry point. |
| `relations.ts` | Walks the schema namespace, merges explicit `relations(...)` with auto-detected FKs.  |
| `filters.ts`   | `OrderBy` input type, `applyListArgs`, `combineWhere`. (Where filtering is delegated to `../domain`.) |
| `types.ts`     | Drizzle `Column` → GraphQL scalar/ID mapping + `notNull` wrapping.                    |
| `scalars.ts`   | Custom scalars: `JSON`, `BigIntString`.                                               |
| `util.ts`      | Tiny helpers shared across files (currently just `jsKeyOf`).                          |
| `*.test.ts`    | Node test runner suites — exercise the builder end-to-end through GraphQL queries.    |

## Public API

Re-exported through `src/graphql/index.ts`:

```ts
import { buildSchema, GraphQLJSON, GraphQLBigIntStr } from "./graphql/index.js";
import type { BuildSchemaOptions, DrizzleLike } from "./graphql/index.js";
```

- `buildSchema(db, schema, options?)` → `{ schema: GraphQLSchema }`
- `BuildSchemaOptions` — type-name overrides, hidden output columns, extra
  Query/Mutation fields, RBAC enforce hook.
- `DrizzleLike` — structural type for any dialect-agnostic Drizzle handle.
- `GraphQLJSON`, `GraphQLBigIntStr` — useful when authoring custom resolvers
  that need to refer to the same scalars the builder uses.

## Pipeline at a glance

1. **`introspectSchema`** (`relations.ts`) — collects `Table` values, executes
   each `Relations` config, and auto-promotes single-column FKs into a forward
   "one" + inverse "many". Composite FKs are skipped.
2. **Pass 1** in `buildSchema` — for each table, build the `GraphQLObjectType`
   (lazy fields thunk) plus `<Type>Insert` / `<Type>Update` / `<Type>OrderBy`
   input types. There is **no** `<Type>Where` input — filtering is done via a
   single `JSON` arg carrying an Odoo-style domain.
3. **Pass 2** in `buildSchema` (`addRootFields`) — wire root fields:
   - `Query.<jsKey>(where: JSON, orderBy?, limit?, offset?): [<Type>!]!`
   - `Query.<jsKey>Single(where: JSON, orderBy?): <Type>`
   - `Mutation.insertInto<Type>(values: [<Type>Insert!]!): [<Type>!]!`
   - `Mutation.update<Type>(set: <Type>Update!, where: JSON): [<Type>!]!`
   - `Mutation.deleteFrom<Type>(where: JSON): [<Type>!]!`

Mutations use Drizzle's `.returning()` so resolvers emit the affected rows.

## Filtering — domain syntax

`where` accepts a JSON Odoo-style polish-prefix domain. Examples:

```graphql
# simple
todos(where: [["completed", "=", false]], orderBy: { id: DESC }, limit: 10) { id title }

# multiple leaves AND together implicitly
todos(where: [["completed", "=", false], ["title", "ilike", "%pr%"]]) { title }

# OR combinator (prefix)
todos(where: ["|", ["title", "=", "orphan"], ["assigneeId.email", "ilike", "alice%"]]) { title }

# dotted path traverses a single-column relation as IN-subquery
assignees(where: [["todos.title", "=", "deploy"]]) { name }

# placeholder substituted from gqlCtx.user.id
todos(where: [["ownerId", "=", "current_user.id"]]) { title }
```

Operators: `=`, `!=` (alias `<>`), `>`, `>=`, `<`, `<=`, `in`, `not in`,
`like`, `ilike`, `not like`, `not ilike`, `=?`. Combinators: `&`, `|`, `!`
(prefix). Full reference: `../domain/README.md`.

## Recursion model

A relation field on the output type points at the **same** registered
`GraphQLObjectType` for the referenced table, so `todos { assigneeId { todos
{ assigneeId { name } } } }` works out of the box. The relation field replaces
the same-named scalar on the **output** type only — the scalar is still
reachable inside `where`, `set`, Insert, and Update inputs.

Resolvers issue one query per relation field per parent row by default. When
the GraphQL request context contains a `batch: Map`, single-column
non-paginated relations coalesce sibling lookups into a single
`WHERE fk IN (...)` query (see `BatchCache` and `createRelationLoader` in
`builder.ts`). The `auth/` module installs this map per request.

## RBAC integration

When `options.rbac.enforce` is supplied, every auto-generated CRUD resolver
calls it before touching the database. `enforce` may throw `FORBIDDEN` to
deny, or return an optional `where` SQL fragment that is AND-ed into the
resolver's query (record-rule row-level filter). See `../rbac/README.md` for
how the hook is implemented.
