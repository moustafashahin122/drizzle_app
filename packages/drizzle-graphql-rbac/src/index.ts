/**
 * @module drizzle-graphql-rbac
 *
 * Public surface of the framework. The most common entry point is
 * {@link createApp} — it returns a Hono app with REST auth, REST admin user
 * CRUD + role membership, an auto-generated GraphQL endpoint, and RBAC
 * wired through all three. Roles, access rights, and record rules are
 * declared in code (see {@link defineRoles} / {@link defineAccessRights} /
 * {@link defineRecordRules}); only user-role assignments live in the DB.
 */

// One-call composition root.
export { createApp } from "./app.js";
export type { CreateAppOptions, CreatedApp } from "./app.js";

// Framework-owned tables — callers usually re-export these from their own db module.
export {
  users,
  sessions,
  roles,
  accessRights,
  recordRules,
  userRoles,
  frameworkTables,
} from "./tables.js";
export type {
  User,
  NewUser,
  Session,
  UserRole,
  Role,
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

// Framework-owned RBAC entries (the built-in `admin` role) + helper to
// merge them into a user config when wiring the engine directly.
export {
  FRAMEWORK_ROLES,
  FRAMEWORK_ACCESS_RIGHTS,
  FRAMEWORK_RECORD_RULES,
  FRAMEWORK_XID_PREFIX,
  mergeFrameworkRbac,
} from "./frameworkRbac.js";

// Code-defined RBAC config helpers + types.
export {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
  buildRbacConfig,
} from "./graphql/rbac/config.js";
export type {
  RbacConfig,
  RolesConfig,
  AccessRightsConfig,
  RecordRulesConfig,
  ResolvedRbacConfig,
  ResolvedRole,
  ResolvedAccessRight,
  ResolvedRecordRule,
  RoleDef,
  ResourceAccessDef,
  RecordRuleDef,
  Domain,
} from "./graphql/rbac/config.js";

// RBAC sync (DB ↔ code reconciliation) — exposed for seed scripts and
// tests that want to populate the DB before issuing requests.
export {
  syncRbacFromCode,
  loadRbacSnapshot,
  syncAndSnapshot,
  emptySnapshot,
} from "./graphql/rbac/sync.js";
export type {
  SyncResult,
  RbacSnapshot,
  SyncSchema,
  SyncDb,
} from "./graphql/rbac/sync.js";

// RBAC cache — exposed for advanced consumers building a custom enforce.
export { RbacCache, TtlLruCache } from "./graphql/rbac/cache.js";
export type {
  CachedRoles,
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
