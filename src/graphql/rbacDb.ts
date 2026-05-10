/**
 * @module graphql/rbacDb
 *
 * Per-request RBAC-bound Drizzle wrapper. Resolvers that use `ctx.db` instead
 * of the raw `db` get RBAC enforced automatically — no need to call
 * `rbac.enforce` at every call site.
 *
 * Behavior
 * --------
 * - `select().from(t)` → enforces `read`, AND-injects the record-rule SQL into
 *   the user's `where` (silent narrow, matching the auto-CRUD layer).
 * - `update(t).set(...).where(...)` → enforces `update`, AND-injects.
 * - `delete(t).where(...)` → enforces `delete`, AND-injects.
 * - `insert(t).values(...)` → enforces `create` ACL only. Record rules on
 *   create are not modeled (would require post-insert validation in a
 *   transaction); ACL alone matches what the auto-CRUD does today.
 *
 * The wrapper mirrors the Drizzle chain API for the methods resolvers use
 * (`from`, `where`, `orderBy`, `limit`, `offset`, joins, `set`, `values`,
 * `returning`). Other methods are forwarded transparently. Awaiting the chain
 * (`then`/`catch`/`finally`) is the finalization point — that's when RBAC runs
 * and the combined `where` is attached.
 *
 * Escape hatch: `rdb.raw` is the underlying unwrapped `db`. Use it for the
 * pre-auth bootstrap (resolving the session itself), seed scripts, and the
 * RBAC engine — anything that must run before there is a user.
 */
import {
  getTableColumns,
  is,
  Table,
  type SQL,
} from "drizzle-orm";
import { combineWhere, type ColumnMap } from "./filters.js";
import type { Action, RbacContext, RbacEnforce } from "./rbac.js";

export interface RbacDbDeps {
  /** The raw Drizzle DB (any dialect). */
  db: any;
  /** The same schema namespace passed to `buildSchema` — used to resolve a table reference back to its `jsKey` (resource name). */
  schema: Record<string, unknown>;
  /** RBAC enforce hook from {@link buildRbac}. */
  enforce: RbacEnforce;
  /**
   * Resources exempt from enforcement (e.g. internal tables touched only by
   * admin tooling). A call against a bypassed table acts as a passthrough to
   * the raw db.
   */
  bypassResources?: Set<string>;
}

interface ResourceInfo {
  jsKey: string;
  columns: ColumnMap;
}

interface ResolvedDeps extends RbacDbDeps {
  byTable: Map<unknown, ResourceInfo>;
}

/**
 * Build a factory that produces a per-request RBAC-bound db.
 *
 * @example
 * const rdbFor = buildRbacDb({ db, schema: dbModule, enforce: rbac.enforce });
 * // inside a request:
 * const rdb = rdbFor(ctx);
 * await rdb.select().from(todos);            // RBAC read enforced
 * await rdb.update(todos).set({...}).where(...); // RBAC update enforced
 */
export function buildRbacDb(deps: RbacDbDeps): (ctx: RbacContext) => RbacDb {
  const byTable = new Map<unknown, ResourceInfo>();
  for (const [jsKey, value] of Object.entries(deps.schema)) {
    if (value && is(value as any, Table)) {
      byTable.set(value, {
        jsKey,
        columns: getTableColumns(value as any) as ColumnMap,
      });
    }
  }
  const resolved: ResolvedDeps = { ...deps, byTable };
  return (ctx) => new RbacDb(resolved, ctx);
}

/**
 * Per-request Drizzle wrapper that runs RBAC `enforce` automatically on
 * `select` / `update` / `delete` / `insert` and AND-injects record-rule SQL
 * into the user's `where` (except `insert`, which is ACL-only). Constructed
 * by {@link buildRbacDb}; resolvers receive an instance via `ctx.db`.
 *
 * Method chains mirror the Drizzle builder API (`.from`, `.where`, `.set`,
 * `.values`, `.returning`, `.limit`, `.offset`, `.orderBy`, joins). The chain
 * is finalized — and RBAC actually runs — only when the caller awaits it
 * (`then` / `catch` / `finally`). Use {@link RbacDb.raw} to bypass the
 * wrapper entirely.
 */
export class RbacDb {
  /** Escape hatch: the raw, unwrapped Drizzle db. */
  readonly raw: any;

  constructor(private deps: ResolvedDeps, private ctx: RbacContext) {
    this.raw = deps.db;
  }

  private resolve(table: unknown): ResourceInfo {
    const info = this.deps.byTable.get(table);
    if (!info) {
      throw new Error(
        "rbacDb: table is not registered in the schema namespace passed to buildRbacDb",
      );
    }
    return info;
  }

  private bypassed(jsKey: string): boolean {
    return this.deps.bypassResources?.has(jsKey) ?? false;
  }

  private async runEnforce(jsKey: string, action: Action, columns: ColumnMap): Promise<SQL | undefined> {
    const out = await this.deps.enforce(this.ctx, jsKey, action, columns);
    return out.where;
  }

  /**
   * `select(projection?)` — returns a chain whose `.from(table)` triggers RBAC
   * read enforcement. AND-injects the record-rule where on finalize.
   */
  select(projection?: any): { from: (table: any) => any } {
    const deps = this.deps;
    const ctx = this.ctx;
    const resolveFn = this.resolve.bind(this);
    const bypassedFn = this.bypassed.bind(this);
    const enforceFn = this.runEnforce.bind(this);
    return {
      from(table: any) {
        const info = resolveFn(table);
        const baseChain = projection !== undefined
          ? deps.db.select(projection).from(table)
          : deps.db.select().from(table);
        if (bypassedFn(info.jsKey)) return baseChain;
        return makeWhereInjectingProxy(
          baseChain,
          () => enforceFn(info.jsKey, "read", info.columns),
        );
      },
    };
  }

  /**
   * `update(table)` — returns a chain that enforces `update` and AND-injects
   * the record-rule where into whatever the caller passes to `.where(...)`.
   */
  update(table: any): any {
    const info = this.resolve(table);
    const baseChain = this.deps.db.update(table);
    if (this.bypassed(info.jsKey)) return baseChain;
    return makeWhereInjectingProxy(
      baseChain,
      () => this.runEnforce(info.jsKey, "update", info.columns),
    );
  }

  /**
   * `delete(table)` — returns a chain that enforces `delete` and AND-injects
   * the record-rule where.
   */
  delete(table: any): any {
    const info = this.resolve(table);
    const baseChain = this.deps.db.delete(table);
    if (this.bypassed(info.jsKey)) return baseChain;
    return makeWhereInjectingProxy(
      baseChain,
      () => this.runEnforce(info.jsKey, "delete", info.columns),
    );
  }

  /**
   * `insert(table)` — enforces create ACL up front (throws on deny). The
   * returned chain is the raw Drizzle insert builder (no record-rule
   * post-validation, matching the auto-CRUD layer).
   */
  insert(table: any): any {
    const info = this.resolve(table);
    if (this.bypassed(info.jsKey)) return this.deps.db.insert(table);
    // The enforce call is async; we need to gate the chain without the caller
    // having to `await` an extra step. Wrap the chain in a thenable proxy that
    // awaits enforce before forwarding the final query.
    return makeGatedProxy(
      () => this.deps.db.insert(table),
      () => this.runEnforce(info.jsKey, "create", info.columns),
    );
  }
}

// ---------------------------------------------------------------------------
// Chain proxies
// ---------------------------------------------------------------------------

/**
 * Wrap a Drizzle chain so:
 * - `.where(w)` is captured (not forwarded yet).
 * - All other chain methods (limit/offset/orderBy/joins/set/values/returning)
 *   pass through and the proxy keeps tracking the current chain.
 * - On `.then` / `.catch` / `.finally` (await), enforce runs, the captured
 *   user where is AND-ed with the RBAC extra where, the combined where is
 *   attached to the chain, and the chain is awaited.
 */
function makeWhereInjectingProxy(
  initialChain: any,
  getExtra: () => Promise<SQL | undefined>,
): any {
  let chain: any = initialChain;
  let userWhere: SQL | undefined;

  const finalize = async () => {
    const extra = await getExtra();
    const combined = combineWhere(extra, userWhere);
    const finalChain = combined !== undefined ? chain.where(combined) : chain;
    return await finalChain;
  };

  const proxy: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "where") {
        return (w: SQL | undefined) => {
          userWhere = w;
          return proxy;
        };
      }
      if (prop === "then") {
        return (resolve: any, reject: any) => finalize().then(resolve, reject);
      }
      if (prop === "catch") {
        return (reject: any) => finalize().catch(reject);
      }
      if (prop === "finally") {
        return (cb: any) => finalize().finally(cb);
      }
      const v = chain[prop as any];
      if (typeof v === "function") {
        return (...args: any[]) => {
          const ret = v.apply(chain, args);
          // Drizzle's chain methods generally return the same builder (mutation)
          // or a new builder (e.g. .returning()) — either way, track the latest.
          if (ret !== undefined) chain = ret;
          return proxy;
        };
      }
      return v;
    },
  });
  return proxy;
}

/**
 * Wrap a Drizzle chain with no where-injection: just await `gate()` before
 * the chain executes. Used for inserts (ACL-only, no row-level rule).
 */
function makeGatedProxy(getChain: () => any, gate: () => Promise<unknown>): any {
  let chain: any;
  const ensureChain = () => (chain ??= getChain());

  const finalize = async () => {
    await gate();
    return await ensureChain();
  };

  const proxy: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: any, reject: any) => finalize().then(resolve, reject);
      }
      if (prop === "catch") {
        return (reject: any) => finalize().catch(reject);
      }
      if (prop === "finally") {
        return (cb: any) => finalize().finally(cb);
      }
      const c = ensureChain();
      const v = c[prop as any];
      if (typeof v === "function") {
        return (...args: any[]) => {
          const ret = v.apply(c, args);
          if (ret !== undefined) chain = ret;
          return proxy;
        };
      }
      return v;
    },
  });
  return proxy;
}
