/**
 * @module drizzle-graphql-rbac/testing
 *
 * Public surface for the framework's test fixtures. Importable from
 * framework tests and from apps built on the framework via:
 *
 *     import {
 *       getSharedSqlite,
 *       applySchemaSql,
 *       transactionCase,
 *     } from "drizzle-graphql-rbac/testing";
 */
export {
  getSharedSqlite,
  applySchemaSql,
  transactionCase,
} from "./transactionCase.js";
export {
  createAppTestHarness,
  type AppTestConfig,
  type AppTestCtx,
  type AppTestHarness,
  type AppHandle,
} from "./appTestCase.js";
