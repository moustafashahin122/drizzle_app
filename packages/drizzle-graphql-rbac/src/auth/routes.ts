/**
 * @module auth/routes
 *
 * REST endpoints for the four user-facing authentication flows:
 *
 * | Method | Path             | Body                              | Auth |
 * |--------|------------------|-----------------------------------|------|
 * | POST   | /auth/register   | { name, email, password }         | no   |
 * | POST   | /auth/login      | { email, password }               | no   |
 * | POST   | /auth/logout     | —                                 | yes  |
 * | GET    | /auth/me         | —                                 | yes  |
 *
 * All four issue / consume the session cookie produced by
 * {@link buildSessionCookie}. The bearer-token equivalent is still accepted
 * (resolved by {@link sessionMiddleware}) for non-browser clients.
 *
 * Password reset is intentionally out of scope here — see the project README
 * for the planned `/auth/password/*` endpoints.
 */
import { Hono } from "hono";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { User } from "../tables.js";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  destroySession,
  issueSession,
  type SessionDb,
  type SessionSchema,
} from "./session.js";
import { requireAuth, sessionMiddleware, type AuthEnv } from "./middleware.js";

/** Strip the password hash before serializing to JSON. */
function publicUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

export interface AuthRoutesDeps {
  db: SessionDb;
  schema: SessionSchema;
  /**
   * Optional hook fired after a successful `/logout` with the signed-out
   * user's id. {@link createApp} wires this to the RBAC cache's
   * `invalidateUser` so a user's cached groups / enforce results are dropped
   * on sign-out — the next login then re-reads from the DB. Safe to leave
   * unset when no caches need flushing.
   */
  onSignout?: (userId: number) => void;
}

/**
 * Build a Hono sub-app that owns `/auth/*`. Mount with
 * `app.route("/auth", buildAuthRoutes(deps))`.
 *
 * The sub-app installs {@link sessionMiddleware} itself so callers don't have
 * to remember to wrap it.
 */
export function buildAuthRoutes(deps: AuthRoutesDeps) {
  const { db, schema, onSignout } = deps;
  const app = new Hono<AuthEnv>();
  app.use("*", sessionMiddleware(db, schema));

  app.post("/register", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!name || !email || !password) {
      return c.json({ error: "name, email and password are required" }, 400);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let user: User;
    try {
      const [row] = await db
        .insert(schema.users)
        .values({ name, email, passwordHash })
        .returning();
      user = row as User;
    } catch (err: any) {
      if (String(err?.message ?? "").includes("UNIQUE")) {
        return c.json({ error: "Email already registered" }, 409);
      }
      throw err;
    }

    const { token } = await issueSession(db, schema, user.id);
    c.header("Set-Cookie", buildSessionCookie(token), { append: true });
    return c.json({ user: publicUser(user) }, 201);
  });

  app.post("/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return c.json({ error: "email and password are required" }, 400);
    }

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (!user || !user.active) {
      return c.json({ error: "Invalid credentials" }, 401);
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const { token } = await issueSession(db, schema, user.id);
    c.header("Set-Cookie", buildSessionCookie(token), { append: true });
    return c.json({ user: publicUser(user as User) });
  });

  app.post("/logout", async (c) => {
    const session = c.get("session");
    c.header("Set-Cookie", buildClearSessionCookie(), { append: true });
    if (!session) return c.json({ ok: false });
    await destroySession(db, schema, session.id);
    onSignout?.(session.userId);
    return c.json({ ok: true });
  });

  app.get("/me", requireAuth, (c) => {
    const user = c.get("user")!;
    return c.json({ user: publicUser(user) });
  });

  return app;
}
