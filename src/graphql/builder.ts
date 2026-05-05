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
 * 1. {@link introspectSchema} walks the schema namespace and produces a
 *    {@link SchemaIntrospection}: the set of tables (by SQL name and by JS
 *    export key) and a relation map (explicit `relations()` plus auto-detected
 *    single-column FKs, both forward "one" and inverse "many").
 * 2. **Pass 1** — for each table, {@link buildSchema} constructs:
 *      - a {@link GraphQLObjectType} with a *lazy* fields-thunk that mixes
 *        scalar columns and relation fields (so cyclic types resolve through
 *        the same registered object types — this is what enables recursion);
 *      - an `Insert` input ({@link buildInsertInput}) — required = `notNull &&
 *        !hasDefault && !generated`;
 *      - an `Update` input ({@link buildUpdateInput}) — every column optional;
 *      - a `Where` input and `OrderBy` input from {@link buildWhereInput} /
 *        {@link buildOrderByInput} in `./filters.js`.
 * 3. **Pass 2** — {@link addRootFields} wires per-table root fields onto
 *    `Query` and `Mutation`:
 *      - `<jsKey>(where?, orderBy?, limit?, offset?): [<Type>!]!`
 *      - `<jsKey>Single(where?, orderBy?): <Type>`
 *      - `insertInto<Type>(values: [<Type>Insert!]!): [<Type>!]!`
 *      - `update<Type>(set: <Type>Update!, where?): [<Type>!]!`
 *      - `deleteFrom<Type>(where?): [<Type>!]!`
 * 4. Resolvers translate inputs through {@link whereToSql} / {@link orderByToSql}
 *    and call Drizzle's `db.select()/insert()/update()/delete()` — mutations use
 *    `.returning()` so they emit the affected rows.
 *
 * Recursive relation resolution
 * -----------------------------
 * Each relation field on a parent {@link GraphQLObjectType} resolves by reading
 * the parent row's local columns and querying the referenced table with `eq()`
 * conditions joined to any `where` the caller passed at the relation site.
 * Because the relation field's `type` references the **same** registered
 * `GraphQLObjectType` for the referenced table, GraphQL execution naturally
 * recurses into nested relations on that type — so e.g. `todos { assigneeId {
 * todos { assigneeId { name } } } }` works out of the box without any extra
 * registration. See {@link buildRelationField}.
 *
 * Notes
 * -----
 * - A relation field with the same name as a scalar column **replaces** that
 *   column on the **output** type (so `assigneeId { name }` traverses to the
 *   referenced row). The scalar value is still reachable in `where`, `set`,
 *   Insert, and Update inputs because those iterate the unchanged column map.
 * - The relation resolver issues one query per relation field per parent row
 *   (no DataLoader batching). Acceptable for small/medium response sizes;
 *   batch externally if needed.
 * - Composite foreign keys are skipped by the auto-FK detector; declare
 *   relations explicitly via Drizzle's `relations(...)` for those.
 */
import {
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLInt,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfigMap,
} from "graphql";
import {
  and,
  eq,
  getTableColumns,
  getTableName,
  inArray,
  type SQL,
} from "drizzle-orm";
import {
  applyListArgs,
  buildOrderByInput,
  buildWhereInput,
  whereToSql,
  type ColumnMap,
  type WhereContext,
} from "./filters.js";
import { introspectSchema, type ExtractedRelation } from "./relations.js";
import { columnToBaseType, wrapNonNull } from "./types.js";
import { jsKeyOf } from "./util.js";

/**
 * Structural shape of a Drizzle DB instance accepted by {@link buildSchema}.
 *
 * Any object exposing the standard Drizzle query builders (`select`, `insert`,
 * `update`, `delete`) is acceptable — works across SQLite, Postgres, and MySQL
 * dialects. Mutations rely on `.returning()` being available on the dialect.
 */
export interface DrizzleLike {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
}

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
}

/** Capitalize first character of a string. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Internal per-table working set carried between passes of {@link buildSchema}.
 *
 * Holds both the Drizzle handles (table reference, columns, primary-key columns)
 * and the GraphQL types derived from them so that root resolvers and relation
 * resolvers can refer back to the same constructed types.
 */
interface TableMeta {
  /** JS export key in the user's schema namespace (also the root query field name). */
  jsKey: string;
  /** GraphQL ObjectType name (defaults to `cap(jsKey)`; mutations are named `insertInto<typeName>`, etc.). */
  typeName: string;
  /** Drizzle table reference, passed through to query builders. */
  table: any;
  /** Map of GraphQL field name → Drizzle Column (the field name equals the Drizzle JS key). */
  columns: ColumnMap;
  /** Relations declared on this table (forward + inverse, after introspection). */
  relations: ExtractedRelation[];
  objectType: GraphQLObjectType;
  insertInput: GraphQLInputObjectType;
  updateInput: GraphQLInputObjectType;
  whereInput: GraphQLInputObjectType;
  orderByInput: GraphQLInputObjectType;
}

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

  // Shared {@link WhereContext} factory — used by every resolver that runs
  // `whereToSql` / `applyListArgs` so nested relation filters resolve to the
  // correct referenced table info regardless of which root or relation
  // resolver dispatched the query. Declared before pass 1 so the closures
  // captured by GraphQL field thunks have a stable reference.
  const whereCtxFor = (meta: TableMeta): WhereContext => ({
    db,
    relations: meta.relations,
    lookup: (refSql) => {
      const m = metas.get(refSql);
      return m && { table: m.table, columns: m.columns, relations: m.relations };
    },
  });

  // Pass 1: build object types (with relation field thunks) + input types.
  for (const [jsKey, table] of intro.tablesByKey) {
    const sqlName = getTableName(table);
    const typeName = options.typeNames?.[jsKey] ?? cap(jsKey);
    const columns = getTableColumns(table) as ColumnMap;
    const relations = intro.relations.get(sqlName) ?? [];

    const objectType = new GraphQLObjectType({
      name: typeName,
      fields: () => buildObjectFields(meta, intro, metas, db, whereCtxFor),
    });
    const insertInput = buildInsertInput(typeName, columns);
    const updateInput = buildUpdateInput(typeName, columns);
    const whereInput = buildWhereInput(typeName, columns, {
      relations,
      // Lazy lookup — fired inside the where input's fields thunk, after every
      // table's whereInput has been registered in `metas`.
      getRefWhereInput: (refSql) => metas.get(refSql)?.whereInput,
    });
    const orderByInput = buildOrderByInput(typeName, columns);

    const meta: TableMeta = {
      jsKey,
      typeName,
      table,
      columns,
      relations,
      objectType,
      insertInput,
      updateInput,
      whereInput,
      orderByInput,
    };
    metas.set(sqlName, meta);
  }

  // Pass 2: build root Query and Mutation.
  const queryFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  const mutationFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  for (const meta of metas.values()) {
    addRootFields(meta, queryFields, mutationFields, db, whereCtxFor(meta));
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

/**
 * Build the `<TypeName>Insert` input. Each field is required iff the column is
 * `notNull` AND has no default AND is not generated — defaults are passed
 * through to the database when the field is omitted at the GraphQL layer.
 */
function buildInsertInput(typeName: string, columns: ColumnMap): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${typeName}Insert`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const [name, col] of Object.entries(columns)) {
        const c: any = col;
        const required = c.notNull && !c.hasDefault && !(c as any).generated;
        const base = columnToBaseType(col);
        fields[name] = { type: wrapNonNull(base, required) };
      }
      return fields;
    },
  });
}

/**
 * Build the `<TypeName>Update` input. Every column field is optional so callers
 * can pass partial updates; only provided fields are sent to `db.update().set()`.
 */
function buildUpdateInput(typeName: string, columns: ColumnMap): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${typeName}Update`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const [name, col] of Object.entries(columns)) {
        fields[name] = { type: columnToBaseType(col) };
      }
      return fields;
    },
  });
}

/**
 * Lazy fields-thunk used by every per-table {@link GraphQLObjectType}.
 *
 * Emits one field per scalar column (default resolver reads from the source
 * row), then overlays relation fields. A relation field with the same name as
 * a scalar column **replaces** the scalar on the output type (the scalar value
 * is still reachable through `where` / `set` / Insert / Update inputs).
 *
 * Called via the GraphQL `fields: () => ...` thunk so that referenced object
 * types created in the same pass can be referenced before they are fully
 * registered — this is what enables cyclic relation types and recursive
 * traversal.
 */
function buildObjectFields(
  meta: TableMeta,
  intro: ReturnType<typeof introspectSchema>,
  metas: Map<string, TableMeta>,
  db: DrizzleLike,
  whereCtxFor: (m: TableMeta) => WhereContext,
): GraphQLFieldConfigMap<any, any> {
  const fields: GraphQLFieldConfigMap<any, any> = {};
  for (const [name, col] of Object.entries(meta.columns)) {
    fields[name] = {
      type: wrapNonNull(columnToBaseType(col), (col as any).notNull),
      resolve: (src) => src?.[name],
    };
  }

  const sqlName = getTableName(meta.table);
  const rels = intro.relations.get(sqlName) ?? [];
  for (const rel of rels) {
    const refMeta = metas.get(getTableName(rel.referencedTable));
    if (!refMeta) continue;
    // Relation field replaces a same-named scalar column on the output type.
    // The scalar FK column remains usable in `where` / `set` / Insert / Update inputs
    // because those input types iterate the column map, which is unchanged.
    fields[rel.fieldName] = buildRelationField(rel, meta, refMeta, db, whereCtxFor(refMeta));
  }
  return fields;
}

/**
 * Build a relation field config for a parent table.
 *
 * "one" relations resolve to the single referenced row (or `null`); "many"
 * relations resolve to a non-null list and accept their own `where`,
 * `orderBy`, `limit`, `offset` arguments — composable with any conditions
 * implied by the parent row's local key. Both kinds resolve recursively
 * because the field's GraphQL type is the same registered ObjectType used at
 * the root, so nested selections traverse through {@link buildObjectFields}
 * again.
 *
 * Local/foreign columns come from the {@link ExtractedRelation} — populated
 * by {@link introspectSchema} from explicit `relations(...)` declarations,
 * auto-detected inline FKs (forward and inverse), or back-fill from a paired
 * `one`/`many` declaration. If a relation reaches this resolver without
 * resolved columns, it means the schema can't actually express the join, and
 * the field returns `null` / `[]` rather than guessing.
 */
function buildRelationField(
  rel: ExtractedRelation,
  parentMeta: TableMeta,
  refMeta: TableMeta,
  db: DrizzleLike,
  refCtx: WhereContext,
): GraphQLFieldConfig<any, any> {

  const isMany = rel.kind === "many";
  const baseType = isMany
    ? new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(refMeta.objectType)))
    : refMeta.objectType;

  return {
    type: baseType,
    args: isMany
      ? {
          where: { type: refMeta.whereInput },
          orderBy: { type: refMeta.orderByInput },
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        }
      : undefined,
    resolve: async (parent, args, context) => {
      const localCols = rel.fields;
      const refCols = rel.references;
      if (!localCols?.length || !refCols?.length) return isMany ? [] : null;

      const keys: unknown[] = [];
      for (let i = 0; i < refCols.length; i++) {
        const localKey = jsKeyOf(parentMeta.columns, localCols[i]);
        if (!localKey) return isMany ? [] : null;
        const v = parent?.[localKey];
        if (v === undefined || v === null) return isMany ? [] : null;
        keys.push(v);
      }

      // Batch when (a) we have a per-request cache, (b) the join is single-column,
      // and (c) we don't need per-parent limit/offset (those can't be expressed
      // as a single IN-query without window functions / lateral joins).
      const batch: BatchCache | undefined = context?.batch;
      const canBatch =
        !!batch &&
        refCols.length === 1 &&
        !(isMany && (args?.limit != null || args?.offset != null));

      if (!canBatch) {
        const conds: SQL[] = [];
        for (let i = 0; i < refCols.length; i++) conds.push(eq(refCols[i], keys[i] as any));
        const joinSql = conds.length === 1 ? conds[0] : and(...conds);
        const rows = await applyListArgs(
          db.select().from(refMeta.table as any),
          args,
          refMeta.columns,
          joinSql,
          refCtx,
        );
        return isMany ? rows : rows[0] ?? null;
      }

      const cacheKey = `${getTableName(parentMeta.table)}.${rel.fieldName}|${
        isMany ? "many" : "one"
      }|${JSON.stringify(args?.where ?? null)}|${JSON.stringify(args?.orderBy ?? null)}`;
      let loader = batch!.get(cacheKey) as RelationLoader | undefined;
      if (!loader) {
        loader = createRelationLoader(rel, refMeta, db, refCtx, isMany, args);
        batch!.set(cacheKey, loader);
      }
      return loader.load(keys[0]);
    },
  };
}

/**
 * Per-request batch cache. The GraphQL execution layer hands a fresh `Map` (on
 * the context's `batch` field) to each request; relation resolvers stash one
 * loader per `(parentTable, relation, args)` key in it so sibling parent rows
 * coalesce their child lookups into a single `WHERE fk IN (...)` query.
 */
export type BatchCache = Map<string, unknown>;

interface RelationLoader {
  load(key: unknown): Promise<unknown>;
}

/**
 * Build a DataLoader-style batched loader for a relation field.
 *
 * Parent resolvers all `await load(key)` synchronously within a tick; the
 * loader queues their keys, then on the next microtask runs a single
 * `SELECT ... WHERE refCol IN (queuedKeys)` query (composed with any caller
 * `where`/`orderBy`), groups rows by `refCol`, and resolves each pending
 * promise with that parent's slice (one row for `one` relations, an array for
 * `many`). All callers sharing the cache key see the same loader, so siblings
 * with identical args coalesce into a single round-trip.
 */
function createRelationLoader(
  rel: ExtractedRelation,
  refMeta: TableMeta,
  db: DrizzleLike,
  refCtx: WhereContext,
  isMany: boolean,
  args: any,
): RelationLoader {
  const refCol = rel.references![0];
  const refKeyName = jsKeyOf(refMeta.columns, refCol);
  type Pending = { key: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
  let queue: Pending[] = [];
  let scheduled = false;

  const flush = async () => {
    const pending = queue;
    queue = [];
    scheduled = false;
    try {
      if (!refKeyName) {
        for (const p of pending) p.resolve(isMany ? [] : null);
        return;
      }
      const uniqueKeys = Array.from(new Set(pending.map((p) => p.key)));
      const joinSql = inArray(refCol, uniqueKeys as any[]);
      const rows: any[] = await applyListArgs(
        db.select().from(refMeta.table as any),
        // limit/offset are dropped at the per-batch level (they were only
        // safe to apply per-parent, which the canBatch gate already excluded
        // for `many` relations; for `one` relations args is undefined).
        args ? { where: args.where, orderBy: args.orderBy } : undefined,
        refMeta.columns,
        joinSql,
        refCtx,
      );
      if (isMany) {
        const buckets = new Map<unknown, any[]>();
        for (const row of rows) {
          const k = row[refKeyName];
          let arr = buckets.get(k);
          if (!arr) buckets.set(k, (arr = []));
          arr.push(row);
        }
        for (const p of pending) p.resolve(buckets.get(p.key) ?? []);
      } else {
        const byKey = new Map<unknown, any>();
        for (const row of rows) {
          const k = row[refKeyName];
          if (!byKey.has(k)) byKey.set(k, row);
        }
        for (const p of pending) p.resolve(byKey.get(p.key) ?? null);
      }
    } catch (err) {
      for (const p of pending) p.reject(err);
    }
  };

  return {
    load(key) {
      return new Promise((resolve, reject) => {
        queue.push({ key, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      });
    },
  };
}

/**
 * Attach the standard CRUD root fields for a table to the Query and Mutation
 * field maps:
 *
 * - `Query.<jsKey>(where?, orderBy?, limit?, offset?): [<Type>!]!`
 * - `Query.<jsKey>Single(where?, orderBy?): <Type>` (returns first match or null)
 * - `Mutation.insertInto<TypeName>(values: [<Type>Insert!]!): [<Type>!]!`
 * - `Mutation.update<TypeName>(set: <Type>Update!, where?): [<Type>!]!`
 * - `Mutation.deleteFrom<TypeName>(where?): [<Type>!]!`
 *
 * All mutation resolvers use Drizzle's `.returning()` so the response contains
 * the affected rows directly.
 */
function addRootFields(
  meta: TableMeta,
  queryFields: GraphQLFieldConfigMap<unknown, unknown>,
  mutationFields: GraphQLFieldConfigMap<unknown, unknown>,
  db: DrizzleLike,
  ctx: WhereContext,
) {
  queryFields[meta.jsKey] = buildListQueryField(meta, db, ctx);
  queryFields[`${meta.jsKey}Single`] = buildSingleQueryField(meta, db, ctx);
  mutationFields[`insertInto${meta.typeName}`] = buildInsertMutationField(meta, db);
  mutationFields[`update${meta.typeName}`] = buildUpdateMutationField(meta, db, ctx);
  mutationFields[`deleteFrom${meta.typeName}`] = buildDeleteMutationField(meta, db, ctx);
}

/** Non-null list of the table's object type — used as the return type of all list/mutation root fields. */
function listType(meta: TableMeta) {
  return new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(meta.objectType)));
}

/** Standard `(where?, orderBy?, limit?, offset?)` arg map for list queries. */
function listArgsConfig(meta: TableMeta) {
  return {
    where: { type: meta.whereInput },
    orderBy: { type: meta.orderByInput },
    limit: { type: GraphQLInt },
    offset: { type: GraphQLInt },
  };
}

/** `Query.<jsKey>(where?, orderBy?, limit?, offset?)` — paginated list. */
function buildListQueryField(
  meta: TableMeta,
  db: DrizzleLike,
  ctx: WhereContext,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: listType(meta),
    args: listArgsConfig(meta),
    resolve: (_, args) =>
      applyListArgs(db.select().from(meta.table), args, meta.columns, undefined, ctx),
  };
}

/** `Query.<jsKey>Single(where?, orderBy?)` — first matching row or null. */
function buildSingleQueryField(
  meta: TableMeta,
  db: DrizzleLike,
  ctx: WhereContext,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: meta.objectType,
    args: { where: { type: meta.whereInput }, orderBy: { type: meta.orderByInput } },
    resolve: async (_, args) => {
      const rows = await applyListArgs(
        db.select().from(meta.table),
        args,
        meta.columns,
        undefined,
        ctx,
      ).limit(1);
      return rows[0] ?? null;
    },
  };
}

/** `Mutation.insertInto<TypeName>(values)` — bulk insert, returns inserted rows. */
function buildInsertMutationField(meta: TableMeta, db: DrizzleLike): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: listType(meta),
    args: {
      values: {
        type: new GraphQLNonNull(
          new GraphQLList(new GraphQLNonNull(meta.insertInput)),
        ),
      },
    },
    resolve: async (_, args) =>
      db.insert(meta.table).values(args.values).returning(),
  };
}

/** `Mutation.update<TypeName>(set, where?)` — partial update, returns affected rows. */
function buildUpdateMutationField(
  meta: TableMeta,
  db: DrizzleLike,
  ctx: WhereContext,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: listType(meta),
    args: {
      set: { type: new GraphQLNonNull(meta.updateInput) },
      where: { type: meta.whereInput },
    },
    resolve: async (_, args) =>
      db
        .update(meta.table)
        .set(args.set)
        .where(whereToSql(args?.where, meta.columns, ctx))
        .returning(),
  };
}

/** `Mutation.deleteFrom<TypeName>(where?)` — delete by predicate, returns deleted rows. */
function buildDeleteMutationField(
  meta: TableMeta,
  db: DrizzleLike,
  ctx: WhereContext,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: listType(meta),
    args: { where: { type: meta.whereInput } },
    resolve: async (_, args) =>
      db
        .delete(meta.table)
        .where(whereToSql(args?.where, meta.columns, ctx))
        .returning(),
  };
}
