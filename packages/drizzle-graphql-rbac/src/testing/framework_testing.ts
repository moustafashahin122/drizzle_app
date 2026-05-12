/**
 * @module drizzle-graphql-rbac/testing/framework_testing
 *
 * Test helpers for the framework's own tests (auth/admin/app/builder).
 * Each helper does one thing and uses a fresh in-memory DB — no shared
 * singleton, no SAVEPOINT magic. Host apps use `app_testing` instead;
 * this file is intentionally not re-exported from `./index.ts`.
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import bcrypt from "bcryptjs";
import { graphql, type ExecutionResult, type GraphQLSchema } from "graphql";

import { roles, users, sessions, type User } from "../tables.js";
import { createApp, type CreateAppOptions, type CreatedApp } from "../app.js";
import type { buildAuthRoutes } from "../auth/routes.js";
import {
  defineRoles,
  defineAccessRights,
  defineRecordRules,
  type RbacConfig,
} from "../graphql/rbac/config.js";
import { setUserRole } from "../graphql/rbac/persistence.js";
import { buildSchema, type BuildSchemaOptions } from "../graphql/builder/builder.js";
import { pushDrizzleSchema, jsonFetch, cookieValue } from "./base.js";

export const frameworkSchema = { roles, users, sessions } as const;
type FrameworkSchema = typeof frameworkSchema;
export type FrameworkDb = BetterSQLite3Database<FrameworkSchema>;

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

/** Fresh `:memory:` sqlite with the framework DDL applied. */
export async function freshFrameworkDb(): Promise<{
  sqlite: Database.Database;
  db: FrameworkDb;
}> {
  const sqlite = new Database(":memory:");
  await pushDrizzleSchema(sqlite, frameworkSchema as Record<string, unknown>);
  return { sqlite, db: drizzle(sqlite, { schema: frameworkSchema }) };
}

/** Delete every `users` / `sessions` row. `roles` is code-defined; left alone. */
export async function wipeFrameworkTables(db: FrameworkDb): Promise<void> {
  await db.delete(sessions);
  await db.delete(users);
}

// ---------------------------------------------------------------------------
// User seeders
// ---------------------------------------------------------------------------

interface SeedUserAttrs {
  name: string;
  email: string;
  password?: string;
  active?: boolean;
}

/** Insert a user with a bcrypt'd password (cost 4 — tests run this in hot loops). */
export async function seedUser(db: FrameworkDb, attrs: SeedUserAttrs): Promise<User> {
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

/** `seedUser` + assign a role by name. */
export async function seedUserWithRole(
  db: FrameworkDb,
  attrs: SeedUserAttrs & { role: string },
): Promise<User> {
  const u = await seedUser(db, attrs);
  await setUserRole(db, { roles, users }, u.id, attrs.role);
  return u;
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

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

/** Minimal RBAC: `admin` (auto-injected) + `user` with read on users. */
const minimalRbac: RbacConfig = {
  roles: defineRoles({ user: {} }),
  accessRights: defineAccessRights({ user: { users: { read: true } } }),
  recordRules: defineRecordRules({}),
};

/** Full `createApp` over the framework schema. No caching — each call is fresh. */
export async function buildFrameworkApp(
  db: FrameworkDb,
  overrides: Partial<Omit<CreateAppOptions, "db" | "schema" | "rbac">> = {},
): Promise<CreatedApp & { db: FrameworkDb }> {
  const built = await createApp({
    db,
    schema: frameworkSchema as unknown as CreateAppOptions["schema"],
    rbac: minimalRbac,
    publicDir: null,
    logger: false,
    ...overrides,
  });
  return { ...built, db };
}

// ---------------------------------------------------------------------------
// GraphQL builder fixture
// ---------------------------------------------------------------------------

type BuilderDb = ReturnType<typeof drizzle>;

export interface BuilderFixture {
  db: BuilderDb;
  schema: GraphQLSchema;
  /** `select ...` statement count since last reset (always 0 unless `countQueries`). */
  selects(): number;
  resetCounter(): void;
  /** Run a query; throws if `errors` is non-empty. */
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

interface BuilderFixtureOptions {
  tables: Record<string, unknown>;
  /** Runs after schema push, before GraphQL schema build. */
  seed?: (db: BuilderDb) => void | Promise<void>;
  builder?: BuildSchemaOptions;
  /** Install a Drizzle logger that counts `select` queries. */
  countQueries?: boolean;
}

/** One isolated in-memory sqlite + schema push + a typed `run` that throws on errors. */
export async function makeBuilderFixture(
  opts: BuilderFixtureOptions,
): Promise<BuilderFixture> {
  const sqlite = new Database(":memory:");
  await pushDrizzleSchema(sqlite, opts.tables);

  let selectCount = 0;
  const logger = opts.countQueries
    ? { logQuery: (q: string) => { if (q.toLowerCase().startsWith("select")) selectCount++; } }
    : undefined;
  const db = drizzle(sqlite, logger ? { logger } : undefined);

  if (opts.seed) await opts.seed(db);

  const { schema } = buildSchema(db, opts.tables, opts.builder ?? {});

  const runRaw: BuilderFixture["runRaw"] = (source, o) =>
    graphql({ schema, source, variableValues: o?.variables, contextValue: o?.contextValue });

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
