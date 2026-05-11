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
  type SudoDb,
  type SessionSchema,
} from "./session.js";
import { requireAuth, sessionMiddleware, type AuthEnv } from "./middleware.js";

const BCRYPT_ROUNDS = 12;
// Pre-computed dummy hash so /auth/login does a bcrypt compare for unknown
// emails too — equalizes timing and frustrates user-enumeration.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", BCRYPT_ROUNDS);

// Naive in-memory limiter — fine for a single-process deploy; replace with a
// shared store if you horizontally scale.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_PER_IP_EMAIL = 10;
const LOGIN_MAX_PER_IP = 30;

/**
 * Sliding-window failure counter keyed by an arbitrary string. Each bucket
 * keeps a sorted list of failure timestamps; entries older than `windowMs`
 * are pruned lazily on read.
 */
class SlidingWindowCounter {
  private readonly buckets = new Map<string, number[]>();
  constructor(private readonly windowMs: number, readonly limit: number) {}

  count(key: string, now: number): number {
    const arr = this.buckets.get(key);
    if (!arr) return 0;
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    if (arr.length === 0) this.buckets.delete(key);
    return arr.length;
  }

  exceeded(key: string, now: number): boolean {
    return this.count(key, now) >= this.limit;
  }

  hit(key: string, now: number): void {
    let arr = this.buckets.get(key);
    if (!arr) this.buckets.set(key, (arr = []));
    arr.push(now);
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }
}

const ipEmailLimiter = new SlidingWindowCounter(LOGIN_WINDOW_MS, LOGIN_MAX_PER_IP_EMAIL);
const ipLimiter = new SlidingWindowCounter(LOGIN_WINDOW_MS, LOGIN_MAX_PER_IP);

/** Test-only: clears the in-memory login rate-limit state so tests can run in isolation. */
export function __resetRateLimitForTests(): void {
  ipEmailLimiter.clear();
  ipLimiter.clear();
}

/** Read a string field from a parsed JSON body, defaulting to "" on missing/wrong-type. */
function getStringField(body: unknown, key: string, { trim }: { trim: boolean } = { trim: true }): string {
  const v = (body as Record<string, unknown> | null)?.[key];
  if (typeof v !== "string") return "";
  return trim ? v.trim() : v;
}

/** Best-effort client IP from common proxy headers; falls back to "unknown". */
function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
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

  app.post("/register", async (c) => {
    const body = await c.req.json().catch(() => ({}));
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
    const email = getStringField(body, "email");
    const password = getStringField(body, "password", { trim: false });
    if (!email || !password) {
      return c.json({ error: "email and password are required" }, 400);
    }

    const ip = clientIp(c);
    const ipEmailKey = `${ip}|${email.toLowerCase()}`;
    const now = Date.now();
    if (ipEmailLimiter.exceeded(ipEmailKey, now) || ipLimiter.exceeded(ip, now)) {
      return c.json({ error: "Too many attempts, try again in a minute" }, 429);
    }

    const recordFailedLogin = () => {
      ipEmailLimiter.hit(ipEmailKey, now);
      ipLimiter.hit(ip, now);
    };

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (!user || !user.active) {
      // Compare against a dummy hash so the timing for unknown / inactive
      // emails matches the success path.
      bcrypt.compareSync(password, DUMMY_HASH);
      recordFailedLogin();
      return c.json({ error: "Invalid credentials" }, 401);
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      recordFailedLogin();
      return c.json({ error: "Invalid credentials" }, 401);
    }

    // Successful login resets the user's buckets.
    ipEmailLimiter.reset(ipEmailKey);
    ipLimiter.reset(ip);

    const { token } = await issueSession(db, schema, user.id);
    c.header("Set-Cookie", buildSessionCookie(token), { append: true });
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
