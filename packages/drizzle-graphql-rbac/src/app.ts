/**
 * @module drizzle-graphql-rbac/app
 *
 * `createApp` is the all-in-one composition root. It wires:
 *
 * 1. {@link buildSchema} — auto-generated GraphQL CRUD over the user's Drizzle
 *    schema (your tables plus the framework's `users` / `sessions` / `roles`).
 * 2. {@link buildRbac} — RBAC engine built synchronously from the in-code role
 *    config. The engine is read-only; user→role membership is persisted in
 *    `users.role_id` and reconciled with the `roles` table by `syncRoles`.
 * 3. {@link buildAuthRoutes} — REST `/auth/{register,login,logout,me}`.
 * 4. {@link buildAdminRoutes} — REST `/admin/users` (RBAC-enforced) plus
 *    `/admin/users/:id/role` for managing role assignment.
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
 * // Role assignment is DB-backed — use the admin REST endpoints
 * // (`PUT /admin/users/:id/role`) or `setUserRole(sudoDb, ...)` from
 * // `graphql/rbac/persistence` for seed scripts.
 * serve({ fetch: app.fetch, port: 3000 });
 */
import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { createYoga } from "graphql-yoga";
import { NoSchemaIntrospectionCustomRule } from "graphql/validation";
import { buildSchema, type BuildSchemaOptions } from "./graphql/builder/builder.js";
import { depthLimit } from "./graphql/index.js";
import {
  buildRbac,
  type BuiltRbac,
  type RbacContext,
  type ResolvedUserRole,
} from "./graphql/rbac/rbac.js";
import type { RbacConfig } from "./graphql/rbac/config.js";
import { mergeFrameworkRbac } from "./frameworkRbac.js";
import { buildRbacDb, type RbacDb } from "./graphql/rbac/rbacDb.js";
import {
  syncRoles as syncRolesPersistence,
  getUserRole,
  setUserRole,
  listRoles,
  type RolePersistenceSchema,
} from "./graphql/rbac/persistence.js";
import { buildAuthRoutes } from "./auth/routes.js";
import { buildAdminRoutes } from "./admin/routes.js";
import { sessionMiddleware, type AuthEnv, type RoleAwareSchema } from "./auth/middleware.js";
import { createCsrfProtection, type CsrfConfig } from "./auth/csrf.js";
import { type SudoDb } from "./auth/session.js";
import { logger } from "./logger.js";
import type { User, Session, Role, roles as rolesTable } from "./tables.js";

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
   *
   * `Record<string, unknown>` keeps the namespace open to arbitrary additional
   * exports (other tables, `relations(...)` declarations, type aliases) — the
   * builder iterates this map and brand-checks each entry, so over-tightening
   * here would force every host app to upcast at the call site.
   */
  schema: Record<string, unknown> & SessionSchema & { roles: typeof rolesTable };
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
  /**
   * CSRF protection (origin-based, via Hono's built-in `csrf` middleware).
   *  - omitted / default `{}` → enabled with the same-origin policy
   *  - `{ origin: ... }`      → enabled with a custom allowlist
   *  - `false`                → disabled (do this only if you front the app
   *                              with a separate CSRF-aware gateway)
   */
  csrf?: CsrfConfig | false;
}

export interface CreatedApp {
  /** The Hono app — call `.fetch` from `@hono/node-server` or any Web Fetch host. */
  app: Hono<AuthEnv>;
  /** The RBAC engine — read-only registry; runtime state lives in the DB. */
  rbac: BuiltRbac;
  /**
   * Reconcile the persisted `roles` table with the in-code role config and
   * refresh `is_admin` on every surviving row. Idempotent — safe to call at
   * any time. `createApp` already runs this once before returning, so most
   * callers do not need to invoke it manually; re-call it after a config
   * reload or a manual DB edit if you need to re-converge.
   */
  syncRoles(): Promise<Role[]>;
  /**
   * Per-request RBAC-bound DB factory; re-exported so callers can write
   * custom routes. Pass the request's resolved auth context (the same shape
   * the framework's GraphQL/REST handlers build from `sessionMiddleware`).
   */
  rdbFor: (ctx: RbacContext) => RbacDb;
  /**
   * The raw, unwrapped Drizzle handle, re-exported under a name that flags
   * its bypass semantics. Use it only in pre-user bootstrap paths (seed
   * scripts, anywhere that must run before a user context exists).
   * Per-request code should go through `rdbFor`.
   */
  sudoDb: SudoDb;
}

/**
 * Build the full Hono app with REST auth, REST admin, GraphQL CRUD, and
 * RBAC enforcement wired together.
 *
 * Returns a Promise: this function runs `syncRoles` against the DB as part
 * of construction so the `roles` table is reconciled with the in-code
 * config before the app starts handling traffic. Host code should `await`
 * `createApp(...)` before calling `serve(...)`.
 *
 * The returned `syncRoles()` is still exposed for callers that want to
 * re-run reconciliation later (e.g. seed scripts or hot config reload).
 */
export async function createApp(opts: CreateAppOptions): Promise<CreatedApp> {
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
    csrf: csrfOpt = {},
  } = opts;
  const loggingEnabled = loggerOpt !== false;
  const log = logger.child({ component: "framework.app" });

  const roleSchema: RolePersistenceSchema = {
    users: schema.users,
    roles: schema.roles,
  };
  const roleAwareSchema: RoleAwareSchema = {
    users: schema.users,
    sessions: schema.sessions,
    roles: schema.roles,
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
    role: ResolvedUserRole | null;
  }

  interface YogaContext {
    user: User | null;
    session: Session | null;
    role: ResolvedUserRole | null;
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- yoga plugin args are inferred via the generic context type which the loose top-level YogaContext shape elides; refining each plugin would require duplicating the generic.
        onValidate({ addValidationRule, context }: { addValidationRule: (rule: any) => void; context: any }) {
          addValidationRule(depthLimit(graphqlMaxDepth));
          // Introspection is gated to admins even when allowed by config:
          // GraphiQL's autocomplete reveals the full schema shape (including
          // hidden columns by name), so non-admin sessions only ever see the
          // surface they're allowed to query. The role was pre-resolved by
          // `sessionMiddleware` so this stays synchronous.
          const role = (context as { role?: ResolvedUserRole | null } | undefined)?.role ?? null;
          if (!graphqlAllowIntrospection || role?.isAdmin !== true) {
            addValidationRule(NoSchemaIntrospectionCustomRule);
          }
        },
      },
    ],
    context: async ({ user, session, role }) => {
      const batch = new Map<string, unknown>();
      return {
        user: user ?? null,
        session: session ?? null,
        role: role ?? null,
        batch,
        db: rdbFor({ user: user ?? null, role: role ?? null, batch }),
      };
    },
  });

  const app = new Hono<AuthEnv>();

  if (loggingEnabled) {
    let sink: (message: string, ...rest: string[]) => void;
    if (typeof loggerOpt === "function") {
      sink = loggerOpt;
    } else {
      const httpLog = logger.child({ component: "framework.app.http" });
      sink = (message, ...rest) => {
        const raw = rest.length ? `${message} ${rest.join(" ")}` : message;
        const line = raw.replace(ANSI_RE, "");
        const status = pickHttpStatus(rest);
        if (status != null && status >= 500) httpLog.error(line);
        else if (status != null && status >= 400) httpLog.warn(line);
        else httpLog.info(line);
      };
    }
    app.use("*", honoLogger(sink));
  }

  if (csrfOpt !== false) {
    // Mount CSRF protection globally so every route (auth, admin, graphql,
    // static) gets the same origin-based gate. JSON-only callers are
    // unaffected; see auth/csrf.ts for the threat model.
    app.use("*", createCsrfProtection(csrfOpt).middleware);
  }
  log.debug({ graphqlEndpoint, publicDir: publicDir ?? null }, "app composed");

  app.route(
    "/auth",
    buildAuthRoutes({
      db,
      schema: roleAwareSchema,
    }),
  );
  app.route(
    "/admin",
    buildAdminRoutes({
      db,
      schema: roleAwareSchema,
      usersTable: schema.users,
      rolesTable: schema.roles,
      rdbFor,
      rbac,
    }),
  );

  app.use(graphqlEndpoint, sessionMiddleware(db, roleAwareSchema));
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
      role: c.get("role"),
    });
  });

  if (publicDir) {
    const { serveStatic } = await import("@hono/node-server/serve-static");
    app.use("/*", serveStatic({ root: publicDir }));
  }

  const syncRoles = () => syncRolesPersistence(db, roleSchema, rbac.roles());

  // Reconcile the `roles` table with the in-code role config before the
  // returned app is allowed to serve traffic. Failures here are surfaced
  // synchronously so the host can decide whether to abort startup.
  await syncRoles();

  return { app, rbac, syncRoles, rdbFor, sudoDb: db };
}

// Re-exported helpers — host apps building custom routes against role state
// can reach them through `createApp`'s exports without learning about the
// persistence-module path.
export { getUserRole, setUserRole, listRoles };
