/**
 * @module drizzle-graphql-rbac
 *
 * Public surface of the framework. The most common entry point is
 * {@link createApp} — it returns a Hono app with REST auth, REST admin user
 * CRUD + role membership, an auto-generated GraphQL endpoint, and RBAC
 * wired through all three. Roles, access rights, and record rules are
 * declared in code (see {@link defineRoles} / {@link defineAccessRights} /
 * {@link defineRecordRules}) and the engine is built synchronously at
 * startup from that config. User→role assignments are persisted to the DB
 * (`users.role_id` references a row in the `roles` table, which `syncRoles`
 * reconciles with the in-code config at startup).
 */

// Shared pino logger. Consumers may also construct their own pino instance.
export { logger } from "./logger.js";
export type { Logger } from "./logger.js";

// One-call composition root.
export { createApp } from "./app.js";
export type { CreateAppOptions, CreatedApp } from "./app.js";

// Server config-file loader + boot helper.
export {
  defineServerConfig,
  loadServerConfig,
  loadSecrets,
  parseCliArgs,
  resolveConfigPath,
  runServer,
} from "./config.js";
export type {
  ParsedCli,
  ResolvedServerConfig,
  RunServerHandle,
  RunServerOptions,
  Secrets,
  ServerConfig,
} from "./config.js";
export { frameworkDefaultConfig } from "./defaultConfig.js";

// Framework-owned tables — callers usually re-export these from their own db module.
export { roles, users, sessions, frameworkTables } from "./tables.js";
export type { Role, NewRole, User, NewUser, Session } from "./tables.js";

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
export { createCsrfProtection } from "./auth/csrf.js";
export type { CsrfConfig, CsrfOriginOption, CsrfProtection } from "./auth/csrf.js";

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
  ResolvedUserRole,
} from "./graphql/rbac/rbac.js";
export { buildRbacDb, RbacDb } from "./graphql/rbac/rbacDb.js";
export type { RbacDbDeps } from "./graphql/rbac/rbacDb.js";

// DB-backed role persistence — sync, lookup, assignment. Exposed so host
// apps (seed scripts, custom routes) can reconcile or read role state
// without going through `createApp`.
export {
  syncRoles,
  getUserRole,
  setUserRole,
  listRoles,
} from "./graphql/rbac/persistence.js";
export type { RolePersistenceSchema } from "./graphql/rbac/persistence.js";

// Framework-owned RBAC entries (the built-in `admin` role) + helper to
// merge them into a user config when wiring the engine directly.
export {
  ADMIN_ROLE,
  BUILT_IN_ROLES,
  mergeBuiltInRoles,
} from "./builtInRoles.js";

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
