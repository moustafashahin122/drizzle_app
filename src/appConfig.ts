/**
 * @module app/appConfig
 *
 * Static, DB-independent configuration for the demo app. Server, scripts,
 * and tests all wire `createApp({ db, ...appConfig })` so the schema, RBAC
 * rules, and runtime options are guaranteed identical across environments.
 *
 * The only thing that varies between prod and test is the Drizzle handle:
 * `src/sudoDb.ts` opens `todo.db`; `src/testing/appTestCase.ts` opens an
 * in-memory sqlite via the framework's shared singleton.
 */
import * as schema from "./schema.js";
import { roles } from "./roles.js";
import { accessRights } from "./accessRights.js";
import { recordRules } from "./recordRules.js";

export const appConfig = {
  schema,
  rbac: { roles, accessRights, recordRules },
  hiddenOutputColumns: { users: ["passwordHash"], sessions: ["token"] },
  publicDir: "./public",
} as const;

export type AppSchema = typeof schema;
