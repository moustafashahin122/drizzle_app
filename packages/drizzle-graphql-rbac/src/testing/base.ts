/**
 * @module drizzle-graphql-rbac/testing/base
 *
 * Low-level test plumbing — no opinions on schema, RBAC, or auth.
 *
 *   - {@link transactionCase}   — node:test suite + per-test SAVEPOINT fixture.
 *   - {@link pushDrizzleSchema} — apply a Drizzle schema via drizzle-kit.
 *   - {@link jsonFetch}         — fire a request at a Hono-like app.
 *   - {@link cookieValue}       — read a single cookie out of a Set-Cookie list.
 *
 * No process-wide sqlite handle. Each `transactionCase` call owns its own
 * `:memory:` database (created in `before`, closed in `after`) so test files
 * cannot leak rows into each other regardless of how `node --test` parallelises.
 * Callers that need to share a handle across suites (e.g. the framework's
 * `__helpers__.ts` fixture) pass one explicitly via `options.sqlite`.
 */
import { createRequire } from "node:module";
import { before, beforeEach, afterEach, after } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

// ---------------------------------------------------------------------------
// SAVEPOINT-based suite fixture
// ---------------------------------------------------------------------------

let savepointCounter = 0;
const nextSavepointName = (kind: "suite" | "test") => `${kind}_${++savepointCounter}`;

export interface TransactionCaseOptions {
  /**
   * Pre-existing sqlite handle to run the SAVEPOINTs against. If omitted,
   * `transactionCase` opens a fresh `:memory:` database in `before` and
   * closes it in `after`, giving the suite a fully isolated DB.
   *
   * Pass one explicitly when you need multiple `transactionCase` blocks to
   * share state (e.g. a schema fixture pushed once at module load).
   */
  sqlite?: Database.Database;
}

/**
 * Suite fixture with nested SAVEPOINTs:
 *
 *   before:     open :memory: sqlite (unless provided); SAVEPOINT suite_n;
 *               setUpClass(sqlite) seeds reference data
 *   beforeEach: SAVEPOINT test_m
 *   afterEach:  ROLLBACK TO test_m
 *   after:      ROLLBACK TO suite_n; close sqlite if we opened it
 *
 * Returns a Proxy over the ctx — `tc.foo` reads through to the live ctx, but
 * only after `setUpClass` has run, so access it from inside `it` bodies.
 *
 * Only SQL state is rolled back; in-process state (caches, singletons,
 * captured row snapshots) is the suite's problem.
 */
export function transactionCase<Ctx extends object>(
  setUpClass: (sqlite: Database.Database) => Promise<Ctx> | Ctx,
  options: TransactionCaseOptions = {},
): Ctx {
  let ctx: Ctx | undefined;
  let sqlite: Database.Database | undefined;
  let ownsSqlite = false;
  let suiteSp = "";
  let testSp = "";

  before(async () => {
    if (options.sqlite) {
      sqlite = options.sqlite;
      ownsSqlite = false;
    } else {
      sqlite = new Database(":memory:");
      ownsSqlite = true;
    }
    suiteSp = nextSavepointName("suite");
    sqlite.exec(`SAVEPOINT ${suiteSp}`);
    try {
      ctx = await setUpClass(sqlite);
    } catch (err) {
      try { sqlite.exec(`ROLLBACK TO SAVEPOINT ${suiteSp}; RELEASE SAVEPOINT ${suiteSp}`); } catch {}
      if (ownsSqlite) {
        try { sqlite.close(); } catch {}
        sqlite = undefined;
      }
      throw err;
    }
  });

  beforeEach(() => {
    if (!ctx || !sqlite) throw new Error("transactionCase: setUpClass did not produce a ctx");
    testSp = nextSavepointName("test");
    sqlite.exec(`SAVEPOINT ${testSp}`);
  });

  afterEach(() => {
    if (ctx && sqlite) sqlite.exec(`ROLLBACK TO SAVEPOINT ${testSp}; RELEASE SAVEPOINT ${testSp}`);
  });

  after(() => {
    if (!sqlite) return;
    try { sqlite.exec(`ROLLBACK TO SAVEPOINT ${suiteSp}; RELEASE SAVEPOINT ${suiteSp}`); } catch {}
    if (ownsSqlite) {
      try { sqlite.close(); } catch {}
    }
    sqlite = undefined;
  });

  return new Proxy({} as Ctx, {
    get(_, prop) {
      if (!ctx) {
        throw new Error(
          `transactionCase: '${String(prop)}' accessed before setUpClass ran — use inside 'it' bodies.`,
        );
      }
      return (ctx as any)[prop];
    },
  });
}

// ---------------------------------------------------------------------------
// Drizzle schema push (via drizzle-kit)
// ---------------------------------------------------------------------------

// drizzle-kit/api's ESM bundle has a broken dynamic-require polyfill; the CJS
// entry works under native ESM via createRequire.
const kitApi = createRequire(import.meta.url)("drizzle-kit/api") as {
  pushSQLiteSchema: (
    imports: Record<string, unknown>,
    drizzleInstance: unknown,
  ) => Promise<{ statementsToExecute: string[] }>;
};

/**
 * Materialize a Drizzle schema onto a sqlite handle. Idempotent. Enables
 * `PRAGMA foreign_keys = ON`. Bypasses `drizzle.all` because better-sqlite3
 * rejects DDL there.
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

/** Pull a single cookie value out of a Set-Cookie list, or `null`. */
export function cookieValue(list: string[], name: string): string | null {
  for (const raw of list) {
    const first = raw.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq < 0 || first.slice(0, eq).trim() !== name) continue;
    return first.slice(eq + 1).trim() || null;
  }
  return null;
}

interface JsonFetchOpts {
  /** Object → JSON.stringify + `content-type: application/json` (unless overridden). */
  body?: unknown;
  /** Raw body. Pairs with `contentType` for form-encoded routes. */
  rawBody?: BodyInit;
  contentType?: string;
  headers?: Record<string, string>;
  /** Sets `Authorization: Bearer <token>`. */
  bearer?: string;
  /** Sets the `Cookie` header verbatim. */
  cookie?: string;
}

interface JsonFetchResult {
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
  const body = buildBody(opts, headers);
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = opts.cookie;

  const res = await app.request(path, { method, headers, body });
  return {
    status: res.status,
    body: await readJsonOrText(res),
    setCookies: readSetCookies(res),
  };
}

function buildBody(opts: JsonFetchOpts, headers: Record<string, string>): BodyInit | undefined {
  if (opts.rawBody !== undefined) {
    if (opts.contentType) headers["content-type"] = opts.contentType;
    return opts.rawBody;
  }
  if (opts.body !== undefined) {
    headers["content-type"] = opts.contentType ?? "application/json";
    return typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  if (opts.contentType) headers["content-type"] = opts.contentType;
  return undefined;
}

async function readJsonOrText(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function readSetCookies(res: Response): string[] {
  // Node 20+ exposes getSetCookie(); older runtimes only concat via .get().
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}
