/**
 * @module graphql/auth
 *
 * Hand-rolled authentication surface that plugs into the auto-generated
 * schema via {@link buildSchema}'s `extraQueryFields` / `extraMutationFields`
 * hooks. Provides `register` / `login` / `logout` mutations and a `me` query,
 * plus {@link resolveSessionFromHeader} for the server-side context wiring.
 *
 * Sessions
 * --------
 * Login issues an opaque random token persisted in the `sessions` table with a
 * 7-day sliding expiry — every successful resolution refreshes `expiresAt`. The
 * client passes the token in `Authorization: Bearer <token>`.
 */
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfigMap,
} from "graphql";

/**
 * Throw a `GraphQLError` so Yoga forwards the message to the client (plain
 * `Error` instances get masked as "Unexpected error" by Yoga's default error
 * shield, which would surface as a useless string in the login form).
 */
const userError = (message: string) =>
  new GraphQLError(message, { extensions: { code: "BAD_USER_INPUT" } });
const authError = (message: string) =>
  new GraphQLError(message, { extensions: { code: "UNAUTHENTICATED" } });
import type { sessions as sessionsTable, users as usersTable, User, Session } from "../db.js";
import type { RbacDb } from "./rbacDb.js";

const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 86_400_000;
export const SESSION_COOKIE_NAME = "sid";

export interface AuthContext {
  user: User | null;
  session: Session | null;
  /** Per-request batch cache used by the relation loader. */
  batch?: Map<string, unknown>;
  /**
   * RBAC-bound Drizzle wrapper for the current request. Resolvers should use
   * this in place of the raw `db` import — every CRUD call enforces RBAC
   * automatically. Optional because the bootstrap auth resolvers
   * (`login`/`register`) deliberately operate before there's a user.
   */
  db?: RbacDb;
  /**
   * Set the session cookie on the outgoing response. Called by `login` /
   * `register` so browser-based clients (e.g. GraphiQL on the same origin)
   * stay authenticated without manually pasting a Bearer token.
   */
  setSessionCookie?: (token: string) => void;
  /** Clear the session cookie. Called by `logout`. */
  clearSessionCookie?: () => void;
}

/**
 * Build the `Set-Cookie` header value for the session cookie. HttpOnly +
 * SameSite=Lax — sufficient for same-origin GraphiQL; flip `Secure` on for
 * HTTPS deployments.
 */
export function buildSessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

/** Header value that clears the session cookie (Max-Age=0). */
export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Extract the session token from a `Cookie` header, or `null` if the cookie
 * is absent / empty. Tolerant of whitespace around `;` and `=`.
 */
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

interface AuthSchema {
  users: typeof usersTable;
  sessions: typeof sessionsTable;
}

interface AuthDb {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
}

const newToken = () => randomBytes(32).toString("hex");
const newExpiresAt = () => new Date(Date.now() + SESSION_MS).toISOString();

/**
 * Build the auth resolver hooks for {@link buildSchema}.
 *
 * The returned `extraQueryFields` / `extraMutationFields` are functions that
 * receive the map of generated object types — `typesByKey.users` is the
 * `User` GraphQL type the auto-CRUD layer registers, which is reused as the
 * payload type so authenticated clients see the same shape as
 * `Query.usersSingle`.
 */
export function buildAuthExtensions(db: AuthDb, schema: AuthSchema) {
  const { users, sessions } = schema;

  const insertUser = async (
     target: AuthDb,
     values: { name: string; email: string; passwordHash: string; active?: boolean },
  ): Promise<User> => {
    try {
      const [user] = await target.insert(users).values(values).returning();
      return user;
    } catch (err: any) {
      // SQLite UNIQUE constraint message includes "UNIQUE".
      if (String(err?.message ?? "").includes("UNIQUE")) {
        throw userError("Email already registered");
      }
      throw err;
    }
  };

  const issueSession = async (userId: number) => {
    const token = newToken();
    const [row] = await db
      .insert(sessions)
      .values({ token, userId, expiresAt: newExpiresAt() })
      .returning();
    return { token, session: row as Session };
  };

  const extraQueryFields = (typesByKey: Record<string, GraphQLObjectType>) => {
    const userType = typesByKey.users;
    if (!userType) throw new Error("auth: 'users' table not registered in schema");
    const fields: GraphQLFieldConfigMap<unknown, AuthContext> = {
      me: {
        type: userType,
        resolve: (_s, _a, ctx) => ctx.user ?? null,
      },
    };
    return fields;
  };

  const extraMutationFields = (typesByKey: Record<string, GraphQLObjectType>) => {
    const userType = typesByKey.users;
    if (!userType) throw new Error("auth: 'users' table not registered in schema");

    const AuthPayload = new GraphQLObjectType({
      name: "AuthPayload",
      fields: {
        token: { type: new GraphQLNonNull(GraphQLString) },
        user: { type: new GraphQLNonNull(userType) },
      },
    });

    const fields: GraphQLFieldConfigMap<unknown, AuthContext> = {
      register: {
        type: new GraphQLNonNull(AuthPayload),
        args: {
          name: { type: new GraphQLNonNull(GraphQLString) },
          email: { type: new GraphQLNonNull(GraphQLString) },
          password: { type: new GraphQLNonNull(GraphQLString) },
        },
        resolve: async (_s, args, ctx) => {
          const passwordHash = await bcrypt.hash(args.password, 10);
          const user = await insertUser(db, {
            name: args.name,
            email: args.email,
            passwordHash,
          });
          const { token } = await issueSession(user.id);
          ctx.setSessionCookie?.(token);
          return { token, user };
        },
      },
      login: {
        type: new GraphQLNonNull(AuthPayload),
        args: {
          email: { type: new GraphQLNonNull(GraphQLString) },
          password: { type: new GraphQLNonNull(GraphQLString) },
        },
        resolve: async (_s, args, ctx) => {
          const [user] = await db
            .select()
            .from(users)
            .where(eq(users.email, args.email))
            .limit(1);
          if (!user || !user.active) throw userError("Invalid credentials");
          const ok = await bcrypt.compare(args.password, user.passwordHash);
          if (!ok) throw userError("Invalid credentials");
          const { token } = await issueSession(user.id);
          ctx.setSessionCookie?.(token);
          return { token, user };
        },
      },
      createUser: {
        type: new GraphQLNonNull(userType),
        args: {
          name: { type: new GraphQLNonNull(GraphQLString) },
          email: { type: new GraphQLNonNull(GraphQLString) },
          password: { type: new GraphQLNonNull(GraphQLString) },
          active: { type: GraphQLBoolean },
        },
        resolve: async (_s, args, ctx) => {
          // Admin-create: RBAC `create` on `users` is enforced by ctx.db.
          // `enforce` throws FORBIDDEN for unauthenticated callers, so no
          // separate auth check is needed here.
          if (!ctx.db) throw authError("Not authenticated");
          const passwordHash = await bcrypt.hash(args.password, 10);
          return insertUser(ctx.db as unknown as AuthDb, {
            name: args.name,
            email: args.email,
            passwordHash,
            active: args.active ?? true,
          });
        },
      },
      logout: {
        type: new GraphQLNonNull(GraphQLBoolean),
        resolve: async (_s, _a, ctx) => {
          ctx.clearSessionCookie?.();
          if (!ctx.session) return false;
          await db.delete(sessions).where(eq(sessions.id, ctx.session.id));
          return true;
        },
      },
    };
    return fields;
  };

  return { extraQueryFields, extraMutationFields };
}

/**
 * Resolve a `Bearer <token>` authorization header to an `{ user, session }`
 * pair, refreshing the session's sliding expiry on each hit. Returns nulls
 * when the header is missing, malformed, expired, or the user is inactive —
 * never throws (callers expect a "guest" context, not an error).
 */
export async function resolveSessionFromHeader(
  db: AuthDb,
  schema: AuthSchema,
  authorization: string | null | undefined,
): Promise<{ user: User | null; session: Session | null }> {
  return resolveSessionFromToken(db, schema, extractBearerToken(authorization));
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
 * Resolve a raw session token to `{ user, session }`. Source-agnostic — feed
 * it from a `Bearer` header or a session cookie. Returns nulls on miss /
 * expiry / inactive user; refreshes the session's sliding expiry on hit.
 */
export async function resolveSessionFromToken(
  db: AuthDb,
  schema: AuthSchema,
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

  // Sliding expiry — refresh on every authenticated request.
  await db
    .update(sessions)
    .set({ expiresAt: newExpiresAt() })
    .where(eq(sessions.id, session.id));

  return { user, session };
}
