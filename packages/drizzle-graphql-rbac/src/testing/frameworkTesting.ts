/**
 * @module drizzle-graphql-rbac/testing/frameworkTesting
 *
 * Framework-internal test fixture. Sibling to {@link ./appTestCase.js}:
 * `appTestCase` is what consumer apps wire up against their own schema +
 * RBAC config; this module is the one the framework's own tests
 * (`app.test.ts`, `auth/*.test.ts`, `admin/*.test.ts`, `persistence.test.ts`)
 * use to exercise framework code in isolation.
 *
 * Intentionally NOT re-exported from `./index.ts` — consumers should depend
 * on `appTestCase`, not on this module.
 *
 * Lifecycle:
 *
 *   - One shared `:memory:` sqlite handle for the whole process (via
 *     {@link getSharedSqlite}). The framework DDL (from `tables.ts`) is
 *     pushed onto it lazily on first use.
 *   - Tests opt into per-test rollback via {@link transactionCase} as usual;
 *     between tests the savepoint reverts any inserts / updates / deletes.
 *   - For tests that need a brand-new isolated DB (e.g. `persistence.test.ts`,
 *     which exercises DDL-adjacent code), call {@link freshFrameworkDb}.
 *
 * The builders below ({@link buildFrameworkApp}, {@link buildAuthOnly},
 * {@link buildAdminAndAuth}) are pure factories — no `before` / `after`
 * hooks. Each test file decides whether to wrap them in `before`,
 * `transactionCase`, or per-test setup.
 */
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import bcrypt from "bcryptjs";

import { roles, users, sessions, type User } from "../tables.js";
import { createApp, type CreateAppOptions, type CreatedApp } from "../app.js";
import { buildAuthRoutes } from "../auth/routes.js";
import { buildAdminRoutes } from "../admin/routes.js";
import { issueSession } from "../auth/session.js";
import { buildRbac, type BuiltRbac } from "../graphql/rbac/rbac.js";
import { buildRbacDb } from "../graphql/rbac/rbacDb.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
  type RbacConfig,
} from "../graphql/rbac/config.js";
import { syncRoles, setUserRole } from "../graphql/rbac/persistence.js";
import { getSharedSqlite } from "./transactionCase.js";
import { jsonFetch, cookieValue } from "./httpTestUtils.js";

// drizzle-kit's ESM bundle has a broken dynamic-require polyfill; the CJS
// entry works under ESM via createRequire. Same workaround appTestCase uses.
const kitApi = createRequire(import.meta.url)("drizzle-kit/api") as {
  pushSQLiteSchema: (
    imports: Record<string, unknown>,
    drizzleInstance: unknown,
  ) => Promise<{ statementsToExecute: string[] }>;
};

/** The framework's table namespace, ready to spread into a schema config. */
export const frameworkSchema = { roles, users, sessions } as const;
export type FrameworkSchema = typeof frameworkSchema;
export type FrameworkDb = BetterSQLite3Database<FrameworkSchema>;

/**
 * Apply the framework DDL (from `tables.ts`) to a sqlite handle via
 * drizzle-kit. Idempotent — drizzle-kit emits no statements on an
 * already-materialized schema, so safe to call repeatedly.
 */
export async function pushFrameworkSchema(sqlite: Database.Database): Promise<void> {
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema: frameworkSchema });
  // Routing statements through `db.all()` rejects DDL ("statement does not
  // return data"); exec the raw SQL instead. On an already-populated DB the
  // statement list is empty so this is a no-op.
  const { statementsToExecute } = await kitApi.pushSQLiteSchema(
    frameworkSchema as unknown as Record<string, unknown>,
    db,
  );
  for (const stmt of statementsToExecute) sqlite.exec(stmt);
}

/**
 * Lazy singleton: the shared sqlite handle with the framework DDL applied
 * once. Subsequent callers get back the same handle + same drizzle wrapper.
 */
let sharedDb: FrameworkDb | undefined;
let sharedSchemaApplied: Promise<void> | undefined;

export async function getSharedFrameworkDb(): Promise<{
  sqlite: Database.Database;
  db: FrameworkDb;
}> {
  const sqlite = getSharedSqlite();
  if (!sharedSchemaApplied) sharedSchemaApplied = pushFrameworkSchema(sqlite);
  await sharedSchemaApplied;
  if (!sharedDb) sharedDb = drizzle(sqlite, { schema: frameworkSchema });
  return { sqlite, db: sharedDb };
}

/**
 * Spin up a brand-new `:memory:` sqlite with the framework DDL applied.
 * Used when a test wants full isolation from the shared singleton — e.g.
 * `persistence.test.ts`, which mutates the `roles` table in ways that
 * would interfere with other suites if it shared state.
 */
export async function freshFrameworkDb(): Promise<{
  sqlite: Database.Database;
  db: FrameworkDb;
}> {
  const sqlite = new Database(":memory:");
  await pushFrameworkSchema(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema: frameworkSchema }) };
}

// ---------------------------------------------------------------------------
// Seeding helpers — work against any FrameworkDb handle.
// ---------------------------------------------------------------------------

/**
 * Insert a user row with a bcrypt'd password. Cost 4 is intentional: tests
 * call this in hot loops; the production cost lives in app code, not here.
 */
export async function seedUser(
  db: FrameworkDb,
  attrs: { name: string; email: string; password?: string; active?: boolean },
): Promise<User> {
  const passwordHash = await bcrypt.hash(attrs.password ?? "secret123", 4);
  const [row] = await db
    .insert(users)
    .values({
      name: attrs.name,
      email: attrs.email,
      passwordHash,
      active: attrs.active ?? true,
    })
    .returning();
  return row;
}

/** Seed a user and assign a role via the production `setUserRole` helper. */
export async function seedUserWithRole(
  db: FrameworkDb,
  attrs: { name: string; email: string; password?: string; role: string },
): Promise<User> {
  const u = await seedUser(db, attrs);
  await setUserRole(db, { roles, users }, u.id, attrs.role);
  return u;
}

/** Mint a session token directly (skips `/auth/login`). */
export async function mintToken(db: FrameworkDb, userId: number): Promise<string> {
  const { token } = await issueSession(db, frameworkSchema, userId);
  return token;
}

/**
 * Log in via the auth sub-app, returning the `sid` cookie value. Use this
 * when the test specifically needs the login route to run (e.g. CSRF,
 * rate-limit suites); for everything else, `mintToken` is faster.
 */
export async function loginViaHttp(
  authApp: ReturnType<typeof buildAuthRoutes>,
  email: string,
  password: string,
): Promise<string> {
  const r = await jsonFetch(authApp, "POST", "/login", { body: { email, password } });
  const sid = cookieValue(r.setCookies, "sid");
  if (!sid) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return sid;
}

// ---------------------------------------------------------------------------
// Builders — pure factories. Each returns the wiring the test needs.
// ---------------------------------------------------------------------------

/**
 * Minimal RBAC config used as the default for builders that need one. Two
 * roles: `admin` (bypass) and `user` (read on users). Tests that need
 * different roles / grants should pass their own `rbacConfig`.
 */
export const defaultRbacConfig: RbacConfig = {
  roles: defineRoles({ user: {} }),
  accessRights: defineAccessRights({ user: { users: { read: true } } }),
  recordRules: defineRecordRules({}),
};

export interface BuildFrameworkAppOptions {
  /** Defaults to the shared singleton DB. Pass `freshFrameworkDb()` for isolation. */
  db?: FrameworkDb;
  /** Defaults to {@link defaultRbacConfig}. */
  rbacConfig?: RbacConfig;
  /** Overrides forwarded to `createApp` (e.g. `graphqlAllowIntrospection: false`). */
  createAppOverrides?: Partial<Omit<CreateAppOptions, "db" | "schema" | "rbac">>;
}

/**
 * Build a full `createApp` against the framework schema. Per-call — no
 * caching — so suites like `app.test.ts` can exercise option matrices.
 */
export async function buildFrameworkApp(
  opts: BuildFrameworkAppOptions = {},
): Promise<{
  app: CreatedApp["app"];
  rbac: CreatedApp["rbac"];
  sudoDb: CreatedApp["sudoDb"];
  rdbFor: CreatedApp["rdbFor"];
  db: FrameworkDb;
}> {
  const db = opts.db ?? (await getSharedFrameworkDb()).db;
  const built = await createApp({
    db,
    schema: frameworkSchema as unknown as CreateAppOptions["schema"],
    rbac: opts.rbacConfig ?? defaultRbacConfig,
    publicDir: null,
    logger: false,
    ...(opts.createAppOverrides ?? {}),
  });
  return {
    app: built.app,
    rbac: built.rbac,
    sudoDb: built.sudoDb,
    rdbFor: built.rdbFor,
    db,
  };
}

export interface BuildAuthOnlyOptions {
  db?: FrameworkDb;
  loginRateLimit?: Parameters<typeof buildAuthRoutes>[0]["loginRateLimit"];
}

/**
 * Just the auth sub-app — no RBAC, no admin. For `auth/auth.test.ts` and
 * `auth/csrf.test.ts` (the latter only as a sanity wiring; csrf.test.ts
 * already runs against a hand-rolled Hono app with no DB).
 */
export async function buildAuthOnly(opts: BuildAuthOnlyOptions = {}): Promise<{
  app: ReturnType<typeof buildAuthRoutes>;
  db: FrameworkDb;
}> {
  const db = opts.db ?? (await getSharedFrameworkDb()).db;
  const app = buildAuthRoutes({
    db,
    schema: frameworkSchema,
    loginRateLimit: opts.loginRateLimit,
  });
  return { app, db };
}

export interface BuildAdminAndAuthOptions {
  db?: FrameworkDb;
  rbacConfig?: RbacConfig;
}

/**
 * Auth + admin sub-apps wired together with an RBAC engine — the shape
 * `admin/admin.test.ts` consumes. `syncRoles` is called so the `roles`
 * table reflects the in-code config (matches production startup).
 */
export async function buildAdminAndAuth(
  opts: BuildAdminAndAuthOptions = {},
): Promise<{
  authApp: ReturnType<typeof buildAuthRoutes>;
  adminApp: ReturnType<typeof buildAdminRoutes>;
  db: FrameworkDb;
  rbac: BuiltRbac;
}> {
  const db = opts.db ?? (await getSharedFrameworkDb()).db;
  const config = opts.rbacConfig ?? {
    roles: defineRoles({ admin: { isAdmin: true }, user: {} }),
    accessRights: defineAccessRights({
      user: { users: { read: true, update: true } },
    }),
    recordRules: defineRecordRules({}),
  };
  const rbac = buildRbac(config);
  await syncRoles(db, { roles, users }, rbac.roles());
  const rdbFor = buildRbacDb({
    db,
    schema: frameworkSchema,
    enforce: rbac.enforce,
  });
  const authApp = buildAuthRoutes({ db, schema: frameworkSchema });
  const adminApp = buildAdminRoutes({
    db,
    schema: frameworkSchema,
    usersTable: users,
    rolesTable: roles,
    rdbFor,
    rbac,
  });
  return { authApp, adminApp, db, rbac };
}

/**
 * Convenience: delete every row from the framework tables on a given DB.
 * Useful for `beforeEach` cleanup when a suite doesn't want savepoint
 * semantics. Order matters — sessions FKs into users, users FKs into roles.
 */
export async function wipeFrameworkTables(db: FrameworkDb): Promise<void> {
  await db.delete(sessions);
  await db.delete(users);
  // `roles` is intentionally NOT wiped — it's code-defined and synced once.
}
