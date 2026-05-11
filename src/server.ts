import { serve } from "@hono/node-server";
import { inArray } from "drizzle-orm";
import { createApp, logger } from "drizzle-graphql-rbac";
import { sudoDb } from "./sudoDb.js";
import { users } from "./schema.js";
import { appConfig } from "./appConfig.js";

const log = logger.child({ component: "app.server" });

const { app, rbac } = createApp({ db: sudoDb, ...appConfig });

// In-memory RBAC: re-seed role assignments from a small email → roles map on
// every startup. Keeps the dev experience working with the seed scripts.
// Reads run through sudoDb because this happens at startup, before any user
// context exists — the canonical case for the sudo escape.
const bootstrap: Record<string, string[]> = {
  [process.env.ADMIN_EMAIL ?? "admin@example.com"]: ["admin"],
  "demo1@example.com": ["demo"],
};
const bootstrapEmails = Object.keys(bootstrap);
if (bootstrapEmails.length) {
  const rows = await sudoDb
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.email, bootstrapEmails));
  for (const { id, email } of rows) {
    for (const key of bootstrap[email] ?? []) {
      if (rbac.hasRole(key)) {
        rbac.assignRole(id, key);
        log.debug({ userId: id, email, role: key }, "seeded role");
      }
    }
  }
}
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
log.info({ url: `http://localhost:${port}` }, "server started");
log.info({ url: `http://localhost:${port}/graphql` }, "graphiql ready");
