/**
 * @module admin/routes
 *
 * REST endpoints for the admin dashboard. User CRUD is RBAC-enforced via
 * {@link RbacDb}. Role assignment writes directly to `users.role_id` — each
 * user holds at most one role.
 *
 * | Method | Path                          | Body                                | Auth |
 * |--------|-------------------------------|-------------------------------------|------|
 * | GET    | /admin/users                  | —                                   | yes  |
 * | POST   | /admin/users                  | { name, email, password, active?, roleName? } | yes  |
 * | PATCH  | /admin/users/:id              | partial { name, email, active }     | yes  |
 * | DELETE | /admin/users/:id              | —                                   | yes  |
 * | GET    | /admin/roles                  | —                                   | yes  |
 * | GET    | /admin/users/:id/role         | —                                   | yes  |
 * | PUT    | /admin/users/:id/role         | { roleName }                        | yes  |
 * | DELETE | /admin/users/:id/role         | —                                   | yes  |
 *
 * Roles themselves are code-defined and persisted into the `roles` table by
 * `syncRoles` at startup — these endpoints only read the table and update
 * `users.role_id`. Assigning a role that isn't in the table returns 400.
 */
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import bcrypt from "bcryptjs";
import { asc, eq, getTableColumns } from "drizzle-orm";
import type { User, users as usersTableType, roles as rolesTableType } from "../tables.js";
import type { RbacDb } from "../graphql/rbac/rbacDb.js";
import type { BuiltRbac, RbacContext } from "../graphql/rbac/rbac.js";
import type { ColumnMap } from "../graphql/builder/filters.js";
import {
  requireAuth,
  requireAdmin,
  sessionMiddleware,
  type AuthEnv,
  type RoleAwareSchema,
} from "../auth/middleware.js";
import type { SudoDb } from "../auth/session.js";
import {
  listRoles as listPersistedRoles,
  getUserRole,
  setUserRole,
} from "../graphql/rbac/persistence.js";
import { ADMIN_ROLE } from "../frameworkRbac.js";

class HttpError extends Error {
  constructor(public status: ContentfulStatusCode, message: string) {
    super(message);
  }
}

function publicUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

function mapError(err: any): { status: ContentfulStatusCode; body: { error: string } } {
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
  const code = err?.extensions?.code;
  if (code === "FORBIDDEN") return { status: 403, body: { error: err.message } };
  if (code === "BAD_USER_INPUT") return { status: 400, body: { error: err.message } };
  if (code === "UNAUTHENTICATED") return { status: 401, body: { error: err.message } };
  const message = String(err?.message ?? "");
  // sqlite: "UNIQUE constraint failed"; pg: "duplicate key value..." (23505).
  if (message.includes("UNIQUE") || message.includes("duplicate key") || err?.code === "23505") {
    return { status: 409, body: { error: "Email already registered" } };
  }
  return { status: 500, body: { error: err?.message ?? "Internal error" } };
}

export interface AdminRoutesDeps {
  /** Raw db, used for session resolution and direct role writes. */
  db: SudoDb;
  schema: RoleAwareSchema;
  /** The `users` Drizzle table — passed in so this module has no hard dependency on `../db.js`. */
  usersTable: typeof usersTableType;
  /** The `roles` Drizzle table — used to list / look up roles for assignment. */
  rolesTable: typeof rolesTableType;
  /** Per-request RBAC-bound db factory built by `buildRbacDb`. */
  rdbFor: (ctx: import("../graphql/rbac/rbac.js").RbacContext) => RbacDb;
  /** The RBAC engine — used for resource enforcement. */
  rbac: BuiltRbac;
}

/**
 * Build the `/admin/*` Hono sub-app. Mount with
 * `app.route("/admin", buildAdminRoutes(deps))`.
 */
export function buildAdminRoutes(deps: AdminRoutesDeps) {
  const { db, schema, rdbFor, usersTable, rbac } = deps;
  const usersColumns = getTableColumns(usersTable) as ColumnMap;
  const persistenceSchema = { users: schema.users, roles: schema.roles };
  const app = new Hono<AuthEnv>();
  app.use("*", sessionMiddleware(db, schema));
  app.use("*", requireAuth);
  // Every /admin route is admin-only. The per-endpoint `users` permission
  // checks below are kept as defense-in-depth, but this top-level gate is the
  // policy: no non-admin role gets access to the admin sub-app, regardless of
  // what RBAC grants they may have on `users`.
  app.use("*", requireAdmin);

  app.onError((err, c) => {
    const r = mapError(err);
    return c.json(r.body, r.status);
  });

  const ctxFor = (c: Context<AuthEnv>): RbacContext => ({
    user: c.get("user"),
    role: c.get("role"),
    batch: new Map(),
  });

  const rdbForReq = (c: Context<AuthEnv>): RbacDb => rdbFor(ctxFor(c));

  const requirePerm = (c: Context<AuthEnv>, action: "read" | "update" | "delete") =>
    rbac.enforce(ctxFor(c), "users", action, usersColumns);

  const parseIdParam = (c: Context<AuthEnv>): number => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) throw new HttpError(400, "Invalid id");
    return id;
  };

  const requireUserExists = async (id: number): Promise<void> => {
    const [row] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);
    if (!row) throw new HttpError(404, "Not found");
  };

  app.get("/users", async (c) => {
    const rows: User[] = await rdbForReq(c)
      .select()
      .from(usersTable)
      .orderBy(asc(usersTable.id));
    return c.json({ users: rows.map(publicUser) });
  });

  app.post("/users", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const active = typeof body.active === "boolean" ? body.active : true;
    const roleName = typeof body.roleName === "string" ? body.roleName.trim() : "";
    if (!name || !email || !password) {
      throw new HttpError(400, "name, email and password are required");
    }

    // Look up role up front so we surface a 400 before hashing the password.
    let roleId: number | null = null;
    if (roleName) {
      const persisted = await listPersistedRoles(db, persistenceSchema);
      const role = persisted.find((r) => r.name === roleName);
      if (!role) throw new HttpError(400, `Unknown role '${roleName}'`);
      if (role.name === ADMIN_ROLE) {
        const callerRole = c.get("role");
        if (callerRole?.name !== ADMIN_ROLE) {
          throw new HttpError(403, "Only admins can grant the admin role");
        }
      }
      roleId = role.id;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [row] = await rdbForReq(c)
      .insert(usersTable)
      .values({ name, email, passwordHash, active, roleId })
      .returning();
    return c.json({ user: publicUser(row as User) }, 201);
  });

  app.patch("/users/:id", async (c) => {
    const id = parseIdParam(c);
    const body = await c.req.json().catch(() => ({}));
    const set: Record<string, unknown> = {};
    if (typeof body.name === "string") set.name = body.name.trim();
    if (typeof body.email === "string") set.email = body.email.trim();
    if (typeof body.active === "boolean") set.active = body.active;
    if (typeof body.password === "string" && body.password.length > 0) {
      set.passwordHash = await bcrypt.hash(body.password, 12);
    }
    if (!Object.keys(set).length) {
      throw new HttpError(400, "No editable fields supplied");
    }

    const rows: User[] = await rdbForReq(c)
      .update(usersTable)
      .set(set)
      .where(eq(usersTable.id, id))
      .returning();
    if (!rows.length) throw new HttpError(404, "Not found");
    if (set.passwordHash) {
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
    }
    return c.json({ user: publicUser(rows[0]) });
  });

  app.delete("/users/:id", async (c) => {
    const id = parseIdParam(c);
    // Pre-flight the RBAC check so the sudo session-delete below cannot run
    // for a caller who would have been denied the user-delete (otherwise we'd
    // give unauthorized callers a free way to invalidate any user's sessions).
    await requirePerm(c, "delete");
    // Sessions must go first — `sessions.user_id` has a FK to `users.id`, so
    // with `foreign_keys=ON` the user delete fails while children exist. The
    // user's `role_id` column is just a value on the row about to be deleted;
    // no cleanup needed on the roles table.
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
    const rows: User[] = await rdbForReq(c)
      .delete(usersTable)
      .where(eq(usersTable.id, id))
      .returning();
    if (!rows.length) throw new HttpError(404, "Not found");
    return c.json({ id });
  });

  // -------------------------------------------------------------------------
  // Role assignment (DB-backed; one role per user)
  // -------------------------------------------------------------------------

  app.get("/roles", async (c) => {
    await requirePerm(c, "read");
    const rows = await listPersistedRoles(db, persistenceSchema);
    return c.json({
      roles: rows
        .map((r) => ({ name: r.name, isAdmin: r.isAdmin }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  app.get("/users/:id/role", async (c) => {
    const id = parseIdParam(c);
    await requirePerm(c, "read");
    await requireUserExists(id);
    const role = await getUserRole(db, persistenceSchema, id);
    return c.json({
      userId: id,
      role: role ? { name: role.name, isAdmin: role.isAdmin } : null,
    });
  });

  app.put("/users/:id/role", async (c) => {
    const id = parseIdParam(c);
    const body = (await c.req.json().catch(() => ({}))) as { roleName?: unknown };
    const roleName = typeof body.roleName === "string" ? body.roleName.trim() : "";
    if (!roleName) throw new HttpError(400, "roleName is required");

    await requirePerm(c, "update");

    const callerRole = c.get("role");
    if (roleName === ADMIN_ROLE && callerRole?.name !== ADMIN_ROLE) {
      throw new HttpError(403, "Only admins can grant the admin role");
    }

    await requireUserExists(id);
    let assigned;
    try {
      assigned = await setUserRole(db, persistenceSchema, id, roleName);
    } catch (e: any) {
      if (String(e?.message ?? "").startsWith("rbac: unknown role")) {
        throw new HttpError(400, `Unknown role '${roleName}'`);
      }
      throw e;
    }
    // Invalidate the target user's sessions so the new role takes effect on
    // their next request rather than across a long-lived cookie.
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
    return c.json({
      userId: id,
      role: assigned ? { name: assigned.name, isAdmin: assigned.isAdmin } : null,
    });
  });

  app.delete("/users/:id/role", async (c) => {
    const id = parseIdParam(c);
    await requirePerm(c, "update");

    // Revoking the admin role from another admin requires the caller to be
    // an admin themselves — same policy as PUT, applied to the demotion path.
    const callerRole = c.get("role");
    const target = await getUserRole(db, persistenceSchema, id);
    if (target?.name === ADMIN_ROLE && callerRole?.name !== ADMIN_ROLE) {
      throw new HttpError(403, "Only admins can revoke the admin role");
    }

    await requireUserExists(id);
    await setUserRole(db, persistenceSchema, id, null);
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
    return c.json({ userId: id, role: null });
  });

  return app;
}
