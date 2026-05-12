/**
 * @module auth/session
 *
 * Session token + cookie primitives. Pure functions and a single DB lookup —
 * no framework dependencies. Used by both the Hono REST routes
 * (`./routes.ts`, `./middleware.ts`) and the Yoga context resolver in
 * `../server.ts`.
 *
 * Sessions are random opaque tokens persisted in the `sessions` table with a
 * sliding 7-day expiry that {@link resolveSessionFromToken} refreshes on each
 * successful resolution.
 */
import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type {
  User,
  Session,
  users as usersTable,
  sessions as sessionsTable,
  roles as rolesTable,
} from "../tables.js";

const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 86_400_000;
// Skip the sliding-expiry write when the session still has more than half its
// window remaining. Caps refresh writes at roughly one per session per
// SESSION_REFRESH_MS, instead of one per request.
const SESSION_REFRESH_MS = SESSION_MS / 2;
export const SESSION_COOKIE_NAME = "sid";

/**
 * Structural shape of the two tables the auth layer touches. Typed against
 * the framework's own `users` / `sessions` definitions in `../tables.js` —
 * host apps should re-export those tables (or spread `frameworkTables`)
 * rather than declaring their own.
 */
export interface SessionSchema {
  users: typeof usersTable;
  sessions: typeof sessionsTable;
}

/**
 * `SessionSchema` plus the `roles` table — required by
 * {@link resolveSessionFromToken}, which folds the role lookup into the same
 * query that resolves the session, so callers (sessionMiddleware) don't issue
 * a separate `getUserRole` round-trip per request.
 */
export interface RoleAwareSessionSchema extends SessionSchema {
  roles: typeof rolesTable;
}

/**
 * Minimal structural shape of a Drizzle DB handle used by framework auth and
 * admin code paths.
 *
 * Intentionally widened — apps should pass a Drizzle
 * `BetterSQLite3Database`-compatible handle (or any dialect handle exposing the
 * standard `select` / `insert` / `update` / `delete` query builders). Tightly
 * typing this surface would require importing dialect-specific Drizzle
 * internals, which would couple the framework to a particular driver.
 */
export interface SudoDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle dialect-agnostic, see JSDoc above
  select: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle dialect-agnostic, see JSDoc above
  insert: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle dialect-agnostic, see JSDoc above
  update: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle dialect-agnostic, see JSDoc above
  delete: (...args: any[]) => any;
}

export const newToken = () => randomBytes(32).toString("hex");
export const newExpiresAt = () => new Date(Date.now() + SESSION_MS).toISOString();

/** Build the `Set-Cookie` header value for the session cookie. */
export function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}; Secure`;
}

/** Header value that clears the session cookie (Max-Age=0). */
export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure`;
}

/** Extract a named cookie value from a Cookie header. */
export function parseCookieValue(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

/** Extract the session token from a `Cookie` header. */
export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  return parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
}

/** Extract the token from a `Bearer <token>` header value, or `null`. */
export function extractBearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m) return null;
  const token = m[1].trim();
  return token || null;
}

/**
 * Issue a new session row and return the raw token. The caller is responsible
 * for shipping the token to the client (cookie + JSON body).
 */
export async function issueSession(
  db: SudoDb,
  schema: SessionSchema,
  userId: number,
): Promise<{ token: string; session: Session }> {
  const token = newToken();
  const [row] = await db
    .insert(schema.sessions)
    .values({ token, userId, expiresAt: newExpiresAt() })
    .returning();
  return { token, session: row as Session };
}

/**
 * Resolve a raw session token to `{ user, session, role }`. Returns nulls on
 * miss / expiry / inactive user; refreshes the session's sliding expiry on
 * hit. `role` is the joined `roles` row (LEFT JOIN — `null` when the user is
 * roleless). Never throws — callers expect a "guest" context, not an error.
 *
 * Folding the role lookup into this single JOIN means `sessionMiddleware`
 * runs one query per request instead of two.
 */
export async function resolveSessionFromToken(
  db: SudoDb,
  schema: RoleAwareSessionSchema,
  token: string | null,
): Promise<{
  user: User | null;
  session: Session | null;
  role: { name: string; isAdmin: boolean } | null;
}> {
  if (!token) return { user: null, session: null, role: null };

  const { users, sessions, roles } = schema;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const [row] = await db
    .select({
      session: sessions,
      user: users,
      roleName: roles.name,
      roleIsAdmin: roles.isAdmin,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, nowIso)))
    .limit(1);
  if (!row) return { user: null, session: null, role: null };
  const { session, user, roleName, roleIsAdmin } = row as {
    session: Session;
    user: User;
    roleName: string | null;
    roleIsAdmin: boolean | number | null;
  };
  if (!user.active) return { user: null, session: null, role: null };
  const role =
    roleName != null ? { name: roleName, isAdmin: !!roleIsAdmin } : null;

  // Sliding expiry: only refresh once the remaining window has dropped below
  // SESSION_REFRESH_MS, so a busy session does not write on every request.
  const expiresMs = Date.parse(session.expiresAt);
  if (Number.isFinite(expiresMs) && expiresMs - now < SESSION_REFRESH_MS) {
    const nextExpiresAt = newExpiresAt();
    await db
      .update(sessions)
      .set({ expiresAt: nextExpiresAt })
      .where(eq(sessions.id, session.id));
    session.expiresAt = nextExpiresAt;
  }

  return { user, session, role };
}

/** Delete a session row by id. Idempotent — missing id is silently ignored. */
export async function destroySession(
  db: SudoDb,
  schema: SessionSchema,
  sessionId: number,
): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}
