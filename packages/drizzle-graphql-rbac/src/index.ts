/**
 * @module drizzle-graphql-rbac
 *
 * Public surface of the framework. The most common entry point is
 * {@link createApp} — it returns a Hono app with REST auth, REST admin user
 * CRUD + role membership, an auto-generated GraphQL endpoint, and RBAC
 * wired through all three. Roles, access rights, record rules, and user→role
 * assignments are all in memory; the engine is built synchronously at startup
 * from the code config (see {@link defineRoles} / {@link defineAccessRights} /
 * {@link defineRecordRules}).
 */

// Shared pino logger. Consumers may also construct their own pino instance.
export { logger } from "./logger.js";
export type { Logger } from "./logger.js";

// One-call composition root.
export { createApp } from "./app.js";
export type { CreateAppOptions, CreatedApp } from "./app.js";

// Framework-owned tables — callers usually re-export these from their own db module.
export { users, sessions, frameworkTables } from "./tables.js";
export type { User, NewUser, Session } from "./tables.js";

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
  parseCookieValue,
  extractBearerToken,
  resolveSessionFromToken,
  issueSession,
  destroySession,
  SESSION_COOKIE_NAME,
} from "./auth/session.js";
export type { SudoDb, SessionSchema } from "./auth/session.js";

// REST admin primitives.
export { buildAdminRoutes } from "./admin/routes.js";
export type { AdminRoutesDeps } from "./admin/routes.js";

// GraphQL builder + custom scalars + validation rules.
export { buildSchema, GraphQLJSON, GraphQLBigIntStr, depthLimit } from "./graphql/index.js";
export type { BuildSchemaOptions, DrizzleLike } from "./graphql/index.js";

// RBAC engine.
export { buildRbac } from "./graphql/rbac/rbac.js";
export type {
  RbacContext,
  RbacEnforce,
  Action,
  BuiltRbac,
} from "./graphql/rbac/rbac.js";
export { buildRbacDb, RbacDb } from "./graphql/rbac/rbacDb.js";
export type { RbacDbDeps } from "./graphql/rbac/rbacDb.js";

// Framework-owned RBAC entries (the built-in `admin` role) + helper to
// merge them into a user config when wiring the engine directly.
export {
  ADMIN_ROLE,
  FRAMEWORK_ROLES,
  FRAMEWORK_ACCESS_RIGHTS,
  FRAMEWORK_RECORD_RULES,
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

// Domain (Odoo-style filter) primitives.
export { parseDomain, domainToSql } from "./graphql/domain/domain.js";
export type {
  DomainNode,
  DomainLeaf,
  DomainPlaceholders,
  DomainContext,
  DomainTableInfo,
} from "./graphql/domain/domain.js";
