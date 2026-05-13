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
 */
/**
 * Loosely typed so this module has no import edge back to `./config.ts` —
 * keeps the defaults / config split acyclic. `runServer` spreads this onto a
 * fully-typed `ServerConfig` so the strong types are enforced at the merge
 * site, not here.
 */
export const frameworkDefaultConfig = {
  // Transport
  port: 3000,
  host: "0.0.0.0",

  // Static + GraphQL surface
  publicDir: "./public",
  graphqlEndpoint: "/graphql",

  // Security gates
  graphqlMaxDepth: 10,
  maxListLimit: 200,
  csrf: {},
  hiddenOutputColumns: { users: ["passwordHash"], sessions: ["token"] },
  hiddenInputColumns: { users: ["passwordHash"], sessions: ["token", "userId"] },

  // Observability
  logger: true,

  // Admin user is NOT created on startup by default. Pass `--create-admin`
  // (or set `createAdmin: true` in the user config) together with
  // ADMIN_EMAIL / ADMIN_PASSWORD to upsert the admin user at boot.
  createAdmin: false,
};
