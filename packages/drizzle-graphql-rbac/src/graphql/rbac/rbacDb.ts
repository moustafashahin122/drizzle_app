/**
 * @module graphql/rbac/rbacDb
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
 *   create are not modeled; ACL alone matches what the auto-CRUD does today.
 *
 * The wrapper mirrors the Drizzle chain API for the methods resolvers use
 * (`from`, `where`, `orderBy`, `limit`, `offset`, joins, `set`, `values`,
 * `returning`). Other methods are forwarded transparently. Awaiting the chain
 * (`then`/`catch`/`finally`) is the finalization point — that's when RBAC runs
 * and the combined `where` is attached.
 *
 * Escape hatch: `rbacDb.sudo` is the underlying unwrapped `db`. Use it for the
 * pre-auth bootstrap (resolving the session itself), seed scripts, and the
 * RBAC engine — anything that must run before there is a user. Every other
 * call site is expected to go through the enforced verbs above.
 */
import {
  and,
  getTableColumns,
  getTableName,
  is,
  Table,
  type SQL,
} from "drizzle-orm";
import { combineWhere, type ColumnMap } from "../builder/filters.js";
import { introspectSchema, type ExtractedRelation } from "../builder/relations.js";
import type { Action, RbacContext, RbacEnforce } from "./rbac.js";

export interface RbacDbDeps {
  /** The raw Drizzle DB (any dialect). */
  db: any;
  /** The same schema namespace passed to `buildSchema` — used to resolve a table reference back to its `schemaKey` (resource name). */
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
  schemaKey: string;
  columns: ColumnMap;
}

interface ResolvedDeps extends RbacDbDeps {
  byTable: Map<unknown, ResourceInfo>;
  /** schemaKey → Drizzle Table. Used to resolve `rbacDb.query.<schemaKey>` to a target. */
  tableBySchemaKey: Map<string, Table>;
  /** schemaKey → (relation fieldName → ExtractedRelation). Drives `with`-walking. */
  relBySchemaKey: Map<string, Map<string, ExtractedRelation>>;
}

/**
 * Build a factory that produces a per-request RBAC-bound db.
 *
 * @example
 * const rbacDbFor = buildRbacDb({ db, schema: dbModule, enforce: rbac.enforce });
 * // inside a request:
 * const rbacDb = rbacDbFor(ctx);
 * await rbacDb.select().from(todos);            // RBAC read enforced
 * await rbacDb.update(todos).set({...}).where(...); // RBAC update enforced
 */
export function buildRbacDb(deps: RbacDbDeps): (ctx: RbacContext) => RbacDb {
  const infoByTable = new Map<unknown, ResourceInfo>();
  const tableBySchemaKey = new Map<string, Table>();
  for (const [schemaKey, value] of Object.entries(deps.schema)) {
    if (value && is(value as any, Table)) {
      const table = value as Table;
      infoByTable.set(table, {
        schemaKey,
        columns: getTableColumns(table) as ColumnMap,
      });
      tableBySchemaKey.set(schemaKey, table);
    }
  }
  // Introspect declared relations + inline-FK auto-relations so `rbacDb.query.*`
  // can resolve a relation field name on the parent table back to the target
  // table (and from there to its schemaKey / columns / record-rule extra-where).
  const introspection = introspectSchema(deps.schema);
  const relBySchemaKey = new Map<string, Map<string, ExtractedRelation>>();
  for (const [sqlName, rels] of introspection.relations) {
    const schemaKey = introspection.keyByTableName.get(sqlName);
    if (!schemaKey) continue;
    const relationsByField = new Map<string, ExtractedRelation>();
    for (const r of rels) relationsByField.set(r.fieldName, r);
    relBySchemaKey.set(schemaKey, relationsByField);
  }
  const resolved: ResolvedDeps = { ...deps, byTable: infoByTable, tableBySchemaKey, relBySchemaKey };
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
 * (`then` / `catch` / `finally`). Use {@link RbacDb.sudo} to bypass the
 * wrapper entirely.
 *
 * Raw-SQL escapes (`db.execute`, `db.$with`, `db.run`, `db.all`, `db.get`,
 * `db.batch`) are intentionally **not** exposed on `RbacDb`: they cannot be
 * semantically gated and silent passthrough would be a footgun. Call them
 * through `rbacDb.sudo.execute(...)` etc., which makes the bypass visible at
 * the call site.
 */
export class RbacDb {
  /**
   * Per-call sudo escape: the raw, unwrapped Drizzle db. Reach for this only
   * in pre-user bootstrap paths (session resolution, seed scripts, server
   * startup). All other call sites should go through the enforced verbs.
   */
  readonly sudo: any;

  constructor(private deps: ResolvedDeps, private ctx: RbacContext) {
    this.sudo = deps.db;
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

  private bypassed(schemaKey: string): boolean {
    return this.deps.bypassResources?.has(schemaKey) ?? false;
  }

  private async runEnforce(schemaKey: string, action: Action, columns: ColumnMap): Promise<SQL | undefined> {
    const out = await this.deps.enforce(this.ctx, schemaKey, action, columns);
    return out.where;
  }

  /**
   * `select(projection?)` — returns a chain whose `.from(table)` triggers RBAC
   * read enforcement. AND-injects the record-rule where on finalize.
   */
  select(projection?: any): { from: (table: any) => any } {
    return {
      from: (table: any) => {
        const info = this.resolve(table);
        const baseChain = projection !== undefined
          ? this.deps.db.select(projection).from(table)
          : this.deps.db.select().from(table);
        if (this.bypassed(info.schemaKey)) return baseChain;
        return makeWhereInjectingProxy(
          baseChain,
          () => this.runEnforce(info.schemaKey, "read", info.columns),
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
    if (this.bypassed(info.schemaKey)) return baseChain;
    return makeWhereInjectingProxy(
      baseChain,
      () => this.runEnforce(info.schemaKey, "update", info.columns),
    );
  }

  /**
   * `delete(table)` — returns a chain that enforces `delete` and AND-injects
   * the record-rule where.
   */
  delete(table: any): any {
    const info = this.resolve(table);
    const baseChain = this.deps.db.delete(table);
    if (this.bypassed(info.schemaKey)) return baseChain;
    return makeWhereInjectingProxy(
      baseChain,
      () => this.runEnforce(info.schemaKey, "delete", info.columns),
    );
  }

  /**
   * `insert(table)` — enforces create ACL up front (throws on deny). The
   * returned chain is the raw Drizzle insert builder (no record-rule
   * post-validation, matching the auto-CRUD layer).
   */
  insert(table: any): any {
    const info = this.resolve(table);
    if (this.bypassed(info.schemaKey)) return this.deps.db.insert(table);
    // The enforce call is async; we need to gate the chain without the caller
    // having to `await` an extra step. Wrap the chain in a thenable proxy that
    // awaits enforce before forwarding the final query.
    return makeGatedProxy(
      () => this.deps.db.insert(table),
      () => this.runEnforce(info.schemaKey, "create", info.columns),
    );
  }

  /**
   * RBAC-enforced transaction. The callback receives a tx-bound `RbacDb`
   * sharing this instance's `ctx` and enforcement config; every verb invoked
   * on `txRbacDb` runs against the transaction's `tx` handle.
   *
   * **Sync dialects (better-sqlite3):** the driver's `tx.transaction(cb)` is
   * strictly synchronous — it does not await a promise returned from `cb`.
   * RBAC `enforce` is async, so a tx-bound `RbacDb` cannot honor the sync
   * contract. This method therefore throws on sync dialects; use
   * `rbacDb.sudo.transaction(syncCb)` for those (which inherits sudo semantics
   * for the entire block) and run any enforce checks before/after the tx.
   */
  transaction<T>(cb: (txRbacDb: RbacDb) => Promise<T>): Promise<T> {
    const dialectName = (this.deps.db as any)?.dialect?.constructor?.name;
    if (dialectName === "SQLiteSyncDialect") {
      throw new Error(
        "rbacDb: .transaction is unsupported on sync dialects (better-sqlite3). " +
        "Use rbacDb.sudo.transaction(syncCb) instead — the sync driver cannot await async RBAC enforce.",
      );
    }
    return this.deps.db.transaction(async (tx: any) => {
      const txDeps: ResolvedDeps = { ...this.deps, db: tx };
      const txRbacDb = new RbacDb(txDeps, this.ctx);
      return cb(txRbacDb);
    });
  }

  /**
   * Drizzle relational query API, RBAC-enforced.
   *
   * `rbacDb.query.<schemaKey>.findMany(opts)` / `.findFirst(opts)` resolves `<schemaKey>`
   * to its target table, runs `enforce(ctx, schemaKey, "read")`, and AND-injects
   * the record-rule SQL into `opts.where`. The walker then descends into
   * `opts.with` — each relation key is resolved through the introspected
   * relation graph to its target table, which gets its own enforce + where
   * injection, recursively.
   *
   * Bypassed resources fall through to the raw `db.query.<schemaKey>` API.
   *
   * Note: relational queries that use a callback-form `where` (e.g.
   * `where: (t, { eq }) => eq(t.x, 1)`) are still supported — the callback is
   * wrapped to AND-combine with the record-rule SQL.
   */
  get query(): any {
    const self = this;
    return new Proxy({}, {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        const table = self.deps.tableBySchemaKey.get(prop);
        if (!table) return self.deps.db.query?.[prop];
        const info = self.deps.byTable.get(table)!;
        if (self.bypassed(info.schemaKey)) return self.deps.db.query[prop];
        return {
          findMany: (opts: any = {}) => self.runRelQuery("findMany", info, opts),
          findFirst: (opts: any = {}) => self.runRelQuery("findFirst", info, opts),
        };
      },
    });
  }

  private async runRelQuery(
    method: "findMany" | "findFirst",
    info: ResourceInfo,
    opts: any,
  ): Promise<any> {
    const extra = await this.runEnforce(info.schemaKey, "read", info.columns);
    const rewritten = await this.rewriteRelOpts(info.schemaKey, opts, extra);
    return this.deps.db.query[info.schemaKey][method](rewritten);
  }

  private async rewriteRelOpts(
    schemaKey: string,
    opts: any,
    extra: SQL | undefined,
  ): Promise<any> {
    const out = opts ? { ...opts } : {};
    if (extra !== undefined) out.where = combineRelWhere(out.where, extra);
    if (opts?.with) out.with = await this.rewriteRelWith(schemaKey, opts.with);
    return out;
  }

  private async rewriteRelWith(
    parentSchemaKey: string,
    withObj: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const parentRelations = this.deps.relBySchemaKey.get(parentSchemaKey);
    const out: Record<string, unknown> = {};
    for (const [fieldName, value] of Object.entries(withObj)) {
      const rel = parentRelations?.get(fieldName);
      // Unknown relation: pass through and let Drizzle error if it's invalid.
      if (!rel) { out[fieldName] = value; continue; }
      const targetInfo = this.deps.byTable.get(rel.referencedTable);
      if (!targetInfo || this.bypassed(targetInfo.schemaKey)) {
        out[fieldName] = value;
        continue;
      }
      const extra = await this.runEnforce(
        targetInfo.schemaKey,
        "read",
        targetInfo.columns,
      );
      const sub: any = value === true ? {} : { ...(value as object) };
      if (extra !== undefined) sub.where = combineRelWhere(sub.where, extra);
      if (sub.with) sub.with = await this.rewriteRelWith(targetInfo.schemaKey, sub.with);
      out[fieldName] = sub;
    }
    return out;
  }
}

/**
 * Combine a user-supplied relational-query `where` (which Drizzle accepts as
 * either a `SQL` value or a `(fields, operators) => SQL` callback) with an
 * extra SQL fragment from the record-rule engine. Result preserves the
 * caller's form: callback in → callback out, value in → AND-combined value
 * out.
 */
function combineRelWhere(userWhere: any, extra: SQL): any {
  if (userWhere === undefined) return extra;
  if (typeof userWhere === "function") {
    return (fields: any, ops: any) => {
      const userCondition = userWhere(fields, ops);
      return userCondition !== undefined ? ops.and(userCondition, extra) : extra;
    };
  }
  return and(userWhere as SQL, extra);
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
      const member = chain[prop as any];
      if (typeof member === "function") {
        return (...args: any[]) => {
          const ret = member.apply(chain, args);
          // Drizzle's chain methods generally return the same builder (mutation)
          // or a new builder (e.g. .returning()) — either way, track the latest.
          if (ret !== undefined) chain = ret;
          return proxy;
        };
      }
      return member;
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
      const currentChain = ensureChain();
      const member = currentChain[prop as any];
      if (typeof member === "function") {
        return (...args: any[]) => {
          const ret = member.apply(currentChain, args);
          if (ret !== undefined) chain = ret;
          return proxy;
        };
      }
      return member;
    },
  });
  return proxy;
}
