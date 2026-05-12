/**
 * @module drizzle-graphql-rbac/defaultConfig
 *
 * The framework's baseline configuration. Acts as the lowest level in the
 * three-stage precedence chain that `runServer` applies:
 *
 *     CLI args  >  user config file  >  frameworkDefaultConfig
 *
 * Every knob that has a sensible default lives here so the user's config
 * file can be as small as `{ db, schema, rbac }` and the host app still
 * boots with reasonable behaviour.
 *
 * Note: `db`, `schema`, and `rbac` have NO defaults — they are app-specific
 * and must be provided by the user's config file.
 *
 * `graphqlAllowIntrospection` is intentionally absent: its default is
 * dynamic (`NODE_ENV !== "production"`) and is resolved inside `createApp`.
 */
import type { ServerConfig } from "./config.js";

export const frameworkDefaultConfig: Partial<ServerConfig> = {
  // Transport
  port: 3000,
  host: "0.0.0.0",

  // Static + GraphQL surface
  publicDir: "./public",
  graphqlEndpoint: "/graphql",

  // Security gates
  graphqlMaxDepth: 10,
  graphqlRequireAuth: true,
  maxListLimit: 200,
  csrf: {},
  hiddenOutputColumns: { users: ["passwordHash"], sessions: ["token"] },
  hiddenInputColumns: { users: ["passwordHash"], sessions: ["token", "userId"] },

  // Observability
  logger: true,

  // Auto-bootstrap the admin user from ADMIN_EMAIL/ADMIN_PASSWORD when both
  // are resolved (env or CLI). Opt out with `bootstrapAdmin: false`.
  bootstrapAdmin: true,
};
