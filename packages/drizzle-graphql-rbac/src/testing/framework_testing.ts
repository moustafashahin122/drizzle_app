/**
 * @module drizzle-graphql-rbac/testing/framework_testing
 *
 * Test helpers for the framework's own tests (auth/admin/app/persistence).
 * Each helper does one obvious thing — no shared-singleton DB, no nested
 * options objects, no auto-merged defaults: tests pass the DB and any
 * overrides they need explicitly.
 *
 * Intentionally NOT re-exported from `./index.ts` — host apps should use
 * `app_testing`, not these. Framework tests import from this file directly.
 *
 * Typical use:
 *
 *   const { db } = await freshFrameworkDb();
 *   const { app } = await buildFrameworkApp(db);
 *   await seedUserWithRole(db, { name: "Alice", email: "a@x", role: "user" });
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import bcrypt from "bcryptjs";
import { graphql, type ExecutionResult, type GraphQLSchema } from "graphql";

import { roles, users, sessions, type User } from "../tables.js";
import { createApp, type CreateAppOptions, type CreatedApp } from "../app.js";
import type { buildAuthRoutes } from "../auth/routes.js";
import { issueSession } from "../auth/session.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
  type RbacConfig,
} from "../graphql/rbac/config.js";
import { setUserRole } from "../graphql/rbac/persistence.js";
import { buildSchema, type BuildSchemaOptions } from "../graphql/builder/builder.js";
import { pushDrizzleSchema, jsonFetch, cookieValue } from "./base.js";

/** Framework table namespace. */
export const frameworkSchema = { roles, users, sessions } as const;
export type FrameworkSchema = typeof frameworkSchema;
export type FrameworkDb = BetterSQLite3Database<FrameworkSchema>;

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

/** New `:memory:` sqlite with the framework DDL applied. */
export async function freshFrameworkDb(): Promise<{
  sqlite: Database.Database;
  db: FrameworkDb;
}> {
  const sqlite = new Database(":memory:");
  await pushDrizzleSchema(sqlite, frameworkSchema as Record<string, unknown>);
  return { sqlite, db: drizzle(sqlite, { schema: frameworkSchema }) };
}

// ---------------------------------------------------------------------------
// Seeders
// ---------------------------------------------------------------------------

/** Insert a user with a bcrypt'd password (cost 4 — tests run this in hot loops). */
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

/** seedUser + setUserRole. */
export async function seedUserWithRole(
  db: FrameworkDb,
  attrs: { name: string; email: string; password?: string; role: string },
): Promise<User> {
  const u = await seedUser(db, attrs);
  await setUserRole(db, { roles, users }, u.id, attrs.role);
  return u;
}

/** Insert a session row directly and return its token. */
export async function mintToken(db: FrameworkDb, userId: number): Promise<string> {
  const { token } = await issueSession(db, frameworkSchema, userId);
  return token;
}

/** POST /login through `authApp` and return the `sid` cookie value. */
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

/**
 * Delete every row from the framework tables. `roles` is intentionally NOT
 * wiped — it's code-defined and synced once. Useful for `beforeEach` cleanup
 * when a suite doesn't want savepoint semantics.
 */
export async function wipeFrameworkTables(db: FrameworkDb): Promise<void> {
  await db.delete(sessions);
  await db.delete(users);
}

// ---------------------------------------------------------------------------
// App builders
// ---------------------------------------------------------------------------

/** Minimal RBAC: `admin` (auto-injected by createApp) + `user` with read on users. */
const minimalRbacConfig: RbacConfig = {
  roles: defineRoles({ user: {} }),
  accessRights: defineAccessRights({ user: { users: { read: true } } }),
  recordRules: defineRecordRules({}),
};

type CreateAppOverrides = Partial<Omit<CreateAppOptions, "db" | "schema" | "rbac">>;

/**
 * Full `createApp` over the framework schema. No caching — each call builds
 * a fresh app so suites can sweep option matrices.
 */
export async function buildFrameworkApp(
  db: FrameworkDb,
  overrides: CreateAppOverrides = {},
): Promise<{
  app: CreatedApp["app"];
  rbac: CreatedApp["rbac"];
  sudoDb: CreatedApp["sudoDb"];
  rdbFor: CreatedApp["rdbFor"];
  db: FrameworkDb;
}> {
  const built = await createApp({
    db,
    schema: frameworkSchema as unknown as CreateAppOptions["schema"],
    rbac: minimalRbacConfig,
    publicDir: null,
    logger: false,
    ...overrides,
  });
  return {
    app: built.app,
    rbac: built.rbac,
    sudoDb: built.sudoDb,
    rdbFor: built.rdbFor,
    db,
  };
}


// ---------------------------------------------------------------------------
// GraphQL builder fixture
// ---------------------------------------------------------------------------

type BuilderDb = ReturnType<typeof drizzle>;

export interface BuilderFixture {
  db: BuilderDb;
  schema: GraphQLSchema;
  /** Count of `select ...` statements observed so far (0 unless `countQueries`). */
  selects(): number;
  resetCounter(): void;
  /** Run a query and return `data`; throws if `errors` is non-empty. */
  run<T = Record<string, any>>(
    query: string,
    variables?: Record<string, unknown>,
    contextValue?: unknown,
  ): Promise<T>;
  /** Run a query and return the raw ExecutionResult. */
  runRaw(
    query: string,
    opts?: { variables?: Record<string, unknown>; contextValue?: unknown },
  ): Promise<ExecutionResult>;
}

export interface BuilderFixtureOptions {
  tables: Record<string, unknown>;
  /** Runs after schema is pushed, before the GraphQL schema is built. */
  seed?: (db: BuilderDb) => void | Promise<void>;
  builder?: BuildSchemaOptions;
  /** Install a logger that counts `select` queries. */
  countQueries?: boolean;
}

/**
 * Builder-test fixture: one isolated in-memory sqlite handle, schema pushed via
 * drizzle-kit, and a typed `run` that throws on GraphQL errors. `countQueries`
 * installs a Drizzle logger that increments a counter on every `select ...`
 * statement — used by the relation-batching tests.
 */
export async function makeBuilderFixture(
  opts: BuilderFixtureOptions,
): Promise<BuilderFixture> {
  const sqlite = new Database(":memory:");
  await pushDrizzleSchema(sqlite, opts.tables);

  let selectCount = 0;
  const db = drizzle(
    sqlite,
    opts.countQueries
      ? {
          logger: {
            logQuery: (q) => {
              if (q.toLowerCase().startsWith("select")) selectCount++;
            },
          },
        }
      : undefined,
  );

  if (opts.seed) await opts.seed(db);

  const { schema } = buildSchema(db, opts.tables, opts.builder ?? {});

  const runRaw: BuilderFixture["runRaw"] = (source, o) =>
    graphql({
      schema,
      source,
      variableValues: o?.variables,
      contextValue: o?.contextValue,
    });

  const run: BuilderFixture["run"] = async (source, variables, contextValue) => {
    const result = await runRaw(source, { variables, contextValue });
    if (result.errors?.length) {
      throw new Error(result.errors.map((e) => e.message).join("\n"));
    }
    return result.data as any;
  };

  return {
    db,
    schema,
    selects: () => selectCount,
    resetCounter: () => { selectCount = 0; },
    run,
    runRaw,
  };
}
