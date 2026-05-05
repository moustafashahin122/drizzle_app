import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createYoga } from "graphql-yoga";
import { buildSchema } from "./graphql/index.js";
import { buildAuthExtensions, resolveSessionFromHeader, type AuthContext } from "./graphql/auth.js";
import { buildRbac } from "./graphql/rbac.js";
import { buildRbacDb, type RbacDb } from "./graphql/rbacDb.js";
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
    const { user, session } = await resolveSessionFromHeader(
      dbModule.db,
      { users: dbModule.users, sessions: dbModule.sessions },
      request.headers.get("authorization"),
    );
    const batch = new Map();
    const baseCtx = { user, session, batch };
    return { ...baseCtx, db: rdbFor(baseCtx) };
  },
});

const app = new Hono();

app.all("/graphql", (c) => yoga.fetch(c.req.raw, {}));

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`Server running on http://localhost:${port}`);
console.log(`GraphiQL at http://localhost:${port}/graphql`);
