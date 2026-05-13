/**
 * @module drizzle-graphql-rbac/testing/app_testing
 *
 * Host-app test harness. Bind once to an app's `createApp` config via
 * `createAppTestHarness({...})`; suites get `setupAppTestCase` + `createUser`,
 * backed by the shared in-memory sqlite + SAVEPOINT fixture from `./base`.
 *
 *   const { setupAppTestCase, createUser } = createAppTestHarness({ schema, rbac });
 *
 *   const tc = setupAppTestCase(async ({ sudoDb, assignRole }) => {
 *     const alice = await createUser(sudoDb, { name: "Alice", email: "a@x" });
 *     await assignRole(alice.id, "user");
 *     return { alice };
 *   });
 */
import type Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import bcrypt from "bcryptjs";
import { graphql, type GraphQLSchema } from "graphql";
import { eq } from "drizzle-orm";

import { createApp, type CreateAppOptions, type CreatedApp } from "../app.js";
import { buildSchema as buildGraphqlSchema } from "../graphql/builder/builder.js";
import { issueSession } from "../auth/session.js";
import { setUserRole } from "../graphql/rbac/persistence.js";
import { transactionCase, pushDrizzleSchema } from "./base.js";

type AppTestConfig = Omit<CreateAppOptions, "db">;
type Schema = AppTestConfig["schema"];
type SudoDb = ReturnType<typeof drizzleSqlite>;

interface AppTestCtx<S extends Schema, Seed> {
  /** Raw Drizzle handle — bypasses RBAC. Use for seeding and ground-truth reads. */
  sudoDb: SudoDb;
  /** Hono app — `app.fetch(new Request(...))`. */
  app: CreatedApp["app"];
  schema: S;
  /** Assign a role by name (DB-backed). `null` clears. */
  assignRole: (userId: number, roleName: string | null) => Promise<void>;
  /** POST a GraphQL op through the full Hono stack. `asUserId` mints a session token. */
  runHttp: (
    query: string,
    opts?: { asUserId?: number; variables?: Record<string, unknown> },
  ) => Promise<{ status: number; body: any }>;
  /** Execute a GraphQL op against the schema directly with a synthetic context. */
  runDirect: (
    query: string,
    opts?: { user?: { id: number; name: string } | null; variables?: Record<string, unknown> },
  ) => ReturnType<typeof graphql>;
  seed: Seed;
}

interface AppTestHarness<S extends Schema> {
  setupAppTestCase: <Seed extends Record<string, unknown> = {}>(
    setUp?: (base: Omit<AppTestCtx<S, undefined>, "seed">) => Promise<Seed> | Seed,
  ) => AppTestCtx<S, Seed>;
  createUser: (
    sudoDb: SudoDb,
    attrs: { name: string; email: string; password?: string },
  ) => Promise<any>;
}

interface BuiltApp<S extends Schema> {
  sudoDb: SudoDb;
  app: CreatedApp["app"];
  rdbFor: CreatedApp["rdbFor"];
  graphqlSchema: GraphQLSchema;
  schema: S;
}

export function createAppTestHarness<S extends Schema>(
  appConfig: AppTestConfig & { schema: S },
): AppTestHarness<S> {
  // Each suite owns its own sqlite + Hono app + RBAC engine. The sqlite
  // handle comes from `transactionCase`, which opens a fresh `:memory:`
  // database in `before` and closes it in `after`. No process-wide singleton.
  const setupAppTestCase: AppTestHarness<S>["setupAppTestCase"] = (setUp) =>
    transactionCase(async (sqlite) => {
      const built = await buildAppForSuite(appConfig, sqlite);
      const base = makeTestCtx(built);
      const seed = setUp ? await setUp(base) : ({} as any);
      return { ...base, seed } as AppTestCtx<S, any>;
    });

  const createUser: AppTestHarness<S>["createUser"] = async (sudoDb, attrs) => {
    const passwordHash = await bcrypt.hash(attrs.password ?? "secret123", 4);
    const usersTable = (appConfig.schema as any).users;
    const [row] = (await sudoDb
      .insert(usersTable)
      .values({ name: attrs.name, email: attrs.email, passwordHash })
      .returning()) as any[];
    return row;
  };

  return { setupAppTestCase, createUser };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function buildAppForSuite<S extends Schema>(
  appConfig: AppTestConfig & { schema: S },
  sqlite: Database.Database,
): Promise<BuiltApp<S>> {
  const sudoDb = drizzleSqlite(sqlite, { schema: appConfig.schema });
  await pushDrizzleSchema(sqlite, appConfig.schema as Record<string, unknown>);

  const { app, rbac, rdbFor } = await createApp({
    db: sudoDb,
    ...appConfig,
    publicDir: null,
    logger: false,
  });

  // `createApp` doesn't expose its internal GraphQL schema; rebuild one for
  // direct (`graphql()`) invocation, sharing the live `rbac.enforce` hook so
  // role memberships stay consistent between runHttp and runDirect.
  const { schema: graphqlSchema } = buildGraphqlSchema(sudoDb, appConfig.schema, {
    hiddenOutputColumns: appConfig.hiddenOutputColumns,
    rbac: { enforce: rbac.enforce },
  });

  return { sudoDb, app, rdbFor, graphqlSchema, schema: appConfig.schema };
}

function makeTestCtx<S extends Schema>(
  built: BuiltApp<S>,
): Omit<AppTestCtx<S, undefined>, "seed"> {
  const { sudoDb, schema } = built;
  const tables = schema as unknown as { roles: any; users: any };

  return {
    sudoDb,
    app: built.app,
    schema,
    assignRole: (userId, roleName) =>
      setUserRole(sudoDb, { roles: tables.roles, users: tables.users }, userId, roleName),
    runHttp: makeRunHttp(built),
    runDirect: makeRunDirect(built),
  };
}

function makeRunHttp<S extends Schema>(built: BuiltApp<S>): AppTestCtx<S, any>["runHttp"] {
  return async (query, opts = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.asUserId != null) {
      const { token } = await issueSession(built.sudoDb, built.schema as any, opts.asUserId);
      headers.authorization = `Bearer ${token}`;
    }
    const res = await built.app.fetch(
      new Request("http://test.local/graphql", {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables: opts.variables ?? {} }),
      }),
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

function makeRunDirect<S extends Schema>(built: BuiltApp<S>): AppTestCtx<S, any>["runDirect"] {
  return (query, opts = {}) => {
    const user = opts.user ?? null;
    const role = user ? lookupRole(built, user.id) : null;
    const batch = new Map<string, unknown>();
    return graphql({
      schema: built.graphqlSchema,
      source: query,
      contextValue: {
        user,
        role,
        session: null,
        batch,
        db: built.rdbFor({ user: user as any, role, batch }),
      },
      variableValues: opts.variables,
    });
  };
}

/** Mirrors what `sessionMiddleware` does over HTTP: join user → role. */
function lookupRole<S extends Schema>(
  built: BuiltApp<S>,
  userId: number,
): { name: string; isAdmin: boolean } | null {
  const tables = built.schema as unknown as { roles: any; users: any };
  const rows = built.sudoDb
    .select({ name: tables.roles.name, isAdmin: tables.roles.isAdmin })
    .from(tables.users)
    .innerJoin(tables.roles, eq(tables.roles.id, tables.users.roleId))
    .where(eq(tables.users.id, userId))
    .limit(1)
    .all() as Array<{ name: string; isAdmin: boolean | number }>;
  if (!rows[0]) return null;
  return { name: rows[0].name, isAdmin: !!rows[0].isAdmin };
}
