import { serve } from "@hono/node-server";
import { createApp } from "drizzle-graphql-rbac";
import * as schema from "./db.js";
import { roles } from "./roles.js";
import { accessRights } from "./accessRights.js";
import { recordRules } from "./recordRules.js";

const { app } = createApp({
  db: schema.db,
  schema,
  rbac: { roles, accessRights, recordRules },
  hiddenOutputColumns: { users: ["passwordHash"] },
  publicDir: "./public",
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`Server running on http://localhost:${port}`);
console.log(`GraphiQL at http://localhost:${port}/graphql`);
