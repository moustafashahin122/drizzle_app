/**
 * @module graphql
 *
 * Summary
 * -------
 * Public entry point for the auto-built GraphQL layer. Re-exports the schema
 * builder and the custom scalars used by generated types. See
 * `./builder.js` for the full pipeline overview (introspection → object/input
 * types → query/mutation roots → recursive relation resolvers).
 *
 * @example
 * import { buildSchema } from "./graphql/index.js";
 * import * as dbSchema from "./schema.js";
 * import { db } from "./db.js";
 *
 * const { schema } = buildSchema(db, dbSchema);
 */
export { buildSchema } from "./builder/builder.js";
export type { BuildSchemaOptions, DrizzleLike } from "./builder/builder.js";
export { GraphQLJSON, GraphQLBigIntStr } from "./builder/scalars.js";

import { GraphQLError, type ValidationRule, type FieldNode } from "graphql";

/**
 * Build a `graphql` ValidationRule that rejects operations whose selection
 * nesting exceeds `maxDepth`. Counts only `Field` nodes; fragments are
 * traversed transparently and contribute their depth to the enclosing field.
 *
 * Used to defend the auto-generated CRUD schema against DoS via deeply
 * recursive relation traversal (e.g. `a { b { a { b { ... } } } }`).
 */
export function depthLimit(maxDepth: number): ValidationRule {
  return (context) => {
    return {
      OperationDefinition(node) {
        const fragments = Object.create(null) as Record<string, any>;
        for (const def of context.getDocument().definitions) {
          if (def.kind === "FragmentDefinition") fragments[def.name.value] = def;
        }
        const walk = (
          n: { selectionSet?: { selections: readonly any[] } | null | undefined },
          depthSoFar: number,
        ): number => {
          if (!n.selectionSet) return depthSoFar;
          let max = depthSoFar;
          for (const sel of n.selectionSet.selections) {
            if (sel.kind === "Field") {
              const childDepth = walk(sel as FieldNode, depthSoFar + 1);
              if (childDepth > max) max = childDepth;
            } else if (sel.kind === "InlineFragment") {
              const childDepth = walk(sel, depthSoFar);
              if (childDepth > max) max = childDepth;
            } else if (sel.kind === "FragmentSpread") {
              const frag = fragments[sel.name.value];
              if (frag) {
                const childDepth = walk(frag, depthSoFar);
                if (childDepth > max) max = childDepth;
              }
            }
          }
          return max;
        };
        const depth = walk(node, 0);
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(
              `Query exceeds maximum depth of ${maxDepth} (got ${depth})`,
              { nodes: [node] },
            ),
          );
        }
      },
    };
  };
}
