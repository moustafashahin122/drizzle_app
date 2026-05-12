/**
 * @module drizzle-graphql-rbac/testing/base
 *
 * Shared low-level test helpers used by both `framework_testing` and
 * `app_testing`. Everything in this file is plumbing — there are no opinions
 * about schema, RBAC, or auth here:
 *
 *   - {@link getSharedSqlite} / {@link applySchemaSql} — one process-wide
 *     in-memory sqlite handle.
 *   - {@link transactionCase} — Odoo-style suite + per-test SAVEPOINT fixture.
 *   - {@link pushDrizzleSchema} — apply a Drizzle schema namespace to a sqlite
 *     handle via drizzle-kit (works around drizzle.all-rejects-DDL).
 *   - {@link jsonFetch} + cookie helpers — fire a request at any Hono app and
 *     parse the response into `{ status, body, setCookies }`.
 */
import { createRequire } from "node:module";
import { before, beforeEach, afterEach, after } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

// ---------------------------------------------------------------------------
// Shared sqlite + SAVEPOINT fixture
// ---------------------------------------------------------------------------

type Sqlite = Database.Database;

let sharedSqlite: Sqlite | undefined;
let suiteCounter = 0;
let testCounter = 0;

/** Process-wide singleton in-memory sqlite handle. Lazy on first call. */
export function getSharedSqlite(): Sqlite {
  if (!sharedSqlite) sharedSqlite = new Database(":memory:");
  return sharedSqlite;
}

/** Apply raw DDL to the shared sqlite handle. Use `CREATE TABLE IF NOT EXISTS`. */
export function applySchemaSql(sql: string): void {
  getSharedSqlite().exec(sql);
}

/**
 * Suite fixture with nested SAVEPOINTs:
 *
 *   before:      SAVEPOINT suite_n;  setUpClass() seeds reference data
 *   beforeEach:  SAVEPOINT test_m;
 *   afterEach:   ROLLBACK TO test_m; RELEASE
 *   after:       ROLLBACK TO suite_n; RELEASE
 *
 * Returns a Proxy over the ctx your setUpClass built — `tc.foo` reads through
 * to the live ctx. Accessing before setUpClass ran throws.
 *
 * Only SQL state is rolled back. In-memory state (RBAC role memberships, etc.)
 * is the suite's responsibility to reset.
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

// ---------------------------------------------------------------------------
// Drizzle schema push (via drizzle-kit)
// ---------------------------------------------------------------------------

// `drizzle-kit/api`'s ESM bundle uses a broken dynamic-require polyfill that
// throws on `require("fs")` under native ESM. The CJS entry works under ESM via
// `createRequire`. Same workaround used elsewhere in this package.
const kitApi = createRequire(import.meta.url)("drizzle-kit/api") as {
  pushSQLiteSchema: (
    imports: Record<string, unknown>,
    drizzleInstance: unknown,
  ) => Promise<{ statementsToExecute: string[] }>;
};

/**
 * Materialize a Drizzle schema onto a sqlite handle. Idempotent — on an
 * already-applied schema, drizzle-kit emits an empty statement list. Also
 * enables `PRAGMA foreign_keys = ON` so declared FKs actually fire.
 *
 * We bypass `drizzle.all(...)` because better-sqlite3 rejects DDL there
 * ("statement does not return data"); raw `sqlite.exec` sidesteps it.
 */
export async function pushDrizzleSchema(
  sqlite: Database.Database,
  schema: Record<string, unknown>,
): Promise<void> {
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  const { statementsToExecute } = await kitApi.pushSQLiteSchema(schema, db);
  for (const stmt of statementsToExecute) sqlite.exec(stmt);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface HonoLike {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

/**
 * Read every `Set-Cookie` header off a response. Node's WHATWG `Headers` only
 * exposes a concatenated value via `get("set-cookie")`; `getSetCookie()` (when
 * available) returns the list. This picks whichever the runtime offers.
 */
export function getSetCookieList(res: Response): string[] {
  const anyHdr = res.headers as unknown as {
    getSetCookie?: () => string[];
  };
  if (typeof anyHdr.getSetCookie === "function") return anyHdr.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

/** Pull a single cookie value out of a Set-Cookie list, or `null`. */
export function cookieValue(list: string[], name: string): string | null {
  for (const raw of list) {
    const first = raw.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    if (first.slice(0, eq).trim() !== name) continue;
    const v = first.slice(eq + 1).trim();
    return v || null;
  }
  return null;
}

export interface JsonFetchOpts {
  /** Object → JSON.stringify + content-type: application/json (unless overridden). */
  body?: unknown;
  /** Raw body string. Pairs with `contentType` for form-encoded routes. */
  rawBody?: BodyInit;
  /** Overrides the auto-JSON default. */
  contentType?: string;
  headers?: Record<string, string>;
  /** Sets `Authorization: Bearer <token>`. */
  bearer?: string;
  /** Sets the `Cookie` header verbatim — pass e.g. `sid=<token>`. */
  cookie?: string;
}

export interface JsonFetchResult {
  status: number;
  body: any;
  setCookies: string[];
}

/** Fire a request at a Hono app and parse the response. */
export async function jsonFetch(
  app: HonoLike,
  method: string,
  path: string,
  opts: JsonFetchOpts = {},
): Promise<JsonFetchResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    if (opts.contentType) headers["content-type"] = opts.contentType;
  } else if (opts.body !== undefined) {
    headers["content-type"] = opts.contentType ?? "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  } else if (opts.contentType) {
    headers["content-type"] = opts.contentType;
  }
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = opts.cookie;

  const res = await app.request(path, { method, headers, body });
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { parsed = text; }
  }
  return { status: res.status, body: parsed, setCookies: getSetCookieList(res) };
}
