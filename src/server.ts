import { serve } from "@hono/node-server";
import { createApp, logger } from "drizzle-graphql-rbac";
import { sudoDb } from "./sudoDb.js";
import { appConfig } from "./appConfig.js";

const log = logger.child({ component: "app.server" });

// `createApp` is async — it reconciles the `roles` table with the in-code
// config (syncRoles) before returning, so DB role state is current by the
// time the listener starts. The initial admin user is created on demand via
// the framework's `--create-admin` CLI flag, not at every boot.
const { app } = await createApp({ db: sudoDb, ...appConfig });

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
log.info({ url: `http://localhost:${port}` }, "server started");
log.info({ url: `http://localhost:${port}/graphql` }, "graphiql ready");
