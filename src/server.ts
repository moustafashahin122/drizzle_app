import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createYoga } from "graphql-yoga";
import { buildSchema } from "./graphql/index.js";
import { buildRbac } from "./graphql/rbac/rbac.js";
import { buildRbacDb, type RbacDb } from "./graphql/rbac/rbacDb.js";
import { buildAuthRoutes } from "./auth/routes.js";
import { buildAdminRoutes } from "./admin/routes.js";
import { sessionMiddleware, type AuthEnv } from "./auth/middleware.js";
import * as dbModule from "./db.js";

const sessionSchema = { users: dbModule.users, sessions: dbModule.sessions };

const rbac = buildRbac(dbModule.db, {
  groups: dbModule.groups,
  userGroups: dbModule.userGroups,
  accessRights: dbModule.accessRights,
  recordRules: dbModule.recordRules,
});

const { schema } = buildSchema(dbModule.db, dbModule, {
  hiddenOutputColumns: { users: ["passwordHash"] },
  rbac: { enforce: rbac.enforce },
});

const rdbFor = buildRbacDb({
  db: dbModule.db,
  schema: dbModule,
  enforce: rbac.enforce,
});

interface YogaContext {
  user: dbModule.User | null;
  session: dbModule.Session | null;
  batch: Map<string, unknown>;
  db: RbacDb;
}

const yoga = createYoga<{}, YogaContext>({
  schema,
  graphqlEndpoint: "/graphql",
  graphiql: true,
  context: async ({ request }) => {
    const stash = (request as any)._authCtx as
      | { user: dbModule.User | null; session: dbModule.Session | null }
      | undefined;
    const user = stash?.user ?? null;
    const session = stash?.session ?? null;
    const batch = new Map<string, unknown>();
    return { user, session, batch, db: rdbFor({ user, batch }) };
  },
});

const app = new Hono<AuthEnv>();

// REST: authentication and admin dashboard live here, GraphQL is data-only.
app.route("/auth", buildAuthRoutes({ db: dbModule.db, schema: sessionSchema }));
app.route(
  "/admin",
  buildAdminRoutes({
    db: dbModule.db,
    schema: sessionSchema,
    usersTable: dbModule.users,
    rdbFor,
  }),
);

// GraphQL endpoint: session middleware populates c.var.user, then Yoga
// receives that as its serverContext so resolvers see the same user object.
app.use("/graphql", sessionMiddleware(dbModule.db, sessionSchema));
app.all("/graphql", async (c) => {
  (c.req.raw as any)._authCtx = { user: c.get("user"), session: c.get("session") };
  return yoga.fetch(c.req.raw, {});
});

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`Server running on http://localhost:${port}`);
console.log(`GraphiQL at http://localhost:${port}/graphql`);
