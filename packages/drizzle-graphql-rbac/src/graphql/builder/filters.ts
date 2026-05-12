/**
 * @module graphql/builder/filters
 *
 * Summary
 * -------
 * Order-by input type, column-map type, and list-query argument application
 * for the auto-generated GraphQL surface. The `where` filter is no longer a
 * structured GraphQL input — callers pass a JSON Odoo-style domain instead,
 * which the resolver translates via `../../domain/domain.js` before handing
 * the resulting SQL fragment to {@link applyListArgs}.
 *
 * `OrderBy` is an object with one direction per column:
 * `{ id: DESC, title: ASC }`. Direction values come from the shared
 * `OrderDirection` enum.
 */
import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  type GraphQLInputFieldConfigMap,
} from "graphql";
import {
  and,
  asc,
  desc,
  type Column,
  type SQL,
} from "drizzle-orm";

/**
 * Map of GraphQL field name → Drizzle Column for one table.
 *
 * Throughout the builder the GraphQL field name is identical to the Drizzle
 * JS key (the keys in your `sqliteTable("...", { ... })` definition), so
 * resolvers can look up the column directly by the field name a caller
 * sends in `orderBy` / `set` or in a domain leaf.
 */
export interface ColumnMap {
  [gqlField: string]: Column;
}

/** Shared `OrderDirection` GraphQL enum (`ASC` / `DESC`). */
const orderDirectionEnum = new GraphQLEnumType({
  name: "OrderDirection",
  values: { ASC: { value: "asc" }, DESC: { value: "desc" } },
});

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
 * Translate an `OrderBy` input into an ordered list of Drizzle `asc()` /
 * `desc()` fragments.
 *
 * Iteration order follows the keys as provided by the GraphQL client — callers
 * can specify a multi-column ordering by listing the fields in the desired
 * precedence (e.g. `{ priority: DESC, id: ASC }`).
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
 * Standard list-query args — what a Query.list / Query.Single / many-relation
 * resolver receives after the resolver has translated `args.where` (a JSON
 * domain) into a SQL fragment.
 */
export interface ListArgs {
  orderBy?: Record<string, "asc" | "desc"> | null;
  limit?: number | null;
  offset?: number | null;
}

/**
 * Apply the standard list-query args to a Drizzle select query.
 *
 * Attaches `where` (already a SQL fragment), then chains `orderBy`, `limit`,
 * and `offset` when present. Drizzle's query builder is mutable along the
 * call chain; this helper returns the same builder instance for ergonomic
 * chaining (e.g. appending `.limit(1)` for single-row queries).
 */
export function applyListArgs<Q>(
  query: Q,
  args: ListArgs | null | undefined,
  columns: ColumnMap,
  where?: SQL,
): Q {
  let q: any = where !== undefined ? (query as any).where(where) : query;
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
