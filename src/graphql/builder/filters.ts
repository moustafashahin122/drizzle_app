/**
 * @module graphql/filters
 *
 * Summary
 * -------
 * Per-table `Where` and `OrderBy` GraphQL input types plus the runtime
 * translators that turn user-supplied input values into Drizzle SQL fragments.
 * Used by both root resolvers (list/single/update/delete) and "many" relation
 * resolvers (which let callers narrow nested lists with the same filter
 * vocabulary).
 *
 * Filter vocabulary
 * -----------------
 * - Per column: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `like`,
 *   `ilike`, `isNull`.
 * - Logical combinators at the top level of `Where`: `AND: [..]`, `OR: [..]`,
 *   `NOT: { .. }`.
 * - Multiple operators on the same column AND together
 *   (e.g. `{ id: { gt: 5, lt: 10 } }`).
 * - Nested relation predicates: when a relation field name shadows a column
 *   (e.g. an FK column `assigneeId`) the per-column filter input also exposes
 *   the referenced table's where fields, so callers can write
 *   `{ assigneeId: { email: { eq: "x@y" } } }`. Relations that don't shadow a
 *   column (e.g. an inverse `many` like `todos` on `assignees`) appear as
 *   plain fields whose type is the referenced table's `<RefType>Where`.
 *   Translated to `parent.<localCol> IN (SELECT ref.<remoteCol> FROM ref WHERE …)`.
 *
 * `OrderBy` is an object with one direction per column:
 * `{ id: DESC, title: ASC }`. Direction values come from the shared
 * `OrderDirection` enum.
 */
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLInputFieldConfigMap,
  type GraphQLInputType,
} from "graphql";
import {
  and,
  asc,
  desc,
  eq,
  getTableName,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  type Column,
  type SQL,
} from "drizzle-orm";
import { columnToBaseType } from "./types.js";
import type { ExtractedRelation } from "./relations.js";

/**
 * Map of GraphQL field name → Drizzle Column for one table.
 *
 * Throughout the builder the GraphQL field name is identical to the Drizzle
 * JS key (the keys in your `sqliteTable("...", { ... })` definition), so
 * resolvers can look up the column directly by the GraphQL field a caller
 * sends in `where` / `orderBy` / `set`.
 */
export interface ColumnMap {
  [gqlField: string]: Column;
}

/** Operator field names recognised on a per-column filter input. */
const COLUMN_OPS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "like",
  "ilike",
  "isNull",
]);

/**
 * Minimal Drizzle handle needed to materialise a subquery used by nested
 * relation filters. Kept structural here to avoid a circular import with
 * `builder.ts`.
 */
export interface DrizzleSelect {
  select: (...args: any[]) => any;
}

/**
 * Per-table info {@link whereToSql} needs to translate nested relation
 * predicates into `IN (subquery)` fragments. Looked up by SQL table name.
 */
export interface WhereTableInfo {
  table: any;
  columns: ColumnMap;
  relations: ExtractedRelation[];
}

/**
 * Context that lets {@link whereToSql} resolve nested relation filters. When
 * absent, only column-level filtering and AND/OR/NOT are applied — the
 * translator silently ignores any nested-relation keys, which keeps callers
 * that don't care about relations (e.g. unit tests) free of plumbing.
 */
export interface WhereContext {
  db: DrizzleSelect;
  /** Relations declared on the table that owns the current `where` input. */
  relations: ExtractedRelation[];
  /** Resolve a referenced table's info by its SQL table name. */
  lookup: (refSqlName: string) => WhereTableInfo | undefined;
}

/**
 * Build the shared `OrderDirection` GraphQL enum (`ASC` / `DESC`).
 *
 * Exported for callers that want to compose their own input types using the
 * same direction vocabulary; the builder caches a single instance internally
 * via {@link orderDirectionEnum}.
 */
export function buildOrderDirectionEnum(): GraphQLEnumType {
  return new GraphQLEnumType({
    name: "OrderDirection",
    values: { ASC: { value: "asc" }, DESC: { value: "desc" } },
  });
}

const orderDirectionEnum = buildOrderDirectionEnum();

/**
 * Build the recursive `<TypeName>Where` input for a table.
 *
 * The input type self-references through its `AND` / `OR` / `NOT` combinators
 * (defined inside the lazy fields-thunk to allow the recursive use). One
 * column-filter sub-input is generated per column via
 * {@link buildColumnFilterInput}.
 *
 * When `opts.relations` is supplied, each relation whose join uses a single
 * column (single-column FKs and explicit `relations()` with one-element
 * `fields`/`references`) contributes a nested-filter surface:
 * - If the relation field shadows a column (typical for forward-FK relations
 *   like `assigneeId`), the referenced table's `<RefType>Where` fields are
 *   merged into that column's filter input alongside the column operators.
 * - Otherwise, the relation is added as a plain field whose type is the
 *   referenced `<RefType>Where`.
 *
 * @param tableName GraphQL ObjectType name; used as the prefix for `<...>Where`
 *                  and per-column filter input names.
 * @param columns The table's GraphQL-field → column map.
 * @param opts Optional relations + a `getRefWhereInput(refSqlName)` lookup
 *             that returns the referenced table's already-constructed
 *             `<RefType>Where` input (called lazily inside the fields thunk
 *             so cyclic schemas resolve naturally).
 */
export function buildWhereInput(
  tableName: string,
  columns: ColumnMap,
  opts?: {
    relations?: ExtractedRelation[];
    getRefWhereInput?: (refTableSqlName: string) => GraphQLInputObjectType | undefined;
  },
): GraphQLInputObjectType {
  const self: GraphQLInputObjectType = new GraphQLInputObjectType({
    name: `${tableName}Where`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {
        AND: { type: new GraphQLList(new GraphQLNonNull(self)) },
        OR: { type: new GraphQLList(new GraphQLNonNull(self)) },
        NOT: { type: self },
      };

      const singleColRels = (opts?.relations ?? []).filter(
        (r) =>
          r.fields?.length === 1 && r.references?.length === 1,
      );
      const relsByName = new Map<string, ExtractedRelation>();
      for (const r of singleColRels) relsByName.set(r.fieldName, r);

      for (const [name, col] of Object.entries(columns)) {
        const rel = relsByName.get(name);
        const refWhere = rel
          ? opts?.getRefWhereInput?.(getTableName(rel.referencedTable))
          : undefined;
        fields[name] = {
          type: buildColumnFilterInput(tableName, name, col, refWhere),
        };
      }

      // Relations that don't shadow a column (e.g. inverse `many` like
      // `todos` on `assignees`) get a plain ref-where field.
      for (const [relName, rel] of relsByName) {
        if (columns[relName]) continue;
        const refWhere = opts?.getRefWhereInput?.(getTableName(rel.referencedTable));
        if (refWhere) fields[relName] = { type: refWhere };
      }

      return fields;
    },
  });
  return self;
}

/**
 * Build a per-column `<TableName>_<fieldName>_Filter` input exposing the
 * standard operator set. All operator fields are optional; multiple operators
 * on the same column are AND-combined by {@link whereToSql}.
 *
 * When `refWhere` is provided (the column has a same-named single-column
 * relation), the referenced table's where fields are spread alongside the
 * operators so callers can mix forms in a single filter object —
 * `{ assigneeId: { eq: 1, email: { ilike: "%@x" } } }` is valid. Operator
 * names always win on collision so the column-op vocabulary stays stable.
 */
function buildColumnFilterInput(
  tableName: string,
  fieldName: string,
  col: Column,
  refWhere?: GraphQLInputObjectType,
): GraphQLInputObjectType {
  const base = columnToBaseType(col) as GraphQLInputType;
  return new GraphQLInputObjectType({
    name: `${tableName}_${fieldName}_Filter`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {
        eq: { type: base },
        ne: { type: base },
        gt: { type: base },
        gte: { type: base },
        lt: { type: base },
        lte: { type: base },
        in: { type: new GraphQLList(new GraphQLNonNull(base)) },
        notIn: { type: new GraphQLList(new GraphQLNonNull(base)) },
        like: { type: base },
        ilike: { type: base },
        isNull: { type: GraphQLBoolean },
      };
      if (refWhere) {
        for (const [k, f] of Object.entries(refWhere.getFields())) {
          if (k in fields) continue;
          fields[k] = { type: f.type };
        }
      }
      return fields;
    },
  });
}

/**
 * Build the `<TypeName>OrderBy` input — one optional field per column whose
 * value is an {@link orderDirectionEnum} (`ASC` / `DESC`). Unspecified columns
 * are not added to the SQL ORDER BY clause.
 */
export function buildOrderByInput(tableName: string, columns: ColumnMap): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${tableName}OrderBy`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const name of Object.keys(columns)) {
        fields[name] = { type: orderDirectionEnum };
      }
      return fields;
    },
  });
}

/**
 * Build a nested-relation predicate fragment.
 *
 * Produces `parent.<localCol> IN (SELECT ref.<remoteCol> FROM ref WHERE inner)`,
 * where `inner` is the recursive translation of `refWhere` against the
 * referenced table's columns and relations. Returns `undefined` when the
 * inner where supplies no usable conditions, so the caller can drop the
 * predicate entirely rather than emitting `IN (SELECT col FROM ref)` (which
 * would otherwise filter to "any row exists" instead of being a no-op).
 */
function nestedRelationToSql(
  rel: ExtractedRelation,
  refWhere: Record<string, any>,
  ctx: WhereContext,
): SQL | undefined {
  if (!rel.fields?.length || !rel.references?.length) return undefined;
  const refInfo = ctx.lookup(getTableName(rel.referencedTable));
  if (!refInfo) return undefined;
  const inner = whereToSql(refWhere, refInfo.columns, {
    db: ctx.db,
    relations: refInfo.relations,
    lookup: ctx.lookup,
  });
  if (!inner) return undefined;
  const localCol = rel.fields[0];
  const remoteCol = rel.references[0];
  const sub = ctx.db.select({ __ref: remoteCol }).from(refInfo.table).where(inner);
  return inArray(localCol, sub);
}

/**
 * Translate a runtime `Where` input value into a Drizzle SQL condition.
 *
 * Rules:
 * - `null` / `undefined` input → no condition (`undefined` returned).
 * - Top-level `AND`/`OR` arrays recurse, dropping empty/`undefined` sub-results.
 * - Top-level `NOT` recurses and wraps with `not(...)`.
 * - Per-column entries iterate operator keys and append one SQL fragment per
 *   operator (multiple operators on the same column AND together). When a
 *   column has a same-named relation and `ctx` is supplied, any non-operator
 *   keys on the same value are routed into a nested-relation subquery (see
 *   {@link nestedRelationToSql}).
 * - Keys that match a relation but no column (e.g. inverse `many`) are
 *   handled entirely as nested-relation predicates.
 * - Unknown keys are ignored — clients can't synthesize columns or relations
 *   that weren't declared on the table.
 *
 * @param where The user-supplied input from `args.where`.
 * @param columns The table's GraphQL-field → column map, used to look up the
 *                Drizzle Column for each filter key.
 * @param ctx Optional context for nested-relation filtering.
 * @returns A single SQL fragment (multiple parts AND-combined) or `undefined`
 *          when no usable conditions were supplied.
 *
 * @example
 * whereToSql({ title: { ilike: "%buy%" }, completed: { eq: false } }, todoCols);
 * // → and(ilike(todos.title, "%buy%"), eq(todos.completed, false))
 *
 * @example
 * // With ctx — filter todos by their assignee's email:
 * whereToSql(
 *   { assigneeId: { email: { eq: "x@y" } } },
 *   todoCols,
 *   ctx,
 * );
 * // → todos.assignee_id IN (SELECT assignees.id FROM assignees WHERE email = 'x@y')
 */
export function whereToSql(
  where: Record<string, any> | null | undefined,
  columns: ColumnMap,
  ctx?: WhereContext,
): SQL | undefined {
  if (!where) return undefined;
  const parts: SQL[] = [];

  const relsByName = new Map<string, ExtractedRelation>();
  if (ctx) {
    for (const r of ctx.relations) {
      if (r.fields?.length === 1 && r.references?.length === 1) {
        relsByName.set(r.fieldName, r);
      }
    }
  }

  for (const [key, val] of Object.entries(where)) {
    if (val == null) continue;
    if (key === "AND") {
      const inner = (val as any[]).map((w) => whereToSql(w, columns, ctx)).filter(Boolean) as SQL[];
      if (inner.length) parts.push(and(...inner)!);
      continue;
    }
    if (key === "OR") {
      const inner = (val as any[]).map((w) => whereToSql(w, columns, ctx)).filter(Boolean) as SQL[];
      if (inner.length) parts.push(or(...inner)!);
      continue;
    }
    if (key === "NOT") {
      const inner = whereToSql(val, columns, ctx);
      if (inner) parts.push(not(inner));
      continue;
    }

    const col = columns[key];
    const rel = relsByName.get(key);

    if (col) {
      // Split operator keys from nested-relation keys (only the latter when
      // the column has a same-named relation).
      const colOps: Record<string, any> = {};
      const nested: Record<string, any> = {};
      for (const [opKey, opVal] of Object.entries(val as Record<string, any>)) {
        if (COLUMN_OPS.has(opKey)) colOps[opKey] = opVal;
        else nested[opKey] = opVal;
      }
      for (const [op, opVal] of Object.entries(colOps)) {
        if (opVal === undefined || opVal === null) continue;
        switch (op) {
          case "eq": parts.push(eq(col, opVal as any)); break;
          case "ne": parts.push(ne(col, opVal as any)); break;
          case "gt": parts.push(gt(col, opVal as any)); break;
          case "gte": parts.push(gte(col, opVal as any)); break;
          case "lt": parts.push(lt(col, opVal as any)); break;
          case "lte": parts.push(lte(col, opVal as any)); break;
          case "in": parts.push(inArray(col, opVal as any[])); break;
          case "notIn": parts.push(notInArray(col, opVal as any[])); break;
          case "like": parts.push(like(col, opVal as any)); break;
          case "ilike": parts.push(ilike(col, opVal as any)); break;
          case "isNull": parts.push((opVal ? isNull : isNotNull)(col)); break;
        }
      }
      if (rel && ctx && Object.keys(nested).length) {
        const sub = nestedRelationToSql(rel, nested, ctx);
        if (sub) parts.push(sub);
      }
      continue;
    }

    if (rel && ctx) {
      const sub = nestedRelationToSql(rel, val as Record<string, any>, ctx);
      if (sub) parts.push(sub);
      continue;
    }
    // Unknown key — ignore.
  }
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : and(...parts);
}

/**
 * Translate an `OrderBy` input into an ordered list of Drizzle `asc()` /
 * `desc()` fragments.
 *
 * Iteration order follows the keys as provided by the GraphQL client —
 * callers can specify a multi-column ordering by listing the fields in the
 * desired precedence (e.g. `{ priority: DESC, id: ASC }`).
 *
 * @param orderBy Map of column name → `"asc" | "desc"` (the {@link
 *                buildOrderDirectionEnum} resolves the GraphQL enum to these
 *                lowercase strings).
 * @param columns The table's GraphQL-field → column map.
 * @returns Array of SQL ORDER BY fragments; pass via spread to Drizzle's
 *          `.orderBy(...)`.
 */
export function orderByToSql(
  orderBy: Record<string, "asc" | "desc"> | null | undefined,
  columns: ColumnMap,
): SQL[] {
  if (!orderBy) return [];
  const out: SQL[] = [];
  for (const [k, dir] of Object.entries(orderBy)) {
    const col = columns[k];
    if (!col) continue;
    out.push(dir === "desc" ? desc(col) : asc(col));
  }
  return out;
}

/**
 * Standard list-query args: a where input, ordering, and pagination.
 *
 * Shared between the auto-generated root list/single queries and the
 * relation-field "many" resolver, which all accept the same vocabulary.
 */
export interface ListArgs {
  where?: Record<string, any> | null;
  orderBy?: Record<string, "asc" | "desc"> | null;
  limit?: number | null;
  offset?: number | null;
}

/**
 * Apply the standard list-query args to a Drizzle select query.
 *
 * Composes user-supplied `where` ({@link whereToSql}) with an optional
 * `extraWhere` (AND-combined — useful for relation joins where the parent
 * row's local key is fixed), then chains `orderBy` ({@link orderByToSql}),
 * `limit`, and `offset` when present.
 *
 * Drizzle's query builder is mutable along the call chain; this helper
 * returns the same builder instance for ergonomic chaining (e.g. appending
 * `.limit(1)` for single-row queries).
 *
 * @param query A Drizzle select query (`db.select().from(table)`).
 * @param args Caller-supplied {@link ListArgs} (`null`/`undefined` allowed).
 * @param columns The table's GraphQL-field → column map.
 * @param extraWhere Optional pre-computed condition AND-ed with `args.where`.
 * @param ctx Optional {@link WhereContext} forwarded to {@link whereToSql}
 *            so nested relation filters are translated into subqueries.
 */
export function applyListArgs<Q>(
  query: Q,
  args: ListArgs | null | undefined,
  columns: ColumnMap,
  extraWhere?: SQL,
  ctx?: WhereContext,
): Q {
  const userWhere = whereToSql(args?.where, columns, ctx);
  const combined = combineWhere(extraWhere, userWhere);
  let q: any = (query as any).where(combined);
  const order = orderByToSql(args?.orderBy, columns);
  if (order.length) q = q.orderBy(...order);
  if (args?.limit != null) q = q.limit(args.limit);
  if (args?.offset != null) q = q.offset(args.offset);
  return q as Q;
}

/**
 * AND-combine two optional SQL fragments, dropping `undefined` ones.
 * Returns `undefined` when both are `undefined` so callers can skip emitting
 * a where clause entirely.
 */
export function combineWhere(a: SQL | undefined, b: SQL | undefined): SQL | undefined {
  return a && b ? and(a, b) : a ?? b;
}
