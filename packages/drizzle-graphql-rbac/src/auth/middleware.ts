/**
 * @module auth/middleware
 *
 * Hono middleware that resolves the current session from cookie / bearer
 * header and stashes `{ user, session, role }` on `c.var`. The role is
 * loaded once here (single FK join against `roles`) and reused by every
 * downstream RBAC check for the request.
 *
 *   sessionMiddleware ─→ requireAuth ─→ requireAdmin
 *
 * `requireAuth` returns 401 when no user is present; `requireAdmin` returns
 * 403 unless the resolved role has `isAdmin: true`.
 */
import type { MiddlewareHandler } from "hono";
import type { User, Session } from "../tables.js";
import {
  extractBearerToken,
  parseSessionCookie,
  resolveSessionFromToken,
  type SudoDb,
  type RoleAwareSessionSchema,
} from "./session.js";
import type { ResolvedUserRole } from "../graphql/rbac/rbac.js";

/**
 * Re-export under the legacy name so existing consumers
 * (`buildAuthRoutes`, `buildAdminRoutes`) keep their import shape.
 */
export type RoleAwareSchema = RoleAwareSessionSchema;

export interface AuthVariables {
  user: User | null;
  session: Session | null;
  /**
   * Pre-resolved role for `user`, or `null` when the user is roleless or
   * anonymous. Loaded once per request by `sessionMiddleware`; downstream
   * RBAC checks read this rather than re-querying.
   */
  role: ResolvedUserRole | null;
}

export type AuthEnv = { Variables: AuthVariables };

/**
 * Resolve the request's session, then its user's role, and set
 * `c.var.user` / `c.var.session` / `c.var.role`. Mount on every route that
 * needs to know who the caller is — both REST and the GraphQL endpoint.
 */
export function sessionMiddleware(
  db: SudoDb,
  schema: RoleAwareSchema,
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const cookieToken = parseSessionCookie(c.req.header("cookie"));
    const headerToken = extractBearerToken(c.req.header("authorization"));
    const { user, session, role } = await resolveSessionFromToken(
      db,
      schema,
      cookieToken ?? headerToken,
    );
    c.set("user", user);
    c.set("session", session);
    c.set("role", role as ResolvedUserRole | null);

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
 * 403 unless the request's resolved role has `isAdmin: true`. Mount AFTER
 * `requireAuth` — assumes `c.get("user")` is non-null. Reads the role that
 * `sessionMiddleware` stashed on the context; does not re-query the DB.
 */
export const requireAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const user = c.get("user");
  const role = c.get("role");
  if (!user || role?.isAdmin !== true) {
    return c.json({ error: "Admin only" }, 403);
  }
  await next();
};
