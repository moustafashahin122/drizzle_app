/**
 * @module graphql/builder/scalars
 *
 * Summary
 * -------
 * Custom GraphQL scalars referenced by {@link columnToBaseType}:
 * - `JSON` — pass-through scalar for arbitrary JSON-shaped values, used for
 *   Drizzle's `json` and `array` data types.
 * - `BigIntString` — bigint encoded as a decimal string on the wire (avoids
 *   the JSON 53-bit number limit) and parsed back to a native `bigint`.
 *
 * Both scalars implement `serialize` (server → wire), `parseValue` (variables
 * → server), and `parseLiteral` (inline literal → server).
 */
import { GraphQLScalarType, Kind } from "graphql";

/**
 * `JSON` scalar. Serializes any value as-is, parses inline AST literals into
 * plain JS values (objects, arrays, strings, numbers, booleans, nulls).
 * Suitable for storing free-form payloads or Drizzle `json`/`array` columns.
 */
export const GraphQLJSON = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON value",
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral(ast, variables): unknown {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.INT:
      case Kind.FLOAT:
        return Number(ast.value);
      case Kind.OBJECT: {
        const obj: Record<string, unknown> = {};
        for (const f of ast.fields) obj[f.name.value] = GraphQLJSON.parseLiteral(f.value, variables);
        return obj;
      }
      case Kind.LIST:
        return ast.values.map((v) => GraphQLJSON.parseLiteral(v, variables));
      case Kind.NULL:
        return null;
      case Kind.ENUM:
        return ast.value;
      case Kind.VARIABLE:
        return variables?.[ast.name.value];
      default:
        throw new Error(`GraphQLJSON: unsupported literal kind ${(ast as { kind: string }).kind}`);
    }
  },
});

/**
 * `BigIntString` scalar. Big integers are exchanged as decimal strings on the
 * wire to avoid JSON's 53-bit safe-integer limit, and converted to/from native
 * `bigint` on the server side. Inline literals accept both string and int AST
 * forms for ergonomics.
 */
export const GraphQLBigIntStr = new GraphQLScalarType({
  name: "BigIntString",
  description: "BigInt encoded as a decimal string",
  serialize: (v) => (typeof v === "bigint" ? v.toString() : String(v)),
  parseValue: (v) => (typeof v === "string" ? BigInt(v) : BigInt(v as number)),
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT) return BigInt(ast.value);
    return null;
  },
});
