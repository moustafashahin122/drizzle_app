/**
 * @module drizzle-graphql-rbac/testing/app_testing
 *
 * Framework-owned base for app-level test fixtures. Bind once to an
 * app's `createApp` config; suites get `setupAppTestCase` + `createUser`,
 * backed by the shared in-memory sqlite + SAVEPOINT fixture in `./base`.
 */
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import bcrypt from "bcryptjs";
import { graphql, type GraphQLSchema } from "graphql";
import { eq } from "drizzle-orm";

import { createApp, type CreateAppOptions, type CreatedApp } from "../app.js";
import { buildSchema as buildGraphqlSchema } from "../graphql/builder/builder.js";
import { issueSession } from "../auth/session.js";
import { setUserRole } from "../graphql/rbac/persistence.js";
import { getSharedSqlite, transactionCase, pushDrizzleSchema } from "./base.js";

export type AppTestConfig = Omit<CreateAppOptions, "db">;

type Schema = AppTestConfig["schema"];

export interface AppTestCtx<S extends Schema, Seed> {
  /** Raw Drizzle handle — bypasses RBAC. Use for fixture seeding / ground-truth reads. */
  sudoDb: ReturnType<typeof drizzleSqlite>;
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

export interface AppTestHarness<S extends Schema> {
  setupAppTestCase: <Seed extends Record<string, unknown> = {}>(
    setUp?: (base: Omit<AppTestCtx<S, undefined>, "seed">) => Promise<Seed> | Seed,
  ) => AppTestCtx<S, Seed>;
  createUser: (
    sudoDb: ReturnType<typeof drizzleSqlite>,
    attrs: { name: string; email: string; password?: string },
  ) => Promise<any>;
}

interface Built<S extends Schema> {
  sudoDb: ReturnType<typeof drizzleSqlite>;
  app: CreatedApp["app"];
  rdbFor: CreatedApp["rdbFor"];
  graphqlSchema: GraphQLSchema;
  schema: S;
}

export function createAppTestHarness<S extends Schema>(
  appConfig: AppTestConfig & { schema: S },
): AppTestHarness<S> {
  let cached: Promise<Built<S>> | undefined;

  const build = (): Promise<Built<S>> => {
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

      return { sudoDb, app, rdbFor, graphqlSchema, schema: appConfig.schema };
    })();
    return cached;
  };

  const setupAppTestCase: AppTestHarness<S>["setupAppTestCase"] = (setUp) =>
    transactionCase(async () => {
      const h = await build();
      const s = h.schema as unknown as { roles: any; users: any };

      const runHttp: AppTestCtx<S, any>["runHttp"] = async (query, opts = {}) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (opts.asUserId != null) {
          const { token } = await issueSession(h.sudoDb, h.schema as any, opts.asUserId);
          headers.authorization = `Bearer ${token}`;
        }
        const res = await h.app.fetch(
          new Request("http://test.local/graphql", {
            method: "POST",
            headers,
            body: JSON.stringify({ query, variables: opts.variables ?? {} }),
          }),
        );
        return { status: res.status, body: await res.json().catch(() => null) };
      };

      const runDirect: AppTestCtx<S, any>["runDirect"] = (query, opts = {}) => {
        const user = opts.user ?? null;
        // Mirrors what `sessionMiddleware` does over HTTP.
        let role: { name: string; isAdmin: boolean } | null = null;
        if (user) {
          const rows = h.sudoDb
            .select({ name: s.roles.name, isAdmin: s.roles.isAdmin })
            .from(s.users)
            .innerJoin(s.roles, eq(s.roles.id, s.users.roleId))
            .where(eq(s.users.id, user.id))
            .limit(1)
            .all() as Array<{ name: string; isAdmin: boolean | number }>;
          if (rows[0]) role = { name: rows[0].name, isAdmin: !!rows[0].isAdmin };
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

      const base: Omit<AppTestCtx<S, undefined>, "seed"> = {
        sudoDb: h.sudoDb,
        app: h.app,
        schema: h.schema,
        assignRole: (userId, roleName) =>
          setUserRole(h.sudoDb, { roles: s.roles, users: s.users }, userId, roleName),
        runHttp,
        runDirect,
      };

      const seed = setUp ? await setUp(base) : ({} as any);
      return { ...base, seed } as AppTestCtx<S, any>;
    });

  const createUser: AppTestHarness<S>["createUser"] = async (sudoDb, attrs) => {
    const passwordHash = await bcrypt.hash(attrs.password ?? "secret123", 4);
    const users = (appConfig.schema as any).users;
    const [row] = (await sudoDb
      .insert(users)
      .values({ name: attrs.name, email: attrs.email, passwordHash })
      .returning()) as any[];
    return row;
  };

  return { setupAppTestCase, createUser };
}
