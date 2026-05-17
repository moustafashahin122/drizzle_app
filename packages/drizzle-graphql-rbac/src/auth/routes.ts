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
import { Hono, type Context } from "hono";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { User } from "../tables.js";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  destroySession,
  issueSession,
  type SudoDb,
} from "./session.js";
import {
  requireAuth,
  sessionMiddleware,
  type AuthEnv,
  type RoleAwareSchema,
} from "./middleware.js";

const BCRYPT_ROUNDS = 12;
// Pre-computed dummy hash so /auth/login does a bcrypt compare for unknown
// emails too — equalizes timing and frustrates user-enumeration.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", BCRYPT_ROUNDS);

/** Read a string field from a parsed JSON body, defaulting to "" on missing/wrong-type. */
function getStringField(body: unknown, key: string, { trim = true }: { trim?: boolean } = {}): string {
  const v = (body as Record<string, unknown> | null)?.[key];
  if (typeof v !== "string") return "";
  return trim ? v.trim() : v;
}

/** Strip the password hash before serializing to JSON. */
function publicUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

/** Parse the JSON body, returning `{}` on malformed input rather than throwing. */
async function readJsonBody(c: Context<AuthEnv>): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

/**
 * Destroy any session attached to the current request and mint a fresh one for
 * `userId`, setting the cookie. Prevents session fixation: a pre-login cookie
 * cannot survive across the authentication boundary.
 */
async function rotateSession(
  c: Context<AuthEnv>,
  db: SudoDb,
  schema: RoleAwareSchema,
  userId: number,
): Promise<void> {
  const existing = c.get("session");
  if (existing) await destroySession(db, schema, existing.id);
  const { token } = await issueSession(db, schema, userId);
  c.header("Set-Cookie", buildSessionCookie(token), { append: true });
}

export interface AuthRoutesDeps {
  db: SudoDb;
  /**
   * Same schema shape the framework's `sessionMiddleware` consumes — needs
   * `users`, `sessions`, and `roles` (the middleware loads the caller's role
   * once per request and stashes it on `c.var`). Auth routes themselves do
   * not read `c.var.role`; the dependency is transitive through the shared
   * middleware.
   */
  schema: RoleAwareSchema;
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

  app.post("/register", async (c) => {
    const body = await readJsonBody(c);
    const name = getStringField(body, "name");
    const email = getStringField(body, "email");
    const password = getStringField(body, "password", { trim: false });
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // sqlite: "UNIQUE constraint failed"; pg: "duplicate key value violates
      // unique constraint" (SQLSTATE 23505). Match either dialect's signal.
      const code = (err as { code?: string } | null)?.code;
      if (message.includes("UNIQUE") || message.includes("duplicate key") || code === "23505") {
        return c.json({ error: "Email already registered" }, 409);
      }
      throw err;
    }

    await rotateSession(c, db, schema, user.id);
    return c.json({ user: publicUser(user) }, 201);
  });

  app.post("/login", async (c) => {
    const body = await readJsonBody(c);
    const email = getStringField(body, "email");
    const password = getStringField(body, "password", { trim: false });
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

    await rotateSession(c, db, schema, user.id);
    return c.json({ user: publicUser(user as User) });
  });

  app.post("/logout", async (c) => {
    const session = c.get("session");
    c.header("Set-Cookie", buildClearSessionCookie(), { append: true });
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
