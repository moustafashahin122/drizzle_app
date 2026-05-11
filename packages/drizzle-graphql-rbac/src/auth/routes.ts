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
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { User } from "../tables.js";
import {
  buildClearCsrfCookie,
  buildClearSessionCookie,
  buildCsrfCookie,
  buildSessionCookie,
  destroySession,
  issueSession,
  type SudoDb,
  type SessionSchema,
} from "./session.js";
import { csrfProtection, requireAuth, sessionMiddleware, type AuthEnv } from "./middleware.js";

const BCRYPT_ROUNDS = 12;
// Pre-computed dummy hash so /auth/login does a bcrypt compare for unknown
// emails too — equalizes timing and frustrates user-enumeration.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", BCRYPT_ROUNDS);

function newCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

/** Strip the password hash before serializing to JSON. */
function publicUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

export interface AuthRoutesDeps {
  db: SudoDb;
  schema: SessionSchema;
}

/**
 * Build a Hono sub-app that owns `/auth/*`. Mount with
 * `app.route("/auth", buildAuthRoutes(deps))`.
 *
 * The sub-app installs {@link sessionMiddleware} itself so callers don't have
 * to remember to wrap it.
 */
export function buildAuthRoutes(deps: AuthRoutesDeps) {
  const { db, schema } = deps;
  const app = new Hono<AuthEnv>();
  app.use("*", sessionMiddleware(db, schema));
  app.use("*", csrfProtection);

  app.post("/register", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!name || !email || !password) {
      return c.json({ error: "name, email and password are required" }, 400);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
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
    c.header("Set-Cookie", buildCsrfCookie(newCsrfToken()), { append: true });
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
      // Compare against a dummy hash so the timing for unknown / inactive
      // emails matches the success path.
      bcrypt.compareSync(password, DUMMY_HASH);
      return c.json({ error: "Invalid credentials" }, 401);
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const { token } = await issueSession(db, schema, user.id);
    c.header("Set-Cookie", buildSessionCookie(token), { append: true });
    c.header("Set-Cookie", buildCsrfCookie(newCsrfToken()), { append: true });
    return c.json({ user: publicUser(user as User) });
  });

  app.post("/logout", async (c) => {
    const session = c.get("session");
    c.header("Set-Cookie", buildClearSessionCookie(), { append: true });
    c.header("Set-Cookie", buildClearCsrfCookie(), { append: true });
    if (!session) return c.json({ ok: false });
    await destroySession(db, schema, session.id);
    return c.json({ ok: true });
  });

  app.get("/me", requireAuth, (c) => {
    const user = c.get("user")!;
    return c.json({ user: publicUser(user) });
  });

  return app;
}
