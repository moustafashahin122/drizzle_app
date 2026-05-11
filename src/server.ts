import { serve } from "@hono/node-server";
import { inArray } from "drizzle-orm";
import { createApp, logger } from "drizzle-graphql-rbac";
import { sudoDb } from "./sudoDb.js";
import { users } from "./schema.js";
import { appConfig } from "./appConfig.js";
import { bootstrapUsers } from "./scripts/bootstrapUsers.js";
import { DEMO_ROLES } from "./demoUsers.js";

const log = logger.child({ component: "app.server" });

const { app, rbac } = createApp({ db: sudoDb, ...appConfig });

// Prod only: upsert the env-driven admin from ADMIN_EMAIL/ADMIN_PASSWORD.
// Demo users/todos are seeded explicitly via `npm run seed:demo`.
const admin = await bootstrapUsers();

// RBAC memberships live in process memory and reset on restart. Re-bind roles
// for whichever well-known accounts exist in the DB right now.
const roleByEmail = new Map<string, string>(Object.entries(DEMO_ROLES));
if (admin) roleByEmail.set(admin.email, admin.role);

if (roleByEmail.size > 0) {
  const rows = await sudoDb
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.email, [...roleByEmail.keys()]));
  for (const { id, email } of rows) {
    const role = roleByEmail.get(email);
    if (role && rbac.hasRole(role)) {
      rbac.assignRole(id, role);
      log.debug({ userId: id, email, role }, "seeded role");
    }
  }
}

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
log.info({ url: `http://localhost:${port}` }, "server started");
log.info({ url: `http://localhost:${port}/graphql` }, "graphiql ready");
