import { serve } from "@hono/node-server";
import { inArray } from "drizzle-orm";
import { createApp } from "drizzle-graphql-rbac";
import * as schema from "./db.js";
import { roles } from "./roles.js";
import { accessRights } from "./accessRights.js";
import { recordRules } from "./recordRules.js";

const { app, rbac } = createApp({
  db: schema.db,
  schema,
  rbac: { roles, accessRights, recordRules },
  hiddenOutputColumns: { users: ["passwordHash"] },
  publicDir: "./public",
});

// In-memory RBAC: re-seed role assignments from a small email → roles map on
// every startup. Keeps the dev experience working with the seed scripts.
const bootstrap: Record<string, string[]> = {
  [process.env.ADMIN_EMAIL ?? "admin@example.com"]: ["admin"],
  "demo1@example.com": ["demo"],
};
const bootstrapEmails = Object.keys(bootstrap);
if (bootstrapEmails.length) {
  const rows = await schema.db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(inArray(schema.users.email, bootstrapEmails));
  for (const { id, email } of rows) {
    for (const key of bootstrap[email] ?? []) {
      if (rbac.hasRole(key)) rbac.assignRole(id, key);
    }
  }
}
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`Server running on http://localhost:${port}`);
console.log(`GraphiQL at http://localhost:${port}/graphql`);
