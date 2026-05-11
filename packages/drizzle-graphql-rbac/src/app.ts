/**
 * @module drizzle-graphql-rbac/app
 *
 * `createApp` is the all-in-one composition root. It wires:
 *
 * 1. {@link buildSchema} — auto-generated GraphQL CRUD over the user's Drizzle
 *    schema (your tables plus the framework's `users` / `sessions`).
 * 2. {@link buildRbac} — in-memory RBAC engine built synchronously from the
 *    code config. User→role membership lives in the engine and is mutated by
 *    the admin sub-app.
 * 3. {@link buildAuthRoutes} — REST `/auth/{register,login,logout,me}`.
 * 4. {@link buildAdminRoutes} — REST `/admin/users` (RBAC-enforced) plus
 *    `/admin/users/:id/roles` for managing role membership.
 * 5. A Yoga GraphQL handler at `POST /graphql` that consumes the same
 *    session middleware so resolvers see the authenticated user.
 *
 * @example
 * import { createApp } from "drizzle-graphql-rbac";
 * import { serve } from "@hono/node-server";
 * import { sudoDb } from "./db.js";
 * import * as schema from "./schema.js";
 * import { roles } from "./roles.js";
 * import { accessRights } from "./accessRights.js";
 * import { recordRules } from "./recordRules.js";
 *
 * const { app, rbac, rdbFor } = createApp({
 *   db: sudoDb,
 *   schema,
 *   rbac: { roles, accessRights, recordRules },
 * });
 * // Optionally seed memberships before serving traffic:
 * // rbac.assignRole(adminUserId, "admin");
 * serve({ fetch: app.fetch, port: 3000 });
 */
import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { createYoga } from "graphql-yoga";
import { NoSchemaIntrospectionCustomRule } from "graphql/validation";
import { buildSchema, type BuildSchemaOptions } from "./graphql/builder/builder.js";
import { depthLimit } from "./graphql/index.js";
import { buildRbac, type BuiltRbac, type RbacContext } from "./graphql/rbac/rbac.js";
import type { RbacConfig } from "./graphql/rbac/config.js";
import { mergeFrameworkRbac } from "./frameworkRbac.js";
import { buildRbacDb, type RbacDb } from "./graphql/rbac/rbacDb.js";
import { buildAuthRoutes } from "./auth/routes.js";
import { buildAdminRoutes } from "./admin/routes.js";
import { sessionMiddleware, csrfProtection, type AuthEnv } from "./auth/middleware.js";
import type { SudoDb, SessionSchema } from "./auth/session.js";
import { logger } from "./logger.js";
import type {
  User,
  Session,
  users as usersTableType,
} from "./tables.js";

// Hono's logger may pre-color the status code with its own ANSI escapes; strip
// them before sniffing for a three-digit status.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function pickHttpStatus(parts: readonly string[]): number | null {
  for (const p of parts) {
    const bare = p.replace(ANSI_RE, "");
    if (/^[1-5]\d{2}$/.test(bare)) return Number(bare);
  }
  return null;
}

export interface CreateAppOptions {
  /** A Drizzle DB instance (any dialect). */
  db: SudoDb;
  /**
   * The full schema namespace: framework tables (users, sessions) plus any
   * app-specific tables. Pass via `import * as schema from "./db.js"`.
   */
  schema: Record<string, unknown> & SessionSchema & {
    users: typeof usersTableType;
  };
  /**
   * The code-defined RBAC config — roles, access rights, and record rules.
   * Conventionally three small files in the host app: `src/roles.ts`,
   * `src/accessRights.ts`, `src/recordRules.ts`.
   */
  rbac: RbacConfig;
  /**
   * Forwarded to {@link buildSchema}. Use this to hide sensitive output
   * columns; defaults to hiding `users.passwordHash` and `sessions.token`.
   */
  hiddenOutputColumns?: BuildSchemaOptions["hiddenOutputColumns"];
  /**
   * Forwarded to {@link buildSchema}. Use this to hide sensitive input
   * columns from the auto-generated `Insert`/`Update` types; defaults to
   * hiding `users.{passwordHash,id,createdAt}` and `sessions.{token,userId}`.
   * The `users` defaults are mass-assignment defense-in-depth: even if a
   * future role gets `users.update`, callers can't forge `id` or rewrite
   * `createdAt`. `email` and `active` remain settable because admin needs
   * them. A caller-supplied value replaces the default entirely (no merge).
   */
  hiddenInputColumns?: BuildSchemaOptions["hiddenInputColumns"];
  /** Forwarded to {@link buildSchema} — name overrides for generated types. */
  typeNames?: BuildSchemaOptions["typeNames"];
  /** Forwarded to {@link buildSchema} — bespoke Query fields. */
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
   *  - `true` (default): mounts Hono's `logger()` middleware and turns on
   *    Yoga's built-in operation logging.
   *  - `false`: no logging.
   *  - A function: passed to Hono's `logger(fn)`.
   */
  logger?: boolean | ((message: string, ...rest: string[]) => void);
  /**
   * Maximum nesting depth allowed in a GraphQL operation. Queries deeper
   * than this are rejected at validation time with a `GraphQLError`. Defends
   * against denial-of-service via deeply recursive selections through the
   * auto-generated relation fields (e.g. `todos { assigneeId { todos { ... } } }`).
   *
   * @default 10
   */
  graphqlMaxDepth?: number;
  /**
   * Allow GraphQL schema introspection (`__schema` / `__type` selections and
   * the GraphiQL IDE). When `false`, both the `NoSchemaIntrospectionCustomRule`
   * is enforced at validation time and the GraphiQL HTML/JS endpoint is
   * disabled (since GraphiQL relies on introspection).
   *
   * @default `process.env.NODE_ENV !== "production"` — introspection is on in
   * dev/test, off in production.
   */
  graphqlAllowIntrospection?: boolean;
  /**
   * Reject unauthenticated requests to the GraphQL endpoint at the HTTP layer
   * (returns `401 { "error": "Authentication required" }`) before the query
   * is even parsed. RBAC `enforce` still rejects anonymous callers inside
   * resolvers, but the HTTP gate is defense-in-depth and removes the query
   * parser as an unauthenticated attack surface.
   *
   * @default true
   */
  graphqlRequireAuth?: boolean;
  /**
   * Maximum number of rows a single list/relation query is allowed to return.
   * Caps `args.limit` server-side — a client request with a larger value
   * (or no limit at all) is clamped silently to this cap. Defends against
   * unbounded data dumps and pathological resolver fan-out.
   *
   * @default 200
   */
  maxListLimit?: number;
}

export interface CreatedApp {
  /** The Hono app — call `.fetch` from `@hono/node-server` or any Web Fetch host. */
  app: Hono<AuthEnv>;
  /** The RBAC engine — call `assignRole` / `revokeRole` to seed memberships at startup. */
  rbac: BuiltRbac;
  /**
   * Per-request RBAC-bound DB factory; re-exported so callers can write
   * custom routes. Pass the request's resolved auth context (the same shape
   * the framework's GraphQL/REST handlers build from `sessionMiddleware`).
   */
  rdbFor: (ctx: RbacContext) => RbacDb;
  /**
   * The raw, unwrapped Drizzle handle, re-exported under a name that flags
   * its bypass semantics. Use it only in pre-user bootstrap paths (startup
   * role seeding, seed scripts, anywhere that must run before a user
   * context exists). Per-request code should go through `rdbFor`.
   */
  sudoDb: SudoDb;
}

/**
 * Build the full Hono app with REST auth, REST admin, GraphQL CRUD, and
 * RBAC enforcement wired together. The RBAC engine is built synchronously
 * from the code config; memberships start empty and are added via the
 * returned `rbac` handle or the admin REST endpoints.
 */
export function createApp(opts: CreateAppOptions): CreatedApp {
  const {
    db,
    schema,
    rbac: rbacConfig,
    hiddenOutputColumns = { users: ["passwordHash"], sessions: ["token"] },
    hiddenInputColumns = { users: ["passwordHash"], sessions: ["token", "userId"] },
    typeNames,
    extraQueryFields,
    extraMutationFields,
    publicDir = "./public",
    graphqlEndpoint = "/graphql",
    logger: loggerOpt = true,
    graphqlMaxDepth = 10,
    graphqlAllowIntrospection = process.env.NODE_ENV !== "production",
    graphqlRequireAuth = true,
    maxListLimit = 200,
  } = opts;
  const loggingEnabled = loggerOpt !== false;
  const log = logger.child({ component: "framework.app" });

  const sessionSchema: SessionSchema = {
    users: schema.users,
    sessions: schema.sessions,
  };

  // Merge framework-owned roles (currently just `admin`) into the user-supplied
  // config. Apps should not redefine `admin`; if they do, mergeFrameworkRbac throws.
  const mergedRbac = mergeFrameworkRbac(rbacConfig);
  const rbac = buildRbac(mergedRbac);

  const { schema: gqlSchema } = buildSchema(db, schema, {
    hiddenOutputColumns,
    hiddenInputColumns,
    typeNames,
    extraQueryFields,
    extraMutationFields,
    rbac: { enforce: rbac.enforce },
    maxListLimit,
  });

  const rdbFor = buildRbacDb({ db, schema, enforce: rbac.enforce });

  interface ServerCtx {
    user: User | null;
    session: Session | null;
  }

  interface YogaContext {
    user: User | null;
    session: Session | null;
    batch: Map<string, unknown>;
    db: RbacDb;
  }

  const yoga = createYoga<ServerCtx, YogaContext>({
    schema: gqlSchema,
    graphqlEndpoint,
    // GraphiQL serves an interactive query console and depends on
    // introspection to power its autocomplete; keep them in lock-step so
    // production never exposes either.
    graphiql: graphqlAllowIntrospection,
    logging: loggingEnabled,
    plugins: [
      {
        onValidate({ addValidationRule }) {
          addValidationRule(depthLimit(graphqlMaxDepth));
          if (!graphqlAllowIntrospection) {
            // Rejects any selection of `__schema` / `__type` at validation
            // time, so the parser still runs but the schema shape is not
            // discoverable through query traffic.
            addValidationRule(NoSchemaIntrospectionCustomRule);
          }
        },
      },
    ],
    context: async ({ user, session }) => {
      const batch = new Map<string, unknown>();
      return {
        user: user ?? null,
        session: session ?? null,
        batch,
        db: rdbFor({ user: user ?? null, batch }),
      };
    },
  });

  const app = new Hono<AuthEnv>();

  if (loggingEnabled) {
    const httpLog = logger.child({ component: "framework.app.http" });
    const sink =
      typeof loggerOpt === "function"
        ? loggerOpt
        : (message: string, ...rest: string[]) => {
            const raw = rest.length ? `${message} ${rest.join(" ")}` : message;
            const line = raw.replace(ANSI_RE, "");
            const status = pickHttpStatus(rest);
            if (status != null && status >= 500) httpLog.error(line);
            else if (status != null && status >= 400) httpLog.warn(line);
            else httpLog.info(line);
          };
    app.use("*", honoLogger(sink));
  }
  log.debug({ graphqlEndpoint, publicDir: publicDir ?? null }, "app composed");

  app.route(
    "/auth",
    buildAuthRoutes({
      db,
      schema: sessionSchema,
    }),
  );
  app.route(
    "/admin",
    buildAdminRoutes({
      db,
      schema: sessionSchema,
      usersTable: schema.users,
      rdbFor,
      rbac,
    }),
  );

  app.use(graphqlEndpoint, sessionMiddleware(db, sessionSchema));
  app.use(graphqlEndpoint, csrfProtection);
  app.all(graphqlEndpoint, async (c) => {
    if (graphqlRequireAuth && !c.get("user")) {
      // Reject anonymous traffic before query parsing — closes the parser as
      // an unauthenticated attack surface. Resolver-level RBAC `enforce` would
      // also reject this caller, but only after parse + validate + execute.
      return c.json({ error: "Authentication required" }, 401);
    }
    return yoga.fetch(c.req.raw, {
      user: c.get("user"),
      session: c.get("session"),
    });
  });

  if (publicDir) {
    void import("@hono/node-server/serve-static").then(({ serveStatic }) => {
      app.use("/*", serveStatic({ root: publicDir }));
    });
  }

  return { app, rbac, rdbFor, sudoDb: db };
}
