import { serve } from "@hono/node-server";
import { createApp } from "drizzle-graphql-rbac";
import * as schema from "./db.js";

const { app } = createApp({
  db: schema.db,
  schema,
  hiddenOutputColumns: { users: ["passwordHash"] },
  publicDir: "./public",
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`Server running on http://localhost:${port}`);
console.log(`GraphiQL at http://localhost:${port}/graphql`);
