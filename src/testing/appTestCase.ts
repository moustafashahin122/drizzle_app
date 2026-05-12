/**
 * @module app/testing/appTestCase
 *
 * App-side binding of the framework's generic test harness to this app's
 * `appConfig`. The heavy lifting (lazy app build, SAVEPOINT-based isolation,
 * runHttp/runDirect helpers, user factory) lives in
 * `drizzle-graphql-rbac/testing`'s {@link createAppTestHarness}; this file
 * exists only to (a) pick the config, and (b) give suites a stable import
 * path.
 */
import { createAppTestHarness } from "drizzle-graphql-rbac/testing";
import { appConfig } from "../appConfig.js";

const harness = createAppTestHarness(appConfig);

export const { buildAppOnce, setupAppTestCase, createUser } = harness;

// Re-export the shared low-level helpers so tests have a single import.
export {
  applySchemaSql,
  getSharedSqlite,
  clearAllRbacMemberships,
} from "drizzle-graphql-rbac/testing";
