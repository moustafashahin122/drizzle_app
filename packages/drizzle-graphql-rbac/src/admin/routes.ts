/**
 * @module admin/routes
 *
 * REST endpoints for the admin dashboard's user CRUD. RBAC is enforced
 * automatically by {@link RbacDb} — these handlers are thin translation
 * layers between HTTP and Drizzle.
 *
 * | Method | Path                | Body                                | Auth |
 * |--------|---------------------|-------------------------------------|------|
 * | GET    | /admin/users        | —                                   | yes  |
 * | POST   | /admin/users        | { name, email, password, active? }  | yes  |
 * | PATCH  | /admin/users/:id    | partial { name, email, active }     | yes  |
 * | DELETE | /admin/users/:id    | —                                   | yes  |
 *
 * "Auth: yes" means the request must carry a valid session and the caller's
 * groups must grant the corresponding action on the `users` resource. The
 * RbacDb wrapper throws `FORBIDDEN` on deny, which the route translates to a
 * 403 JSON body. `passwordHash` is never returned.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import bcrypt from "bcryptjs";
import { asc, eq } from "drizzle-orm";
import type { User, users as usersTableType } from "../tables.js";
import type { RbacDb } from "../graphql/rbac/rbacDb.js";
import { requireAuth, sessionMiddleware, type AuthEnv } from "../auth/middleware.js";
import type { SessionDb, SessionSchema } from "../auth/session.js";

function publicUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

/** Translate an RBAC throw into a JSON response status. */
function errorResponse(err: any): { status: ContentfulStatusCode; body: { error: string } } {
  const code = err?.extensions?.code;
  if (code === "FORBIDDEN") return { status: 403, body: { error: err.message } };
  if (code === "BAD_USER_INPUT") return { status: 400, body: { error: err.message } };
  if (code === "UNAUTHENTICATED") return { status: 401, body: { error: err.message } };
  return { status: 500, body: { error: err?.message ?? "Internal error" } };
}

export interface AdminRoutesDeps {
  /** The raw db is used only for session resolution. */
  db: SessionDb;
  schema: SessionSchema;
  /** The `users` Drizzle table — passed in so this module has no hard dependency on `../db.js`. */
  usersTable: typeof usersTableType;
  /** Per-request RBAC-bound db factory built by `buildRbacDb`. */
  rdbFor: (ctx: { user: User | null; batch?: Map<string, unknown> }) => RbacDb;
}

/**
 * Build the `/admin/*` Hono sub-app. Mount with
 * `app.route("/admin", buildAdminRoutes(deps))`.
 *
 * The sub-app installs {@link sessionMiddleware} + {@link requireAuth} on
 * every route — RBAC then narrows further per-resource.
 */
export function buildAdminRoutes(deps: AdminRoutesDeps) {
  const { db, schema, rdbFor, usersTable } = deps;
  const app = new Hono<AuthEnv>();
  app.use("*", sessionMiddleware(db, schema));
  app.use("*", requireAuth);

  /** Build a per-request RBAC db bound to the current user. */
  const rdbForReq = (c: any): RbacDb =>
    rdbFor({ user: c.get("user"), batch: new Map() });

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
      const passwordHash = await bcrypt.hash(password, 10);
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
      set.passwordHash = await bcrypt.hash(body.password, 10);
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
      const rdb = rdbForReq(c);
      const rows: User[] = await rdb
        .delete(usersTable)
        .where(eq(usersTable.id, id))
        .returning();
      if (!rows.length) return c.json({ error: "Not found" }, 404);
      return c.json({ id });
    } catch (err) {
      const r = errorResponse(err);
      return c.json(r.body, r.status);
    }
  });

  return app;
}
