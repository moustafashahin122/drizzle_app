/**
 * @module graphql/builder/builder-relations
 *
 * Summary
 * -------
 * Builds relation fields on per-table {@link GraphQLObjectType}s and the
 * per-request batch cache that coalesces sibling lookups into a single
 * `WHERE fk IN (...)` query.
 *
 * Notes
 * -----
 * A relation field with the same name as a scalar column **replaces** that
 * column on the **output** type only — the original scalar is still reachable
 * through `where` / `set` / Insert / Update inputs because those iterate the
 * unchanged column map.
 */
import {
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLFieldConfig,
} from "graphql";
import { and, eq, getTableName, inArray, type Column, type SQL } from "drizzle-orm";
import { applyListArgs, combineWhere } from "./filters.js";
import type { ExtractedRelation } from "./relations.js";
import type { DomainContext } from "../domain/domain.js";
import { GraphQLJSON } from "./scalars.js";
import type { DrizzleLike, Guard, TableMeta } from "./types.js";
import {
  jsKeyOf,
  projectionForSelection,
  selectProjected,
  whereDomainToSql,
} from "./util.js";

/**
 * Per-request batch cache. The GraphQL execution layer hands a fresh `Map` (on
 * the context's `batch` field) to each request; relation resolvers stash one
 * loader per `(parentTable, relation, args)` key in it so sibling parent rows
 * coalesce their child lookups into a single `WHERE fk IN (...)` query.
 */
export type BatchCache = Map<string, unknown>;

interface RelationLoader {
  load(key: unknown): Promise<unknown>;
}

/**
 * Build a relation field config for a parent table.
 *
 * "one" relations resolve to the single referenced row (or `null`); "many"
 * relations resolve to a non-null list and accept their own `where`,
 * `orderBy`, `limit`, `offset` arguments — composable with any conditions
 * implied by the parent row's local key. Both kinds resolve recursively
 * because the field's GraphQL type is the same registered ObjectType used at
 * the root, so nested selections traverse through the object's fields-thunk
 * again.
 *
 * Local/foreign columns come from the {@link ExtractedRelation} — populated
 * by `introspectSchema` from explicit `relations(...)` declarations,
 * auto-detected inline FKs (forward and inverse), or back-fill from a paired
 * `one`/`many` declaration. If a relation reaches this resolver without
 * resolved columns, it means the schema can't actually express the join, and
 * the field returns `null` / `[]` rather than guessing.
 */
export function buildRelationField(
  rel: ExtractedRelation,
  parentMeta: TableMeta,
  refMeta: TableMeta,
  db: DrizzleLike,
  refCtx: DomainContext,
  relationBatchSize: number,
  maxListLimit: number,
  /**
   * Guard for the referenced table. Resolved once at build time so each
   * traversal of this relation field AND-s the referenced table's read
   * record-rule into the join `where` (and throws FORBIDDEN if the caller
   * lacks a read ACL on the referenced resource). `null` when RBAC is
   * disabled or the referenced resource is on the bypass list — in that
   * case nested traversal behaves like a sudo read.
   */
  refGuard: Guard,
): GraphQLFieldConfig<any, any> {

  const isMany = rel.kind === "many";
  const baseType = isMany
    ? new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(refMeta.objectType)))
    : refMeta.objectType;

  return {
    type: baseType,
    args: isMany
      ? {
          where: { type: GraphQLJSON },
          orderBy: { type: refMeta.orderByInput },
          limit: { type: GraphQLInt },
          offset: { type: GraphQLInt },
        }
      : undefined,
    resolve: async (parent, args, context, info) => {
      const localCols = rel.fields;
      const refCols = rel.references;
      if (!localCols?.length || !refCols?.length) return isMany ? [] : null;

      // Clamp the caller's limit to the configured cap for many-relations.
      // `one` relations don't expose a `limit` arg. Copy; don't mutate.
      if (isMany) {
        const effectiveLimit = Math.min(args?.limit ?? maxListLimit, maxListLimit);
        args = { ...(args ?? {}), limit: effectiveLimit };
      }

      const keys: unknown[] = [];
      for (let i = 0; i < refCols.length; i++) {
        const localKey = jsKeyOf(parentMeta.columns, localCols[i]);
        if (!localKey) return isMany ? [] : null;
        const v = parent?.[localKey];
        if (v === undefined || v === null) return isMany ? [] : null;
        keys.push(v);
      }

      // Enforce RBAC on the referenced table: throws FORBIDDEN if the caller
      // has no read ACL, otherwise returns the row-level extra-where to AND
      // into the join. Without this, nested relation traversal would bypass
      // record rules that root resolvers do enforce.
      const rbacWhere = refGuard ? await refGuard(context, "read") : undefined;
      const argsWhere = isMany
        ? whereDomainToSql(args?.where, refMeta, refCtx, context)
        : undefined;
      const userWhere = combineWhere(rbacWhere, argsWhere);

      // Batch when (a) we have a per-request cache, (b) the join is single-column,
      // and (c) we don't need per-parent limit/offset (those can't be expressed
      // as a single IN-query without window functions / lateral joins).
      const batch: BatchCache | undefined = context?.batch;
      const canBatch =
        !!batch &&
        refCols.length === 1 &&
        !(isMany && (args?.limit != null || args?.offset != null));

      if (!canBatch) {
        const conds: SQL[] = [];
        for (let i = 0; i < refCols.length; i++) conds.push(eq(refCols[i], keys[i] as any));
        const joinSql = conds.length === 1 ? conds[0] : and(...conds);
        const where = combineWhere(joinSql, userWhere);
        const rows = await applyListArgs(
          selectProjected(db, refMeta, info),
          args,
          refMeta.columns,
          where,
        );
        return isMany ? rows : rows[0] ?? null;
      }

      // Cache key includes the projected columns so two siblings that select
      // different subfields don't share a loader (otherwise the second caller
      // would see a row missing its requested columns).
      const projection = projectionForSelection(refMeta, info);
      const projKeys = projection ? Object.keys(projection).sort().join(",") : "*";
      const cacheKey = `${getTableName(parentMeta.table)}.${rel.fieldName}|${
        isMany ? "many" : "one"
      }|${JSON.stringify(args?.where ?? null)}|${JSON.stringify(args?.orderBy ?? null)}|${projKeys}`;
      let loader = batch!.get(cacheKey) as RelationLoader | undefined;
      if (!loader) {
        loader = createRelationLoader(rel, refMeta, db, isMany, args, userWhere, projection, relationBatchSize);
        batch!.set(cacheKey, loader);
      }
      return loader.load(keys[0]);
    },
  };
}

/**
 * Build a DataLoader-style batched loader for a relation field.
 *
 * Parent resolvers all `await load(key)` synchronously within a tick; the
 * loader queues their keys, then on the next microtask runs a single
 * `SELECT ... WHERE refCol IN (queuedKeys)` query (composed with any caller
 * `where`/`orderBy`), groups rows by `refCol`, and resolves each pending
 * promise with that parent's slice (one row for `one` relations, an array for
 * `many`). All callers sharing the cache key see the same loader, so siblings
 * with identical args coalesce into a single round-trip.
 */
function createRelationLoader(
  rel: ExtractedRelation,
  refMeta: TableMeta,
  db: DrizzleLike,
  isMany: boolean,
  args: any,
  userWhere: SQL | undefined,
  projection: Record<string, Column> | undefined,
  relationBatchSize: number,
): RelationLoader {
  const refCol = rel.references![0];
  const refKeyName = jsKeyOf(refMeta.columns, refCol);
  // Ensure the join column is in the projection — even if the client didn't
  // request it, the loader needs it to bucket rows back to their parents.
  let proj = projection;
  if (proj && refKeyName && !(refKeyName in proj)) {
    proj = { ...proj, [refKeyName]: refCol };
  }
  type Pending = { key: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
  let queue: Pending[] = [];
  let scheduled = false;

  const flush = async () => {
    const pending = queue;
    queue = [];
    scheduled = false;
    try {
      if (!refKeyName) {
        for (const p of pending) p.resolve(isMany ? [] : null);
        return;
      }
      const uniqueKeys = Array.from(new Set(pending.map((p) => p.key)));
      // Chunk the IN-list by relationBatchSize so very wide parent fan-outs
      // don't blow past driver/DB parameter limits with a single oversized
      // query. Infinity disables chunking. Each chunk issues one SELECT;
      // results are merged back into a single per-key bucket map before
      // pending promises are resolved, so each pending caller sees the same
      // shape regardless of chunk boundaries.
      const chunkSize =
        Number.isFinite(relationBatchSize) && relationBatchSize > 0
          ? Math.floor(relationBatchSize)
          : uniqueKeys.length;
      const allRows: any[] = [];
      for (let i = 0; i < uniqueKeys.length; i += chunkSize) {
        const chunk = uniqueKeys.slice(i, i + chunkSize);
        const joinSql = inArray(refCol, chunk as any[]);
        const where = combineWhere(joinSql, userWhere);
        const baseSelect = proj
          ? db.select(proj).from(refMeta.table as any)
          : db.select().from(refMeta.table as any);
        const rows: any[] = await applyListArgs(
          baseSelect,
          // limit/offset are dropped at the per-batch level (they were only
          // safe to apply per-parent, which the canBatch gate already excluded
          // for `many` relations; for `one` relations args is undefined).
          args ? { orderBy: args.orderBy } : undefined,
          refMeta.columns,
          where,
        );
        for (const r of rows) allRows.push(r);
      }
      if (isMany) {
        const buckets = new Map<unknown, any[]>();
        for (const row of allRows) {
          const k = row[refKeyName];
          let arr = buckets.get(k);
          if (!arr) buckets.set(k, (arr = []));
          arr.push(row);
        }
        for (const p of pending) p.resolve(buckets.get(p.key) ?? []);
      } else {
        const byKey = new Map<unknown, any>();
        for (const row of allRows) {
          const k = row[refKeyName];
          if (!byKey.has(k)) byKey.set(k, row);
        }
        for (const p of pending) p.resolve(byKey.get(p.key) ?? null);
      }
    } catch (err) {
      for (const p of pending) p.reject(err);
    }
  };

  return {
    load(key) {
      return new Promise((resolve, reject) => {
        queue.push({ key, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      });
    },
  };
}
