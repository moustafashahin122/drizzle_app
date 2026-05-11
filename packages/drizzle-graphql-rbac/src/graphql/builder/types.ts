/**
 * @module graphql/types
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
  type GraphQLOutputType,
  type GraphQLInputType,
} from "graphql";
import type { Column } from "drizzle-orm";
import { GraphQLBigIntStr, GraphQLJSON } from "./scalars.js";

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
  if ((col as any).primary) return GraphQLID;
  switch (col.dataType) {
    case "number":
      // SQLiteInteger / PgInteger / MySqlInt etc — use Int unless it looks like a real number.
      if (/real|double|float|decimal|numeric/i.test((col as any).columnType ?? ""))
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
