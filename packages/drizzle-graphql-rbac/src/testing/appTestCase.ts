/**
 * @module drizzle-graphql-rbac/testing/appTestCase
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
 *     │   ├─ pushSQLiteSchema(appConfig.schema, drizzle)   ← idempotent DDL
 *     │   ├─ createApp({ db, ...appConfig })               ← prod wiring
 *     │   └─ build session-token mint helpers
 *     │
 *     │  for each suite using setupAppTestCase(setUp):
 *     │    ├─ before:    SAVEPOINT  + setUp(ctx) seeds reference data
 *     │    ├─ beforeEach SAVEPOINT  (per-test rollback)
 *     │    └─ after / afterEach: ROLLBACK TO ; RELEASE
 *     │
 *     └─ process exit
 *
 * RBAC role state lives in the DB (`roles` table + `users.role_id`) so it
 * is rolled back by the same savepoints that handle every other DB write.
 * No separate reset hook is needed.
 */
import { createRequire } from "node:module";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import bcrypt from "bcryptjs";
import { graphql, type GraphQLSchema } from "graphql";
import { createApp, type CreateAppOptions, type CreatedApp } from "../app.js";
import { buildSchema as buildGraphqlSchema } from "../graphql/builder/builder.js";
import { issueSession } from "../auth/session.js";
import type { BuiltRbac } from "../graphql/rbac/rbac.js";
import { setUserRole } from "../graphql/rbac/persistence.js";
import { eq } from "drizzle-orm";
import { getSharedSqlite, transactionCase } from "./transactionCase.js";

// `drizzle-kit/api`'s ESM bundle uses a broken dynamic-require polyfill that
// throws on `require("fs")` under native ESM. The CJS entry works, so we
// load it through `createRequire`. See drizzle-team/drizzle-kit-mirror#…
const kitApi = createRequire(import.meta.url)("drizzle-kit/api") as {
  pushSQLiteSchema: (
    imports: Record<string, unknown>,
    drizzleInstance: unknown,
  ) => Promise<{ statementsToExecute: string[] }>;
};

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
   * production `setUserRole`). Pass `null` to clear the role. Returns once
   * the write commits.
   */
  assignRole: (userId: number, roleName: string | null) => Promise<void>;
  /**
   * Insert a session row for `userId` and return a Bearer token. Use the
   * returned string as `Authorization: Bearer <token>` to skip cookie
   * plumbing in HTTP tests.
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
   * the auth wiring. Mirrors the in-package framework tests.
   */
  runDirect: (
    query: string,
    opts?: { user?: { id: number; name: string } | null; variables?: Record<string, unknown> },
  ) => ReturnType<typeof graphql>;
  /** Whatever the suite's `setUp` returned. Access via `tc.foo`. */
  seed: Seed;
}

export interface AppTestHarness<Schema extends AppTestConfig["schema"]> {
  /** Lazy, idempotent. Returns the singleton `{ sudoDb, app, rbac, ... }` handle. */
  buildAppOnce: () => Promise<AppHandle<Schema>>;
  /**
   * Wire a suite to the shared app. `setUp(base)` runs inside a SAVEPOINT
   * once per suite; whatever it returns is exposed as `tc.seed` alongside
   * the standard `{ app, rbac, sudoDb, schema, runHttp, runDirect, mintToken }`
   * fields on the returned proxy.
   */
  setupAppTestCase: <Seed extends Record<string, unknown> = {}>(
    setUp?: (
      base: Omit<AppTestCtx<Schema, undefined>, "seed">,
    ) => Promise<Seed> | Seed,
  ) => AppTestCtx<Schema, Seed>;
  /**
   * Insert a user row with a bcrypt'd password. Returns the inserted row so
   * tests can capture the auto-incremented `id`.
   */
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
      sqlite.pragma("foreign_keys = ON");
      const sudoDb = drizzleSqlite(sqlite, { schema: appConfig.schema });

      // Materialize the schema DDL into the shared in-memory handle. We can't
      // use the returned `apply()` because it routes statements through
      // `drizzle.all()`, which better-sqlite3 rejects for DDL ("statement
      // does not return data"). Running the raw SQL via `sqlite.exec`
      // sidesteps that; on an already-populated DB the diff is empty so this
      // is a no-op.
      const { statementsToExecute } = await kitApi.pushSQLiteSchema(
        appConfig.schema,
        sudoDb,
      );
      for (const stmt of statementsToExecute) sqlite.exec(stmt);

      const { app, rbac, rdbFor } = await createApp({
        db: sudoDb,
        ...appConfig,
        // Tests never serve static files and don't need request logging noise.
        publicDir: null,
        logger: false,
      });

      // Rebuild the same GraphQL schema for direct (`graphql()`) invocation —
      // `createApp` doesn't expose its internal schema. Reusing the already-
      // built `rbac.enforce` keeps role memberships consistent between
      // runHttp and runDirect.
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
        // better-sqlite3 is synchronous under drizzle's thenable façade — using
        // `.all()` keeps `runDirect` itself sync (no extra await on the test side).
        let role: { name: string; isAdmin: boolean } | null = null;
        if (user) {
          const schema = h.schema as unknown as { roles: any; users: any };
          const rows = h.sudoDb
            .select({ name: schema.roles.name, isAdmin: schema.roles.isAdmin })
            .from(schema.users)
            .innerJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
            .where(eq(schema.users.id, user.id))
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
        const schema = h.schema as unknown as { roles: any; users: any };
        await setUserRole(h.sudoDb, { roles: schema.roles, users: schema.users }, userId, roleName);
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
