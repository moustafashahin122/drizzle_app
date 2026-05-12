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
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import bcrypt from "bcryptjs";
import { asc, eq, getTableColumns } from "drizzle-orm";
import type { User, users as usersTableType } from "../tables.js";
import type { RbacDb } from "../graphql/rbac/rbacDb.js";
import type { BuiltRbac } from "../graphql/rbac/rbac.js";
import type { ColumnMap } from "../graphql/builder/filters.js";
import { requireAuth, requireAdmin, sessionMiddleware, type AuthEnv } from "../auth/middleware.js";
import type { SudoDb, SessionSchema } from "../auth/session.js";
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
  if (String(err?.message ?? "").includes("UNIQUE")) {
    return { status: 409, body: { error: "Email already registered" } };
  }
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
  app.use("*", requireAuth);
  // Every /admin route is admin-only. The per-endpoint `users` permission
  // checks below are kept as defense-in-depth, but this top-level gate is the
  // policy: no non-admin role gets access to the admin sub-app, regardless of
  // what RBAC grants they may have on `users`.
  app.use("*", requireAdmin((userId) => rbac.isAdmin(userId)));

  app.onError((err, c) => {
    const r = mapError(err);
    return c.json(r.body, r.status);
  });

  const rdbForReq = (c: Context<AuthEnv>): RbacDb =>
    rdbFor({ user: c.get("user"), batch: new Map() });

  const requirePerm = (c: Context<AuthEnv>, action: "read" | "update" | "delete") =>
    rbac.enforce(
      { user: c.get("user"), batch: new Map() },
      "users",
      action,
      usersColumns,
    );

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

  const readRoleKey = async (
    c: Context<AuthEnv>,
    op: "assign" | "revoke",
  ): Promise<string> => {
    if (op === "revoke") return c.req.param("key") ?? "";
    const body = (await c.req.json().catch(() => ({}))) as { roleKey?: unknown };
    return typeof body.roleKey === "string" ? body.roleKey.trim() : "";
  };

  const mutateUserRole = async (
    c: Context<AuthEnv>,
    op: "assign" | "revoke",
  ) => {
    const id = parseIdParam(c);
    const roleKey = await readRoleKey(c, op);
    if (!roleKey) throw new HttpError(400, "roleKey is required");

    await requirePerm(c, "update");
    if (!rbac.hasRole(roleKey)) throw new HttpError(400, `Unknown role '${roleKey}'`);

    const caller = c.get("user")!;
    if (roleKey === ADMIN_ROLE && !rbac.listUserRoles(caller.id).includes(ADMIN_ROLE)) {
      const verb = op === "assign" ? "grant" : "revoke";
      throw new HttpError(403, `Only admins can ${verb} the admin role`);
    }

    await requireUserExists(id);

    if (op === "assign") {
      rbac.assignRole(id, roleKey);
      return c.json({ userId: id, roles: rbac.listUserRoles(id) }, 201);
    }
    rbac.revokeRole(id, roleKey);
    return c.json({ userId: id, roles: rbac.listUserRoles(id) });
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
    if (!name || !email || !password) {
      throw new HttpError(400, "name, email and password are required");
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [row] = await rdbForReq(c)
      .insert(usersTable)
      .values({ name, email, passwordHash, active })
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
    // with `foreign_keys=ON` the user delete fails while children exist.
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
    const rows: User[] = await rdbForReq(c)
      .delete(usersTable)
      .where(eq(usersTable.id, id))
      .returning();
    if (!rows.length) throw new HttpError(404, "Not found");
    for (const key of rbac.listUserRoles(id)) rbac.revokeRole(id, key);
    return c.json({ id });
  });

  // -------------------------------------------------------------------------
  // Role membership (in-memory)
  // -------------------------------------------------------------------------

  app.get("/roles", async (c) => {
    await requirePerm(c, "read");
    return c.json({ roles: rbac.listRoleKeys() });
  });

  app.get("/users/:id/roles", async (c) => {
    const id = parseIdParam(c);
    await requirePerm(c, "read");
    await requireUserExists(id);
    return c.json({ userId: id, roles: rbac.listUserRoles(id) });
  });

  app.post("/users/:id/roles", (c) => mutateUserRole(c, "assign"));
  app.delete("/users/:id/roles/:key", (c) => mutateUserRole(c, "revoke"));

  return app;
}
