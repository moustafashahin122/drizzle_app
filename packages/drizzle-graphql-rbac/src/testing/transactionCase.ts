/**
 * @module drizzle-graphql-rbac/testing
 *
 * Shared-singleton test fixture inspired by Odoo's `TransactionCase`.
 *
 * The testing module owns ONE in-memory SQLite database, created lazily on
 * first access and reused for every test in the process. Test modules and
 * suites populate the database in their own `before` / `beforeEach` hooks;
 * a pair of nested SAVEPOINTs keeps both suite-level seed data and per-test
 * mutations from leaking:
 *
 *   process boot
 *     ├─ getSharedSqlite() lazy-creates one :memory: handle
 *     ├─ applySchemaSql(...)        ← idempotent DDL, called from each module
 *     │
 *     │  for each test suite (file or describe block) using transactionCase:
 *     │    ├─ before:       SAVEPOINT suite_n
 *     │    │                run user's setUpClass (seeds reference data)
 *     │    │
 *     │    │  for each it:
 *     │    │    ├─ beforeEach: SAVEPOINT test_m
 *     │    │    │              (any before / beforeEach in the user's
 *     │    │    │               describe block runs inside this savepoint)
 *     │    │    ├─ it body
 *     │    │    └─ afterEach:  ROLLBACK TO test_m ; RELEASE
 *     │    │
 *     │    └─ after:        ROLLBACK TO suite_n ; RELEASE
 *     │
 *     └─ process exit (sqlite handle closed by OS; no explicit teardown)
 *
 * Public surface:
 *
 *   - {@link getSharedSqlite}  — the singleton handle (better-sqlite3).
 *   - {@link applySchemaSql}   — idempotent DDL apply.
 *   - {@link transactionCase}  — fixture with nested savepoints; returns a
 *                                Proxy over the ctx your setUpClass builds.
 */
import { before, beforeEach, afterEach, after } from "node:test";
import Database from "better-sqlite3";

type Sqlite = Database.Database;

let sharedSqlite: Sqlite | undefined;

// Counters are module-level so savepoint names are unique across the
// process. That means a stale `ROLLBACK TO foo` can never accidentally
// match a name from a different suite.
let suiteCounter = 0;
let testCounter = 0;

/**
 * The process-wide singleton sqlite handle. Created lazily on first call
 * via `new Database(":memory:")`. Subsequent calls return the same handle.
 *
 * Apps that need a different connection (file-backed DB, foreign keys on,
 * etc.) can issue PRAGMAs through this handle on first import.
 */
export function getSharedSqlite(): Sqlite {
  if (!sharedSqlite) sharedSqlite = new Database(":memory:");
  return sharedSqlite;
}

/**
 * Apply DDL to the shared sqlite handle. Intended for module-load-time use
 * from test fixtures. Use `CREATE TABLE IF NOT EXISTS ...` so multiple
 * modules can call this safely with the same schema.
 */
export function applySchemaSql(sql: string): void {
  getSharedSqlite().exec(sql);
}

/**
 * Suite fixture. Pass a `setUpClass` function that builds and returns the
 * suite's baseline state — typically a freshly-built rbac engine and
 * whatever seed data the suite needs. The function runs once in a `before`
 * hook, INSIDE a suite-level SAVEPOINT, so any rows it inserts disappear
 * when the suite finishes and the next suite starts with an empty schema.
 *
 * Returns a `Proxy` over the live ctx — `tc.foo` reads through to the
 * current ctx, mirroring Odoo's `self.foo` style. Accessing the proxy
 * before `setUpClass` has run throws a clear error (catches the common
 * bug of destructuring at module scope).
 *
 * Two layers of SAVEPOINT are managed for you:
 *
 *   - a suite-level savepoint around setUpClass and all its tests, rolled
 *     back in `after` (so the suite's seed data vanishes between files).
 *   - a per-test savepoint around each `it`, rolled back in `afterEach`
 *     (so per-test inserts/updates/deletes vanish between tests).
 *
 * RBAC role memberships and any other in-memory state mutated by the test
 * are NOT rolled back by these savepoints — only SQL state is. If a suite
 * mutates non-DB state per-test, it must reset that state explicitly.
 */
export function transactionCase<Ctx extends object>(
  setUpClass: () => Promise<Ctx> | Ctx,
): Ctx {
  let ctx: Ctx | undefined;
  let suiteSp = "";
  let testSp = "";

  before(async () => {
    const sqlite = getSharedSqlite();
    suiteSp = `suite_${++suiteCounter}`;
    sqlite.exec(`SAVEPOINT ${suiteSp}`);
    try {
      ctx = await setUpClass();
    } catch (err) {
      // Don't leave a half-applied seed on the shared DB if setUpClass throws.
      try {
        sqlite.exec(`ROLLBACK TO SAVEPOINT ${suiteSp}`);
        sqlite.exec(`RELEASE SAVEPOINT ${suiteSp}`);
      } catch { /* best-effort */ }
      throw err;
    }
  });

  beforeEach(() => {
    if (!ctx) throw new Error("transactionCase: setUpClass did not produce a ctx");
    testSp = `test_${++testCounter}`;
    getSharedSqlite().exec(`SAVEPOINT ${testSp}`);
  });

  afterEach(() => {
    if (!ctx) return;
    const sqlite = getSharedSqlite();
    // ROLLBACK TO rewinds DB state; RELEASE pops the marker so the savepoint
    // stack does not grow across tests.
    sqlite.exec(`ROLLBACK TO SAVEPOINT ${testSp}`);
    sqlite.exec(`RELEASE SAVEPOINT ${testSp}`);
  });

  after(() => {
    if (!ctx) return;
    const sqlite = getSharedSqlite();
    try {
      sqlite.exec(`ROLLBACK TO SAVEPOINT ${suiteSp}`);
      sqlite.exec(`RELEASE SAVEPOINT ${suiteSp}`);
    } catch { /* best-effort */ }
  });

  return new Proxy({} as Ctx, {
    get(_, prop) {
      if (!ctx) {
        throw new Error(
          `transactionCase: property '${String(prop)}' accessed before setUpClass ran. ` +
          `Access tc fields inside 'it' bodies, not at module scope.`,
        );
      }
      return (ctx as any)[prop];
    },
  });
}
