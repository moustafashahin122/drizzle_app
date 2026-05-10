/**
 * @module drizzle-graphql-rbac
 *
 * Public surface of the framework. The most common entry point is
 * {@link createApp} — it returns a Hono app with REST auth, REST admin user
 * CRUD, an auto-generated GraphQL endpoint, and RBAC wired through all
 * three. Everything else here is exposed for power users who want to
 * compose a custom pipeline.
 */

// One-call composition root.
export { createApp } from "./app.js";
export type { CreateAppOptions, CreatedApp } from "./app.js";

// Framework-owned tables — callers usually re-export these from their own db module.
export {
  users,
  sessions,
  groups,
  userGroups,
  accessRights,
  recordRules,
  frameworkTables,
} from "./tables.js";
export type {
  User,
  NewUser,
  Session,
  Group,
  UserGroup,
  AccessRight,
  RecordRule,
} from "./tables.js";

// REST auth primitives.
export { buildAuthRoutes } from "./auth/routes.js";
export type { AuthRoutesDeps } from "./auth/routes.js";
export {
  sessionMiddleware,
  requireAuth,
  type AuthEnv,
  type AuthVariables,
} from "./auth/middleware.js";
export {
  buildSessionCookie,
  buildClearSessionCookie,
  parseSessionCookie,
  extractBearerToken,
  resolveSessionFromToken,
  issueSession,
  destroySession,
  SESSION_COOKIE_NAME,
} from "./auth/session.js";
export type { SessionDb, SessionSchema } from "./auth/session.js";

// REST admin primitives.
export { buildAdminRoutes } from "./admin/routes.js";
export type { AdminRoutesDeps } from "./admin/routes.js";

// GraphQL builder + custom scalars.
export { buildSchema, GraphQLJSON, GraphQLBigIntStr } from "./graphql/index.js";
export type { BuildSchemaOptions, DrizzleLike } from "./graphql/index.js";

// RBAC engine.
export { buildRbac } from "./graphql/rbac/rbac.js";
export type {
  RbacContext,
  RbacEnforce,
  RbacSchema,
  Action,
  BuildRbacOptions,
} from "./graphql/rbac/rbac.js";
export { buildRbacDb, RbacDb } from "./graphql/rbac/rbacDb.js";
export type { RbacDbDeps } from "./graphql/rbac/rbacDb.js";

// RBAC cache — exposed for advanced consumers building a custom enforce.
export { RbacCache, TtlLruCache } from "./graphql/rbac/cache.js";
export type {
  CachedGroups,
  EnforceEntry,
  RbacCacheOptions,
} from "./graphql/rbac/cache.js";

// Domain (Odoo-style filter) primitives.
export { parseDomain, domainToSql } from "./graphql/domain/domain.js";
export type {
  DomainNode,
  DomainLeaf,
  DomainPlaceholders,
  DomainContext,
  DomainTableInfo,
} from "./graphql/domain/domain.js";
