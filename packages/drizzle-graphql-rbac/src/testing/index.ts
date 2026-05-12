/**
 * @module drizzle-graphql-rbac/testing
 *
 * Public testing surface for host apps. Two layers:
 *
 *   - `base`         — shared sqlite + SAVEPOINT fixture, schema push,
 *                       Hono jsonFetch helpers. Used by every test.
 *   - `app_testing`  — `createAppTestHarness(appConfig)` — wire an app's
 *                       `createApp` config into a ready-to-use harness.
 *
 * Framework tests (auth, admin, persistence, createApp options) use
 * `framework_testing.ts` directly and that surface is intentionally not
 * re-exported here.
 *
 *     import {
 *       getSharedSqlite,
 *       transactionCase,
 *       createAppTestHarness,
 *     } from "drizzle-graphql-rbac/testing";
 */
export {
  getSharedSqlite,
  applySchemaSql,
  transactionCase,
  pushDrizzleSchema,
  getSetCookieList,
  cookieValue,
  jsonFetch,
  type JsonFetchOpts,
  type JsonFetchResult,
} from "./base.js";
export {
  createAppTestHarness,
  type AppTestConfig,
  type AppTestCtx,
  type AppTestHarness,
  type AppHandle,
} from "./app_testing.js";
