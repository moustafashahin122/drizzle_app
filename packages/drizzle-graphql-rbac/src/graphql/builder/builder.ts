/**
 * @module graphql/builder
 *
 * Summary
 * -------
 * Auto-generates an executable {@link GraphQLSchema} from a Drizzle ORM schema
 * module (a `* as schema` namespace of {@link Table} definitions and optional
 * `relations(...)` declarations) bound to a Drizzle DB instance. The output
 * schema exposes per-table CRUD with rich filtering, ordering, and pagination,
 * plus recursive nested-relation traversal.
 *
 * Typical Flow
 * ------------
 * 1. `introspectSchema` walks the schema namespace and produces a
 *    `SchemaIntrospection`: the set of tables (by SQL name and by JS
 *    export key) and a relation map (explicit `relations()` plus auto-detected
 *    single-column FKs, both forward "one" and inverse "many").
 * 2. **Pass 1** (`./builder-types.ts`) — for each table, construct a
 *    {@link GraphQLObjectType} with a *lazy* fields-thunk that mixes scalar
 *    columns and relation fields (so cyclic types resolve through the same
 *    registered object types — this is what enables recursion), plus
 *    `Insert` / `Update` / `OrderBy` input types.
 * 3. **Pass 2** (`./builder-resolvers.ts`) — wire per-table root fields onto
 *    `Query` and `Mutation`:
 *      - `<jsKey>(where?: JSON, orderBy?, limit?, offset?): [<Type>!]!`
 *      - `<jsKey>Single(where?: JSON, orderBy?): <Type>`
 *      - `insertInto<Type>(values: [<Type>Insert!]!): [<Type>!]!`
 *      - `update<Type>(set: <Type>Update!, where?: JSON): [<Type>!]!`
 *      - `deleteFrom<Type>(where?: JSON): [<Type>!]!`
 *    Resolvers translate the `where` JSON via `parseDomain` + `domainToSql`
 *    (from `../domain/domain.js`) and call Drizzle's
 *    `db.select()/insert()/update()/delete()` — mutations use `.returning()`
 *    so they emit the affected rows.
 * 4. Relation fields (`./builder-relations.ts`) resolve recursively through
 *    the same registered ObjectType, with a per-request batch cache that
 *    coalesces sibling lookups into single `WHERE fk IN (...)` queries.
 *
 * Filtering syntax
 * ----------------
 * `where` accepts an Odoo polish-prefix domain array, e.g.
 *   `[["completed", "=", false], ["title", "ilike", "%pr%"]]`
 * combinators `"&"`, `"|"`, `"!"` are prefix operators; the implicit
 * combinator across remaining top-level items is `&` (AND). Dotted fields
 * traverse single-column relations, e.g. `["assigneeId.email", "=", "x@y"]`.
 * The placeholder string `"current_user.id"` is substituted from the
 * GraphQL request context (`gqlCtx.user.id`). Full reference:
 * `../domain/README.md`.
 *
 * Notes
 * -----
 * - A relation field with the same name as a scalar column **replaces** that
 *   column on the **output** type (so `assigneeId { name }` traverses to the
 *   referenced row). The scalar value is still reachable in `set`, Insert,
 *   and Update inputs (and inside a domain leaf, e.g.
 *   `[["assigneeId", "=", 5]]`) because those iterate the unchanged column
 *   map.
 * - Composite foreign keys are skipped by the auto-FK detector; declare
 *   relations explicitly via Drizzle's `relations(...)` for those.
 */
import {
  GraphQLObjectType,
  GraphQLSchema,
  type GraphQLFieldConfigMap,
} from "graphql";
import { getTableName } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { ColumnMap } from "./filters.js";
import { introspectSchema } from "./relations.js";
import { buildTableMeta } from "./builder-types.js";
import { addRootFields } from "./builder-resolvers.js";
import type { DomainContext } from "../domain/domain.js";
import type { DrizzleLike, TableMeta } from "./types.js";

export type { DrizzleLike } from "./types.js";
export type { BatchCache } from "./builder-relations.js";

/**
 * Optional knobs for {@link buildSchema}.
 */
export interface BuildSchemaOptions {
  /**
   * Override the generated GraphQL type name for a given JS schema export key.
   * Default is the capitalized key (e.g. `todos` → `Todos`). The override is
   * also propagated to all per-table input names (`<TypeName>Insert`,
   * `<TypeName>Update`, `<TypeName>Where`, `<TypeName>OrderBy`).
   */
  typeNames?: Record<string, string>;
  /**
   * Per-table list of column field names to omit from the **output** object
   * type. Inputs (`Insert`/`Update`/`Where`) are unaffected — the auto-CRUD
   * surface still reads/writes the column for callers that have it (RBAC will
   * gate those). Use for fields like `passwordHash` that must not leak in
   * query responses but still need to be writable internally.
   */
  hiddenOutputColumns?: Record<string, string[]>;
  /**
   * Extra root Query fields to merge into the schema. Receives the map of
   * generated object types keyed by JS schema key, so callers can compose
   * payloads that reference auto-generated types (e.g. an `AuthPayload` that
   * embeds the `User` object type).
   */
  extraQueryFields?: (
    typesByKey: Record<string, GraphQLObjectType>,
  ) => GraphQLFieldConfigMap<unknown, any>;
  /**
   * Extra root Mutation fields to merge into the schema. Same shape as
   * `extraQueryFields`. If supplied alongside zero auto mutations, a Mutation
   * root is still created.
   */
  extraMutationFields?: (
    typesByKey: Record<string, GraphQLObjectType>,
  ) => GraphQLFieldConfigMap<unknown, any>;
  /**
   * RBAC enforcement hook. Called by every auto-generated CRUD resolver before
   * touching the database. Throws `FORBIDDEN` to deny; returns an optional
   * `where` SQL fragment that the resolver AND-s into its query (record-rule
   * row-level filter). Admin callers receive `{}` (no filter, no throw).
   *
   * `resource` is the table's JS schema key (the same key used for the
   * `Query.<jsKey>` root field).
   *
   * Insert resolvers run the ACL check and, when a create-domain is returned,
   * perform a transactional post-check that re-fetches each inserted row
   * through `(PK AND createWhere)` and rolls back if any row fails to match.
   */
  rbac?: {
    enforce: (
      ctx: any,
      resource: string,
      action: "create" | "read" | "update" | "delete",
      columns: ColumnMap,
    ) => Promise<{ where?: SQL }>;
    /**
     * Per-table opt-out (e.g. for a public `register` flow that needs to
     * insert into `users` without the caller being authenticated). Resolvers
     * for tables in this set skip enforcement entirely.
     */
     bypassResources?: Set<string>;
  };
  /**
   * Maximum number of distinct foreign-key values to include in a single
   * `WHERE pk IN (...)` query issued by the relation batch loader. When more
   * than this many unique keys are queued during a microtask, the loader
   * flushes in chunks of this size. Set to `Infinity` to disable chunking.
   *
   * @default 100
   */
  relationBatchSize?: number;
}

/** Capitalize first character of a string. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Build a GraphQL schema from a Drizzle DB and a Drizzle schema namespace.
 *
 * Walks the schema in two passes (object/input types first, then root fields)
 * so that mutually-referencing relation types can refer to each other's
 * registered {@link GraphQLObjectType}. See the module overview for the full
 * pipeline and recursion guarantees.
 *
 * @param db Drizzle DB instance (any dialect; must expose `select/insert/update/delete`).
 * @param schema Imported schema namespace, e.g. `import * as schema from "./schema.js"`.
 *               Tables and `relations(...)` declarations are detected via Drizzle's
 *               `is(value, Table)` / `is(value, Relations)` brand checks.
 * @param options Optional {@link BuildSchemaOptions} (e.g. type-name overrides).
 * @returns `{ schema }` where `schema` is the executable {@link GraphQLSchema}, ready
 *          to hand to graphql-yoga / Apollo / etc.
 *
 * @example
 * import * as dbSchema from "./schema.js";
 * import { db } from "./db.js";
 * import { buildSchema } from "./graphql/index.js";
 *
 * const { schema } = buildSchema(db, dbSchema);
 * // → exposes Query.todos, Query.todosSingle, Mutation.insertIntoTodos, etc.
 */
export function buildSchema(
  db: DrizzleLike,
  schema: Record<string, unknown>,
  options: BuildSchemaOptions = {},
): { schema: GraphQLSchema } {
  const intro = introspectSchema(schema);
  const metas = new Map<string, TableMeta>(); // keyed by SQL table name

  // Shared DomainContext factory — used by every resolver that translates a
  // JSON domain so dotted-field relation filters resolve to the correct
  // referenced table info. Declared before pass 1 so the closures captured by
  // GraphQL field thunks have a stable reference.
  const domainCtxFor = (meta: TableMeta): DomainContext => ({
    db,
    relations: meta.relations,
    lookup: (refSql) => {
      const m = metas.get(refSql);
      return m && { table: m.table, columns: m.columns, relations: m.relations };
    },
  });

  const relationBatchSize = options.relationBatchSize ?? 100;

  // Pass 1: build object types (with relation field thunks) + input types.
  for (const [jsKey, table] of intro.tablesByKey) {
    const sqlName = getTableName(table);
    const typeName = options.typeNames?.[jsKey] ?? cap(jsKey);
    const hiddenOutput = new Set(options.hiddenOutputColumns?.[jsKey] ?? []);
    const meta = buildTableMeta(
      jsKey,
      table,
      typeName,
      intro,
      metas,
      db,
      domainCtxFor,
      hiddenOutput,
      relationBatchSize,
    );
    metas.set(sqlName, meta);
  }

  // Pass 2: build root Query and Mutation.
  const queryFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  const mutationFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  const rbac = options.rbac;
  for (const meta of metas.values()) {
    addRootFields(meta, queryFields, mutationFields, db, domainCtxFor(meta), rbac);
  }

  if (options.extraQueryFields || options.extraMutationFields) {
    const typesByKey: Record<string, GraphQLObjectType> = {};
    for (const m of metas.values()) typesByKey[m.jsKey] = m.objectType;
    Object.assign(queryFields, options.extraQueryFields?.(typesByKey) ?? {});
    Object.assign(mutationFields, options.extraMutationFields?.(typesByKey) ?? {});
  }

  return {
    schema: new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: queryFields }),
      mutation: Object.keys(mutationFields).length
        ? new GraphQLObjectType({ name: "Mutation", fields: mutationFields })
        : undefined,
    }),
  };
}
