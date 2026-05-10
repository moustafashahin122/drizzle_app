import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createYoga } from "graphql-yoga";
import { buildSchema } from "./graphql/index.js";
import {
  buildAuthExtensions,
  buildClearSessionCookie,
  buildSessionCookie,
  extractBearerToken,
  parseSessionCookie,
  resolveSessionFromToken,
  type AuthContext,
} from "./graphql/auth/auth.js";
import { buildRbac } from "./graphql/rbac/rbac.js";
import { buildRbacDb, type RbacDb } from "./graphql/rbac/rbacDb.js";
import * as dbModule from "./db.js";

const auth = buildAuthExtensions(dbModule.db, {
  users: dbModule.users,
  sessions: dbModule.sessions,
});

const rbac = buildRbac(dbModule.db, {
  groups: dbModule.groups,
  userGroups: dbModule.userGroups,
  accessRights: dbModule.accessRights,
  recordRules: dbModule.recordRules,
});

const { schema } = buildSchema(dbModule.db, dbModule, {
  hiddenOutputColumns: { users: ["passwordHash"] },
  extraQueryFields: auth.extraQueryFields,
  extraMutationFields: auth.extraMutationFields,
  rbac: { enforce: rbac.enforce },
});

const rdbFor = buildRbacDb({
  db: dbModule.db,
  schema: dbModule,
  enforce: rbac.enforce,
});

const yoga = createYoga<{}, AuthContext & { db: RbacDb }>({
  schema,
  graphqlEndpoint: "/graphql",
  graphiql: true,
  context: async ({ request }) => {
    // Cookie wins over Authorization header — same-origin browsers (GraphiQL)
    // ship the session cookie automatically, and explicit Bearer is still
    // supported for non-browser clients.
    const cookieToken = parseSessionCookie(request.headers.get("cookie"));
    const headerToken = extractBearerToken(request.headers.get("authorization"));
    const { user, session } = await resolveSessionFromToken(
      dbModule.db,
      { users: dbModule.users, sessions: dbModule.sessions },
      cookieToken ?? headerToken,
    );
    const batch = new Map();
    const cookieJar = (request as any)._cookieJar as string[] | undefined;
    const baseCtx: AuthContext = {
      user,
      session,
      batch,
      setSessionCookie: (token) => cookieJar?.push(buildSessionCookie(token)),
      clearSessionCookie: () => cookieJar?.push(buildClearSessionCookie()),
    };
    return { ...baseCtx, db: rdbFor(baseCtx) };
  },
});

const app = new Hono();

app.all("/graphql", async (c) => {
  // Resolvers push Set-Cookie headers onto this jar via ctx.setSessionCookie /
  // ctx.clearSessionCookie; the values are appended to the Yoga response.
  const cookieJar: string[] = [];
  (c.req.raw as any)._cookieJar = cookieJar;
  const res = await yoga.fetch(c.req.raw, {});
  if (!cookieJar.length) return res;
  const headers = new Headers(res.headers);
  for (const cookie of cookieJar) headers.append("set-cookie", cookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
});

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`Server running on http://localhost:${port}`);
console.log(`GraphiQL at http://localhost:${port}/graphql`);
