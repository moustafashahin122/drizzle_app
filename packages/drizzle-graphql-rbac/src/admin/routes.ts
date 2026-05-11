/**
 * @module admin/routes
 *
 * REST endpoints for the admin dashboard's user CRUD and role membership.
 * User CRUD is RBAC-enforced via {@link RbacDb}. Role membership is held in
 * the in-memory RBAC engine — these handlers translate HTTP into engine calls.
 *
 * | Method | Path                          | Body                                | Auth |
 * |--------|-------------------------------|-------------------------------------|------|
 * | GET    | /admin/users                  | —                                   | yes  |
 * | POST   | /admin/users                  | { name, email, password, active? }  | yes  |
 * | PATCH  | /admin/users/:id              | partial { name, email, active }     | yes  |
 * | DELETE | /admin/users/:id              | —                                   | yes  |
 * | GET    | /admin/roles                  | —                                   | yes  |
 * | GET    | /admin/users/:id/roles        | —                                   | yes  |
 * | POST   | /admin/users/:id/roles        | { roleKey }                         | yes  |
 * | DELETE | /admin/users/:id/roles/:key   | —                                   | yes  |
 *
 * Roles themselves are code-defined; this module only manages membership.
 * Adding a user to a role that isn't defined in the code config returns 400.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import bcrypt from "bcryptjs";
import { asc, eq, getTableColumns } from "drizzle-orm";
import type { User, users as usersTableType } from "../tables.js";
import type { RbacDb } from "../graphql/rbac/rbacDb.js";
import type { BuiltRbac } from "../graphql/rbac/rbac.js";
import type { ColumnMap } from "../graphql/builder/filters.js";
import { csrfProtection, requireAuth, requireAdmin, sessionMiddleware, type AuthEnv } from "../auth/middleware.js";
import type { SudoDb, SessionSchema } from "../auth/session.js";

function publicUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

function errorResponse(err: any): { status: ContentfulStatusCode; body: { error: string } } {
  const code = err?.extensions?.code;
  if (code === "FORBIDDEN") return { status: 403, body: { error: err.message } };
  if (code === "BAD_USER_INPUT") return { status: 400, body: { error: err.message } };
  if (code === "UNAUTHENTICATED") return { status: 401, body: { error: err.message } };
  return { status: 500, body: { error: err?.message ?? "Internal error" } };
}

export interface AdminRoutesDeps {
  /** Raw db, used for session resolution. */
  db: SudoDb;
  schema: SessionSchema;
  /** The `users` Drizzle table — passed in so this module has no hard dependency on `../db.js`. */
  usersTable: typeof usersTableType;
  /** Per-request RBAC-bound db factory built by `buildRbacDb`. */
  rdbFor: (ctx: { user: User | null; batch?: Map<string, unknown> }) => RbacDb;
  /** The RBAC engine — used for role-membership lookups, mutations, and enforcement. */
  rbac: BuiltRbac;
}

/**
 * Build the `/admin/*` Hono sub-app. Mount with
 * `app.route("/admin", buildAdminRoutes(deps))`.
 */
export function buildAdminRoutes(deps: AdminRoutesDeps) {
  const { db, schema, rdbFor, usersTable, rbac } = deps;
  const usersColumns = getTableColumns(usersTable) as ColumnMap;
  const app = new Hono<AuthEnv>();
  app.use("*", sessionMiddleware(db, schema));
  app.use("*", csrfProtection);
  app.use("*", requireAuth);
  // Every /admin route is admin-only. The per-endpoint `users` permission
  // checks below are kept as defense-in-depth, but this top-level gate is the
  // policy: no non-admin role gets access to the admin sub-app, regardless of
  // what RBAC grants they may have on `users`.
  app.use("*", requireAdmin((userId) => rbac.isAdmin(userId)));

  const rdbForReq = (c: any): RbacDb =>
    rdbFor({ user: c.get("user"), batch: new Map() });

  const requirePerm = (c: any, action: "read" | "update" | "delete") =>
    rbac.enforce(
      { user: c.get("user"), batch: new Map() },
      "users",
      action,
      usersColumns,
    );

  app.get("/users", async (c) => {
    try {
      const rdb = rdbForReq(c);
      const rows: User[] = await rdb
        .select()
        .from(usersTable)
        .orderBy(asc(usersTable.id));
      return c.json({ users: rows.map(publicUser) });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status);
    }
  });

  app.post("/users", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const active = typeof body.active === "boolean" ? body.active : true;
    if (!name || !email || !password) {
      return c.json({ error: "name, email and password are required" }, 400);
    }

    try {
      const rdb = rdbForReq(c);
      const passwordHash = await bcrypt.hash(password, 12);
      const [row] = await rdb
        .insert(usersTable)
        .values({ name, email, passwordHash, active })
        .returning();
      return c.json({ user: publicUser(row as User) }, 201);
    } catch (err: any) {
      if (String(err?.message ?? "").includes("UNIQUE")) {
        return c.json({ error: "Email already registered" }, 409);
      }
      const r = errorResponse(err);
      return c.json(r.body, r.status);
    }
  });

  app.patch("/users/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);

    const body = await c.req.json().catch(() => ({}));
    const set: Record<string, unknown> = {};
    if (typeof body.name === "string") set.name = body.name.trim();
    if (typeof body.email === "string") set.email = body.email.trim();
    if (typeof body.active === "boolean") set.active = body.active;
    if (typeof body.password === "string" && body.password.length > 0) {
      set.passwordHash = await bcrypt.hash(body.password, 12);
    }
    if (!Object.keys(set).length) {
      return c.json({ error: "No editable fields supplied" }, 400);
    }

    try {
      const rdb = rdbForReq(c);
      const rows: User[] = await rdb
        .update(usersTable)
        .set(set)
        .where(eq(usersTable.id, id))
        .returning();
      if (!rows.length) return c.json({ error: "Not found" }, 404);
      if (set.passwordHash) {
        await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      }
      return c.json({ user: publicUser(rows[0]) });
    } catch (err: any) {
      if (String(err?.message ?? "").includes("UNIQUE")) {
        return c.json({ error: "Email already registered" }, 409);
      }
      const r = errorResponse(err);
      return c.json(r.body, r.status);
    }
  });

  app.delete("/users/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);

    try {
      // Pre-flight the RBAC check so the sudo session-delete below cannot run
      // for a caller who would have been denied the user-delete (otherwise we'd
      // give unauthorized callers a free way to invalidate any user's sessions).
      await requirePerm(c, "delete");
      // Sessions must go first — `sessions.user_id` has a FK to `users.id`, so
      // with `foreign_keys=ON` the user delete fails while children exist.
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      const rdb = rdbForReq(c);
      const rows: User[] = await rdb
        .delete(usersTable)
        .where(eq(usersTable.id, id))
        .returning();
      if (!rows.length) return c.json({ error: "Not found" }, 404);
      // Drop any in-memory role assignments for the deleted user.
      for (const key of rbac.listUserRoles(id)) rbac.revokeRole(id, key);
      return c.json({ id });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status);
    }
  });

  // -------------------------------------------------------------------------
  // Role membership (in-memory)
  // -------------------------------------------------------------------------

  app.get("/roles", async (c) => {
    try {
      await requirePerm(c, "read");
      return c.json({ roles: rbac.listRoleKeys() });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status);
    }
  });

  app.get("/users/:id/roles", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
    try {
      await requirePerm(c, "read");
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, id))
        .limit(1);
      if (!user) return c.json({ error: "Not found" }, 404);
      return c.json({ userId: id, roles: rbac.listUserRoles(id) });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status);
    }
  });

  app.post("/users/:id/roles", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const roleKey = typeof body.roleKey === "string" ? body.roleKey.trim() : "";
    if (!roleKey) return c.json({ error: "roleKey is required" }, 400);
    try {
      await requirePerm(c, "update");
      if (!rbac.hasRole(roleKey)) {
        return c.json({ error: `Unknown role '${roleKey}'` }, 400);
      }
      const callerUser = c.get("user")!;
      const callerIsAdmin = rbac.listUserRoles(callerUser.id).includes("admin");
      if (roleKey === "admin" && !callerIsAdmin) {
        return c.json({ error: "Only admins can grant the admin role" }, 403);
      }
      const [target] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, id))
        .limit(1);
      if (!target) return c.json({ error: "Not found" }, 404);
      rbac.assignRole(id, roleKey);
      return c.json({ userId: id, roles: rbac.listUserRoles(id) }, 201);
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status);
    }
  });

  app.delete("/users/:id/roles/:key", async (c) => {
    const id = Number(c.req.param("id"));
    const roleKey = c.req.param("key");
    if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
    if (!roleKey) return c.json({ error: "roleKey is required" }, 400);
    try {
      await requirePerm(c, "update");
      if (!rbac.hasRole(roleKey)) {
        return c.json({ error: `Unknown role '${roleKey}'` }, 400);
      }
      const callerUser = c.get("user")!;
      const callerIsAdmin = rbac.listUserRoles(callerUser.id).includes("admin");
      if (roleKey === "admin" && !callerIsAdmin) {
        return c.json({ error: "Only admins can grant the admin role" }, 403);
      }
      const [target] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, id))
        .limit(1);
      if (!target) return c.json({ error: "Not found" }, 404);
      rbac.revokeRole(id, roleKey);
      return c.json({ userId: id, roles: rbac.listUserRoles(id) });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status);
    }
  });

  return app;
}
