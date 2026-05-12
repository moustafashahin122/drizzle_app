/**
 * @module drizzle-graphql-rbac/testing/app_testing
 *
 * Generic, framework-owned base for app-level test fixtures. Apps wire this
 * up once with their `createApp({...})` config and get a ready-to-use
 * `setupAppTestCase` + `createUser` pair backed by the same shared
 * in-memory sqlite handle the framework's own tests use.
 *
 * Lifecycle (per host process):
 *
 *   process boot
 *     ├─ createAppTestHarness(appConfig)  ← in test setup file
 *     │     returns { buildAppOnce, setupAppTestCase, createUser }
 *     │
 *     ├─ buildAppOnce()                   ← lazy, idempotent
 *     │   ├─ pushDrizzleSchema(appConfig.schema, ...)     ← idempotent DDL
 *     │   ├─ createApp({ db, ...appConfig })              ← prod wiring
 *     │   └─ build session-token mint helpers
 *     │
 *     │  for each suite using setupAppTestCase(setUp):
 *     │    ├─ before:    SAVEPOINT  + setUp(ctx) seeds reference data
 *     │    ├─ beforeEach SAVEPOINT  (per-test rollback)
 *     │    └─ after / afterEach: ROLLBACK TO ; RELEASE
 *     │
 *     └─ process exit
 *
 * Role assignments live in the DB (`roles` table + `users.role_id`) so they
 * are rolled back by the same savepoints as every other DB write.
 */
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import bcrypt from "bcryptjs";
import { graphql, type GraphQLSchema } from "graphql";
import { eq } from "drizzle-orm";

import { createApp, type CreateAppOptions, type CreatedApp } from "../app.js";
import { buildSchema as buildGraphqlSchema } from "../graphql/builder/builder.js";
import { issueSession } from "../auth/session.js";
import type { BuiltRbac } from "../graphql/rbac/rbac.js";
import { setUserRole } from "../graphql/rbac/persistence.js";
import { getSharedSqlite, transactionCase, pushDrizzleSchema } from "./base.js";

/** The DB-independent half of `createApp`'s options (everything except `db`). */
export type AppTestConfig = Omit<CreateAppOptions, "db">;

/** Lazy-built singleton: one app per harness, regardless of how many suites import it. */
export interface AppHandle<Schema extends AppTestConfig["schema"]> {
  sudoDb: ReturnType<typeof drizzleSqlite>;
  app: CreatedApp["app"];
  rbac: BuiltRbac;
  rdbFor: CreatedApp["rdbFor"];
  graphqlSchema: GraphQLSchema;
  schema: Schema;
}

/** Shape returned to each suite's `setUp` (and via the `tc` proxy to each test). */
export interface AppTestCtx<Schema extends AppTestConfig["schema"], Seed> {
  /**
   * Raw Drizzle handle over the shared in-memory sqlite. Named `sudoDb`
   * because direct use bypasses RBAC — appropriate for fixture seeding and
   * post-condition checks, not for exercising RBAC semantics. For that, use
   * `rdbFor(ctx)` or run the operation through `runHttp` / `runDirect`.
   */
  sudoDb: AppHandle<Schema>["sudoDb"];
  /** Per-request RBAC-bound db factory. Construct one per simulated user. */
  rdbFor: AppHandle<Schema>["rdbFor"];
  /** Hono app — call `app.fetch(new Request(...))`. */
  app: AppHandle<Schema>["app"];
  /** RBAC engine. Read-only at runtime — role registry + enforce hook. */
  rbac: BuiltRbac;
  /** Schema namespace re-export. */
  schema: Schema;
  /**
   * Assign a role to a user by writing to `users.role_id` (DB-backed, like
   * production `setUserRole`). Pass `null` to clear the role.
   */
  assignRole: (userId: number, roleName: string | null) => Promise<void>;
  /**
   * Insert a session row for `userId` and return a Bearer token. Use as
   * `Authorization: Bearer <token>` to skip cookie plumbing in HTTP tests.
   */
  mintToken: (userId: number) => Promise<string>;
  /**
   * Execute a GraphQL query through the full Hono stack (session
   * middleware → RBAC → resolvers). Pass `asUserId` to mint and attach a
   * Bearer token automatically; omit it for an anonymous request.
   */
  runHttp: (
    query: string,
    opts?: { asUserId?: number; variables?: Record<string, unknown> },
  ) => Promise<{ status: number; body: any }>;
  /**
   * Execute a GraphQL query against the schema directly with a synthetic
   * context. Bypasses Hono/session middleware — faster, but doesn't cover
   * the auth wiring.
   */
  runDirect: (
    query: string,
    opts?: { user?: { id: number; name: string } | null; variables?: Record<string, unknown> },
  ) => ReturnType<typeof graphql>;
  /** Whatever the suite's `setUp` returned. */
  seed: Seed;
}

export interface AppTestHarness<Schema extends AppTestConfig["schema"]> {
  /** Lazy, idempotent. Returns the singleton `{ sudoDb, app, rbac, ... }` handle. */
  buildAppOnce: () => Promise<AppHandle<Schema>>;
  /**
   * Wire a suite to the shared app. `setUp(base)` runs inside a SAVEPOINT
   * once per suite; whatever it returns is exposed as `tc.seed` alongside
   * the standard helper fields on the returned proxy.
   */
  setupAppTestCase: <Seed extends Record<string, unknown> = {}>(
    setUp?: (
      base: Omit<AppTestCtx<Schema, undefined>, "seed">,
    ) => Promise<Seed> | Seed,
  ) => AppTestCtx<Schema, Seed>;
  /** Insert a user row with a bcrypt'd password. Returns the inserted row. */
  createUser: (
    sudoDb: AppHandle<Schema>["sudoDb"],
    attrs: { name: string; email: string; password?: string },
  ) => Promise<any>;
}

/**
 * Build a process-scoped harness bound to a single app config. Call once at
 * test-module load time (typically in `src/testing/appTestCase.ts` in the
 * host app) and re-export the returned functions for suites to import.
 */
export function createAppTestHarness<Schema extends AppTestConfig["schema"]>(
  appConfig: AppTestConfig & { schema: Schema },
): AppTestHarness<Schema> {
  let cached: Promise<AppHandle<Schema>> | undefined;

  const buildAppOnce = (): Promise<AppHandle<Schema>> => {
    if (cached) return cached;
    cached = (async () => {
      const sqlite = getSharedSqlite();
      const sudoDb = drizzleSqlite(sqlite, { schema: appConfig.schema });

      await pushDrizzleSchema(sqlite, appConfig.schema as Record<string, unknown>);

      const { app, rbac, rdbFor } = await createApp({
        db: sudoDb,
        ...appConfig,
        publicDir: null,
        logger: false,
      });

      // Rebuild the same GraphQL schema for direct (`graphql()`) invocation —
      // `createApp` doesn't expose its internal schema. Reusing `rbac.enforce`
      // keeps role memberships consistent between runHttp and runDirect.
      const { schema: graphqlSchema } = buildGraphqlSchema(sudoDb, appConfig.schema, {
        hiddenOutputColumns: appConfig.hiddenOutputColumns,
        rbac: { enforce: rbac.enforce },
      });

      return {
        sudoDb,
        app,
        rbac,
        rdbFor,
        graphqlSchema,
        schema: appConfig.schema,
      };
    })();
    return cached;
  };

  const setupAppTestCase: AppTestHarness<Schema>["setupAppTestCase"] = (setUp) => {
    return transactionCase(async () => {
      const h = await buildAppOnce();

      const mintToken = async (userId: number) => {
        const { token } = await issueSession(h.sudoDb, h.schema as any, userId);
        return token;
      };

      const runHttp: AppTestCtx<Schema, any>["runHttp"] = async (query, opts = {}) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (opts.asUserId != null) {
          headers.authorization = `Bearer ${await mintToken(opts.asUserId)}`;
        }
        const res = await h.app.fetch(
          new Request("http://test.local/graphql", {
            method: "POST",
            headers,
            body: JSON.stringify({ query, variables: opts.variables ?? {} }),
          }),
        );
        const body = await res.json().catch(() => null);
        return { status: res.status, body };
      };

      const runDirect: AppTestCtx<Schema, any>["runDirect"] = (query, opts = {}) => {
        const user = opts.user ?? null;
        // Sync FK lookup mirrors what `sessionMiddleware` does over HTTP.
        let role: { name: string; isAdmin: boolean } | null = null;
        if (user) {
          const s = h.schema as unknown as { roles: any; users: any };
          const rows = h.sudoDb
            .select({ name: s.roles.name, isAdmin: s.roles.isAdmin })
            .from(s.users)
            .innerJoin(s.roles, eq(s.roles.id, s.users.roleId))
            .where(eq(s.users.id, user.id))
            .limit(1)
            .all() as Array<{ name: string; isAdmin: boolean | number }>;
          const row = rows[0];
          if (row) role = { name: row.name, isAdmin: !!row.isAdmin };
        }
        const batch = new Map<string, unknown>();
        return graphql({
          schema: h.graphqlSchema,
          source: query,
          contextValue: {
            user,
            role,
            session: null,
            batch,
            db: h.rdbFor({ user: user as any, role, batch }),
          },
          variableValues: opts.variables,
        });
      };

      const assignRole = async (userId: number, roleName: string | null) => {
        const s = h.schema as unknown as { roles: any; users: any };
        await setUserRole(h.sudoDb, { roles: s.roles, users: s.users }, userId, roleName);
      };

      const base: Omit<AppTestCtx<Schema, undefined>, "seed"> = {
        sudoDb: h.sudoDb,
        rdbFor: h.rdbFor,
        app: h.app,
        rbac: h.rbac,
        schema: h.schema,
        mintToken,
        runHttp,
        runDirect,
        assignRole,
      };

      const seed = setUp ? await setUp(base) : ({} as any);
      return { ...base, seed } as AppTestCtx<Schema, any>;
    });
  };

  const createUser: AppTestHarness<Schema>["createUser"] = async (sudoDb, attrs) => {
    const passwordHash = await bcrypt.hash(attrs.password ?? "secret123", 4);
    const users = (appConfig.schema as any).users;
    const rows = (await sudoDb
      .insert(users)
      .values({ name: attrs.name, email: attrs.email, passwordHash })
      .returning()) as any[];
    return rows[0];
  };

  return { buildAppOnce, setupAppTestCase, createUser };
}
