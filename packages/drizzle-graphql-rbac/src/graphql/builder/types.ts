/**
 * @module graphql/builder/types
 *
 * Summary
 * -------
 * Maps Drizzle column metadata to GraphQL types. Used by every per-table
 * builder (object types, Insert/Update inputs, Where filter inputs) so
 * mapping rules stay consistent across all generated surfaces.
 *
 * Mapping rules (input identical to output unless noted):
 * - `primary` column                            → `ID`
 * - `dataType: "number"` with a real-ish column type
 *   (`real`, `double`, `float`, `decimal`, `numeric`) → `Float`
 * - `dataType: "number"` (everything else)      → `Int`
 * - `dataType: "bigint"`                        → `BigIntString` scalar
 * - `dataType: "boolean"`                       → `Boolean`
 * - `dataType: "json" | "array"`                → `JSON` scalar
 * - `dataType: "date" | "string" | "buffer"` and any unknown value → `String`
 *
 * `notNull` wrapping is applied separately by {@link wrapNonNull} at the
 * field site, since the same base type is used for both required and
 * optional contexts (e.g. Insert input fields with defaults are optional even
 * though the column is `notNull`).
 */
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLString,
  type GraphQLInputObjectType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLInputType,
} from "graphql";
import type { Column, SQL, Table } from "drizzle-orm";
import type { ColumnMap } from "./filters.js";
import type { ExtractedRelation } from "./relations.js";
import { GraphQLBigIntStr, GraphQLJSON } from "./scalars.js";
import { isPrimary, getColumnType } from "./drizzle-internals.js";
import type { RbacContext } from "../rbac/rbac.js";

/**
 * Structural shape of a Drizzle DB instance accepted by the builder.
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
 * Internal per-table working set carried between passes of the builder.
 *
 * Holds both the Drizzle handles (table reference, columns, primary-key columns)
 * and the GraphQL types derived from them so that root resolvers and relation
 * resolvers can refer back to the same constructed types.
 */
export interface TableMeta {
  /** JS export key in the user's schema namespace (also the root query field name). */
  schemaKey: string;
  /** GraphQL ObjectType name (defaults to `cap(schemaKey)`; mutations are named `insertInto<typeName>`, etc.). */
  typeName: string;
  /** Drizzle table reference, passed through to query builders. */
  table: Table;
  /** Map of GraphQL field name → Drizzle Column (the field name equals the Drizzle JS key). */
  columns: ColumnMap;
  /** Relations declared on this table (forward + inverse, after introspection). */
  relations: ExtractedRelation[];
  objectType: GraphQLObjectType;
  insertInput: GraphQLInputObjectType;
  updateInput: GraphQLInputObjectType;
  orderByInput: GraphQLInputObjectType;
}

/** RBAC actions enforced by the auto-generated CRUD surface. */
export type RbacAction = "create" | "read" | "update" | "delete";

/**
 * RBAC guard closure resolved once per table — given a GraphQL request context
 * and the action being performed, returns the optional extra `where` clause to
 * AND into the resolver's query (or `undefined` when the action is permitted
 * without a row filter). `null` means RBAC is disabled or this resource is on
 * the bypass list, so resolvers should skip the call entirely.
 */
export type Guard =
  | ((ctx: RbacContext, action: RbacAction) => Promise<SQL | undefined>)
  | null;

/**
 * RBAC config block accepted by `buildSchema` — same shape as
 * `BuildSchemaOptions["rbac"]` but expressed here to avoid a circular import
 * with `builder.ts`.
 */
export interface RbacConfig {
  enforce: (
    ctx: RbacContext,
    resource: string,
    action: RbacAction,
    columns: ColumnMap,
  ) => Promise<{ where?: SQL }>;
  bypassResources?: ReadonlySet<string>;
}

/**
 * Build the per-table {@link Guard} closure for a resource. Returns `null` when
 * RBAC is disabled or the resource is on the bypass list, in which case
 * resolvers skip enforcement entirely.
 */
export function makeGuard(
  rbac: RbacConfig | undefined,
  schemaKey: string,
  columns: ColumnMap,
): Guard {
  if (!rbac) return null;
  if (rbac.bypassResources?.has(schemaKey)) return null;
  return async (ctx, action) =>
    (await rbac.enforce(ctx, schemaKey, action, columns)).where;
}

/**
 * Map a Drizzle column to its base (unwrapped) GraphQL type.
 *
 * The returned type satisfies both `GraphQLOutputType` and `GraphQLInputType`
 * so it can be reused for object fields *and* input fields — the builder uses
 * exactly the same scalar/ID type on both sides.
 *
 * @param col A Drizzle column — typically obtained from `getTableColumns(...)`.
 * @returns The matching GraphQL scalar or ID type. Primary-key columns always
 *          map to `ID`, regardless of underlying `dataType`.
 *
 * @example
 * columnToBaseType(todos.id);        // → GraphQLID
 * columnToBaseType(todos.title);     // → GraphQLString
 * columnToBaseType(todos.completed); // → GraphQLBoolean
 */
export function columnToBaseType(col: Column): GraphQLOutputType & GraphQLInputType {
  if (isPrimary(col)) return GraphQLID;
  switch (col.dataType) {
    case "number":
      // SQLiteInteger / PgInteger / MySqlInt etc — use Int unless it looks like a real number.
      if (/real|double|float|decimal|numeric/i.test(getColumnType(col) ?? ""))
        return GraphQLFloat;
      return GraphQLInt;
    case "bigint":
      return GraphQLBigIntStr;
    case "boolean":
      return GraphQLBoolean;
    case "json":
    case "array":
      return GraphQLJSON;
    case "date":
    case "string":
    case "buffer":
    default:
      return GraphQLString;
  }
}

/**
 * Wrap a base type with `GraphQLNonNull` when `notNull` is `true`, otherwise
 * return it unchanged. Pass-through helper that keeps call sites concise.
 */
export function wrapNonNull<T extends GraphQLOutputType | GraphQLInputType>(
  type: T,
  notNull: boolean,
): T {
  return (notNull ? new GraphQLNonNull(type as any) : type) as T;
}
