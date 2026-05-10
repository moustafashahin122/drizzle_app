/**
 * @module drizzle-graphql-rbac/app
 *
 * `createApp` is the all-in-one composition root. It wires:
 *
 * 1. {@link buildSchema} — auto-generated GraphQL CRUD over the user's Drizzle
 *    schema (todos, plus the framework tables).
 * 2. {@link buildRbac} — RBAC engine reading `groups` / `accessRights` /
 *    `recordRules`.
 * 3. {@link buildAuthRoutes} — REST `/auth/{register,login,logout,me}`.
 * 4. {@link buildAdminRoutes} — REST `/admin/users` (RBAC-enforced).
 * 5. A Yoga GraphQL handler at `POST /graphql` that consumes the same
 *    session middleware so resolvers see the authenticated user.
 *
 * The caller supplies the Drizzle `db` and a schema namespace whose
 * properties include — at minimum — the framework tables. Anything else in
 * the namespace becomes a GraphQL resource automatically.
 *
 * @example
 * import { createApp } from "drizzle-graphql-rbac";
 * import { serve } from "@hono/node-server";
 * import * as schema from "./db.js";
 *
 * const app = createApp({
 *   db: schema.db,
 *   schema,
 *   hiddenOutputColumns: { users: ["passwordHash"] },
 * });
 * serve({ fetch: app.fetch, port: 3000 });
 */
import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { createYoga } from "graphql-yoga";
import { buildSchema, type BuildSchemaOptions } from "./graphql/builder/builder.js";
import { buildRbac } from "./graphql/rbac/rbac.js";
import { buildRbacDb, type RbacDb } from "./graphql/rbac/rbacDb.js";
import { buildAuthRoutes } from "./auth/routes.js";
import { buildAdminRoutes } from "./admin/routes.js";
import { sessionMiddleware, type AuthEnv } from "./auth/middleware.js";
import type { SessionDb, SessionSchema } from "./auth/session.js";
import type { User, Session, users as usersTableType } from "./tables.js";

export interface CreateAppOptions {
  /** A Drizzle DB instance (any dialect). */
  db: SessionDb;
  /**
   * The full schema namespace: framework tables (users, sessions, groups,
   * userGroups, accessRights, recordRules) plus any app-specific tables.
   * Pass via `import * as schema from "./db.js"`.
   */
  schema: Record<string, unknown> & SessionSchema & { users: typeof usersTableType };
  /**
   * Forwarded to {@link buildSchema}. Use this to hide sensitive output
   * columns; defaults to hiding `users.passwordHash`.
   */
  hiddenOutputColumns?: BuildSchemaOptions["hiddenOutputColumns"];
  /** Forwarded to {@link buildSchema} — name overrides for generated types. */
  typeNames?: BuildSchemaOptions["typeNames"];
  /**
   * Forwarded to {@link buildSchema} — bespoke Query fields the app wants on
   * top of the auto-generated CRUD.
   */
  extraQueryFields?: BuildSchemaOptions["extraQueryFields"];
  /** Forwarded to {@link buildSchema} — bespoke Mutation fields. */
  extraMutationFields?: BuildSchemaOptions["extraMutationFields"];
  /**
   * Static dir to serve at the catch-all route. When `null`, no static
   * handler is mounted (the caller can add their own routes).
   *
   * @default "./public"
   */
  publicDir?: string | null;
  /** Mount path for GraphiQL / GraphQL — defaults to `/graphql`. */
  graphqlEndpoint?: string;
  /**
   * Enable request + GraphQL operation logging.
   *  - `true` (default): mounts Hono's `logger()` middleware (per-request
   *    method/path/status/duration to stdout) and turns on Yoga's built-in
   *    operation logging.
   *  - `false`: no logging.
   *  - A function: passed to Hono's `logger(fn)` so callers can route lines
   *    to their own sink (pino, winston, structured JSON, etc.). Yoga's
   *    logging is enabled when a function is supplied.
   */
  logger?: boolean | ((message: string, ...rest: string[]) => void);
}

export interface CreatedApp {
  /** The Hono app — call `.fetch` from `@hono/node-server` or any Web Fetch host. */
  app: Hono<AuthEnv>;
  /** Per-request RBAC-bound DB factory; re-exported so callers can write custom routes. */
  rdbFor: (ctx: { user: User | null; batch?: Map<string, unknown> }) => RbacDb;
}

/**
 * Build the full Hono app with REST auth, REST admin, GraphQL CRUD, and
 * RBAC enforcement wired together.
 */
export function createApp(opts: CreateAppOptions): CreatedApp {
  const {
    db,
    schema,
    hiddenOutputColumns = { users: ["passwordHash"] },
    typeNames,
    extraQueryFields,
    extraMutationFields,
    publicDir = "./public",
    graphqlEndpoint = "/graphql",
    logger: loggerOpt = true,
  } = opts;
  const loggingEnabled = loggerOpt !== false;

  const sessionSchema: SessionSchema = {
    users: schema.users,
    sessions: schema.sessions,
  };

  const rbac = buildRbac(db, {
    groups: schema.groups as any,
    userGroups: schema.userGroups as any,
    accessRights: schema.accessRights as any,
    recordRules: schema.recordRules as any,
  });

  const { schema: gqlSchema } = buildSchema(db, schema, {
    hiddenOutputColumns,
    typeNames,
    extraQueryFields,
    extraMutationFields,
    rbac: { enforce: rbac.enforce },
  });

  const rdbFor = buildRbacDb({ db, schema, enforce: rbac.enforce });

  interface YogaContext {
    user: User | null;
    session: Session | null;
    batch: Map<string, unknown>;
    db: RbacDb;
  }

  const yoga = createYoga<{}, YogaContext>({
    schema: gqlSchema,
    graphqlEndpoint,
    graphiql: true,
    logging: loggingEnabled,
    context: async ({ request }) => {
      const stash = (request as any)._authCtx as
        | { user: User | null; session: Session | null }
        | undefined;
      const user = stash?.user ?? null;
      const session = stash?.session ?? null;
      const batch = new Map<string, unknown>();
      return { user, session, batch, db: rdbFor({ user, batch }) };
    },
  });

  const app = new Hono<AuthEnv>();

  if (loggingEnabled) {
    app.use("*", typeof loggerOpt === "function" ? honoLogger(loggerOpt) : honoLogger());
  }

  app.route("/auth", buildAuthRoutes({ db, schema: sessionSchema }));
  app.route(
    "/admin",
    buildAdminRoutes({
      db,
      schema: sessionSchema,
      usersTable: schema.users,
      rdbFor,
    }),
  );

  app.use(graphqlEndpoint, sessionMiddleware(db, sessionSchema));
  app.all(graphqlEndpoint, async (c) => {
    (c.req.raw as any)._authCtx = {
      user: c.get("user"),
      session: c.get("session"),
    };
    return yoga.fetch(c.req.raw, {});
  });

  if (publicDir) {
    // Lazy-load the static helper so non-Node hosts (e.g. workerd, Bun) can
    // still import this module without pulling in @hono/node-server.
    void import("@hono/node-server/serve-static").then(({ serveStatic }) => {
      app.use("/*", serveStatic({ root: publicDir }));
    });
  }

  return { app, rdbFor };
}
