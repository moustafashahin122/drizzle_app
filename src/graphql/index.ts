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
export { buildSchema } from "./builder.js";
export type { BuildSchemaOptions, DrizzleLike } from "./builder.js";
export { GraphQLJSON, GraphQLBigIntStr } from "./scalars.js";
