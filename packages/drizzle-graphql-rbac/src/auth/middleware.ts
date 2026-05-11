/**
 * @module auth/middleware
 *
 * Hono middleware that resolves the current session from cookie / bearer
 * header and stashes `{ user, session }` on `c.var`. A second helper
 * (`requireAuth`) returns 401 when no user is present — use it to gate
 * authenticated routes.
 */
import type { MiddlewareHandler } from "hono";
import type { User, Session } from "../tables.js";
import {
  extractBearerToken,
  parseSessionCookie,
  parseCookieValue,
  resolveSessionFromToken,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  type SudoDb,
  type SessionSchema,
} from "./session.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Double-submit CSRF check. On mutating requests we require the
 * `X-CSRF-Token` header to equal the non-HttpOnly `csrf_token` cookie. If
 * the request has no session cookie at all, we allow it through so initial
 * login / register can succeed.
 */
export const csrfProtection: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) return next();
  const cookieHeader = c.req.header("cookie");
  const hasSession = parseSessionCookie(cookieHeader) != null;
  if (!hasSession) return next();
  const cookieToken = parseCookieValue(cookieHeader, CSRF_COOKIE_NAME);
  const headerToken = c.req.header(CSRF_HEADER_NAME) ?? null;
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return c.json({ error: "CSRF token missing or invalid" }, 403);
  }
  await next();
};

export interface AuthVariables {
  user: User | null;
  session: Session | null;
}

export type AuthEnv = { Variables: AuthVariables };

/**
 * Resolve the request's session and set `c.var.user` / `c.var.session`.
 * Mount this on any route that needs to know who the caller is — both REST
 * and the GraphQL endpoint.
 */
export function sessionMiddleware(
  db: SudoDb,
  schema: SessionSchema,
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const cookieToken = parseSessionCookie(c.req.header("cookie"));
    const headerToken = extractBearerToken(c.req.header("authorization"));
    const { user, session } = await resolveSessionFromToken(
      db,
      schema,
      cookieToken ?? headerToken,
    );
    c.set("user", user);
    c.set("session", session);
    await next();
  };
}

/** 401 when no authenticated user is on the context. */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get("user")) {
    return c.json({ error: "Not authenticated" }, 401);
  }
  await next();
};

/**
 * 403 when the authenticated user does not hold an admin role. Mount AFTER
 * `requireAuth` — this middleware assumes `c.get("user")` is non-null. The
 * `isAdmin` predicate is parameterized so the framework's RBAC engine, or any
 * caller-supplied notion of admin, can be plugged in.
 */
export function requireAdmin(
  isAdmin: (userId: number) => boolean,
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user || !isAdmin(user.id)) {
      return c.json({ error: "Admin only" }, 403);
    }
    await next();
  };
}
