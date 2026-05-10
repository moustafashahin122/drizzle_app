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
import type { sessions as sessionsTable, users as usersTable, User, Session } from "../tables.js";

const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 86_400_000;
export const SESSION_COOKIE_NAME = "sid";

export interface SessionSchema {
  users: typeof usersTable;
  sessions: typeof sessionsTable;
}

export interface SessionDb {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
}

export const newToken = () => randomBytes(32).toString("hex");
export const newExpiresAt = () => new Date(Date.now() + SESSION_MS).toISOString();

/** Build the `Set-Cookie` header value for the session cookie. */
export function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

/** Header value that clears the session cookie (Max-Age=0). */
export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Extract the session token from a `Cookie` header. */
export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
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
  db: SessionDb,
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
 * Resolve a raw session token to `{ user, session }`. Returns nulls on miss /
 * expiry / inactive user; refreshes the session's sliding expiry on hit.
 * Never throws — callers expect a "guest" context, not an error.
 */
export async function resolveSessionFromToken(
  db: SessionDb,
  schema: SessionSchema,
  token: string | null,
): Promise<{ user: User | null; session: Session | null }> {
  if (!token) return { user: null, session: null };

  const { users, sessions } = schema;
  const nowIso = new Date().toISOString();
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, nowIso)))
    .limit(1);
  if (!session) return { user: null, session: null };

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (!user || !user.active) return { user: null, session: null };

  await db
    .update(sessions)
    .set({ expiresAt: newExpiresAt() })
    .where(eq(sessions.id, session.id));

  return { user, session };
}

/** Delete a session row by id. Idempotent — missing id is silently ignored. */
export async function destroySession(
  db: SessionDb,
  schema: SessionSchema,
  sessionId: number,
): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}
