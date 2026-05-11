/**
 * @module graphql/builder-fields
 *
 * Summary
 * -------
 * Column-iteration helpers shared by the per-table input-type builders. Keeps
 * the `notNull && !hasDefault && !generated` rule (and friends) in one place so
 * the Insert / Update inputs stay consistent.
 *
 * Notes
 * -----
 * The matching `OrderBy` and `Where` input shapes live in `./filters.js` — they
 * have their own column-iteration that's coupled to the domain/filter syntax,
 * so they aren't folded in here.
 */
import {
  GraphQLInputObjectType,
  type GraphQLInputFieldConfigMap,
} from "graphql";
import type { ColumnMap } from "./filters.js";
import { columnToBaseType, wrapNonNull } from "./types.js";
import { hasDefault, isGenerated, isNotNull } from "./drizzle-internals.js";

/**
 * Build the `<TypeName>Insert` input. Each field is required iff the column is
 * `notNull` AND has no default AND is not generated — defaults are passed
 * through to the database when the field is omitted at the GraphQL layer.
 */
export function buildInsertInput(
  typeName: string,
  columns: ColumnMap,
): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${typeName}Insert`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};
      for (const [name, col] of Object.entries(columns)) {
        const required = isNotNull(col) && !hasDefault(col) && !isGenerated(col);
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
export function buildUpdateInput(
  typeName: string,
  columns: ColumnMap,
): GraphQLInputObjectType {
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
