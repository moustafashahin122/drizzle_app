/**
 * @module drizzle-graphql-rbac/testing
 *
 * Public testing surface for host apps. Two layers:
 *
 *   - `base`         — shared sqlite + SAVEPOINT fixture, schema push,
 *                       Hono jsonFetch helpers.
 *   - `app_testing`  — `createAppTestHarness(appConfig)` — wire an app's
 *                       `createApp` config into a ready-to-use harness.
 *
 * Framework's own tests use `framework_testing.ts` directly; that surface is
 * intentionally not re-exported here.
 */
export {
  getSharedSqlite,
  transactionCase,
  pushDrizzleSchema,
  cookieValue,
  jsonFetch,
} from "./base.js";
export { createAppTestHarness } from "./app_testing.js";
