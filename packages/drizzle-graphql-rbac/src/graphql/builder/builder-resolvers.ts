/**
 * @module graphql/builder/builder-resolvers
 *
 * Summary
 * -------
 * Pass 2 of {@link buildSchema}: wires per-table root fields onto the Query
 * and Mutation maps and implements the CRUD resolvers (RBAC ACL + record-rule
 * enforcement, JSON domain → SQL translation, projected SELECTs,
 * `.returning()` on mutations, empty-WHERE guards on update/delete, and the
 * transactional post-check for INSERTs gated by a create-domain record rule).
 */
import {
  GraphQLError,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
} from "graphql";
import { and, eq, type Column, type SQL } from "drizzle-orm";
import { applyListArgs, combineWhere } from "./filters.js";
import type { DomainContext } from "../domain/domain.js";
import { GraphQLJSON } from "./scalars.js";
import type { BuildSchemaOptions } from "./builder.js";
import type { DrizzleLike, Guard, TableMeta } from "./types.js";
import { selectProjected, whereDomainToSql } from "./util.js";
import { isPrimary } from "./drizzle-internals.js";

/**
 * Attach the standard CRUD root fields for a table to the Query and Mutation
 * field maps:
 *
 * - `Query.<jsKey>(where?, orderBy?, limit?, offset?): [<Type>!]!`
 * - `Query.<jsKey>Single(where?, orderBy?): <Type>` (returns first match or null)
 * - `Mutation.insertInto<TypeName>(values: [<Type>Insert!]!): [<Type>!]!`
 * - `Mutation.update<TypeName>(set: <Type>Update!, where?): [<Type>!]!`
 * - `Mutation.deleteFrom<TypeName>(where?): [<Type>!]!`
 *
 * All mutation resolvers use Drizzle's `.returning()` so the response contains
 * the affected rows directly.
 */
export function addRootFields(
  meta: TableMeta,
  queryFields: GraphQLFieldConfigMap<unknown, unknown>,
  mutationFields: GraphQLFieldConfigMap<unknown, unknown>,
  db: DrizzleLike,
  ctx: DomainContext,
  rbac: BuildSchemaOptions["rbac"],
) {
  // Resolve once: a function that returns the rbac extra-where for a given
  // request context, or undefined when rbac is disabled / bypassed for this
  // resource.
  const bypass = rbac?.bypassResources?.has(meta.jsKey);
  const guard: Guard = rbac && !bypass
    ? async (gqlCtx: any, action: "create" | "read" | "update" | "delete") =>
        (await rbac.enforce(gqlCtx, meta.jsKey, action, meta.columns)).where
    : null;

  queryFields[meta.jsKey] = buildListQueryField(meta, db, ctx, guard);
  queryFields[`${meta.jsKey}Single`] = buildSingleQueryField(meta, db, ctx, guard);
  mutationFields[`insertInto${meta.typeName}`] = buildInsertMutationField(meta, db, guard);
  mutationFields[`update${meta.typeName}`] = buildUpdateMutationField(meta, db, ctx, guard);
  mutationFields[`deleteFrom${meta.typeName}`] = buildDeleteMutationField(meta, db, ctx, guard);
}

/** Non-null list of the table's object type — used as the return type of all list/mutation root fields. */
function listType(meta: TableMeta) {
  return new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(meta.objectType)));
}

/** Standard `(where?, orderBy?, limit?, offset?)` arg map for list queries. */
function listArgsConfig(meta: TableMeta) {
  return {
    where: { type: GraphQLJSON },
    orderBy: { type: meta.orderByInput },
    limit: { type: GraphQLInt },
    offset: { type: GraphQLInt },
  };
}

/** `Query.<jsKey>(where?, orderBy?, limit?, offset?)` — paginated list. */
function buildListQueryField(
  meta: TableMeta,
  db: DrizzleLike,
  ctx: DomainContext,
  guard: Guard,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: listType(meta),
    args: listArgsConfig(meta),
    resolve: async (_, args, gqlCtx, info) => {
      const extra = guard ? await guard(gqlCtx, "read") : undefined;
      const userWhere = whereDomainToSql(args?.where, meta, ctx, gqlCtx);
      const where = combineWhere(extra, userWhere);
      return applyListArgs(selectProjected(db, meta, info), args, meta.columns, where);
    },
  };
}

/** `Query.<jsKey>Single(where?, orderBy?)` — first matching row or null. */
function buildSingleQueryField(
  meta: TableMeta,
  db: DrizzleLike,
  ctx: DomainContext,
  guard: Guard,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: meta.objectType,
    args: { where: { type: GraphQLJSON }, orderBy: { type: meta.orderByInput } },
    resolve: async (_, args, gqlCtx, info) => {
      const extra = guard ? await guard(gqlCtx, "read") : undefined;
      const userWhere = whereDomainToSql(args?.where, meta, ctx, gqlCtx);
      const where = combineWhere(extra, userWhere);
      const rows = await applyListArgs(
        selectProjected(db, meta, info),
        args,
        meta.columns,
        where,
      ).limit(1);
      return rows[0] ?? null;
    },
  };
}

/** `Mutation.insertInto<TypeName>(values)` — bulk insert, returns inserted rows. */
function buildInsertMutationField(
  meta: TableMeta,
  db: DrizzleLike,
  guard: Guard,
): GraphQLFieldConfig<unknown, unknown> {
  // Primary-key columns of the table. Used to re-fetch inserted rows for
  // create-domain post-check. Computed once per schema build.
  const pkEntries: Array<[string, Column]> = Object.entries(meta.columns).filter(
    ([, c]) => isPrimary(c),
  );
  return {
    type: listType(meta),
    args: {
      values: {
        type: new GraphQLNonNull(
          new GraphQLList(new GraphQLNonNull(meta.insertInput)),
        ),
      },
    },
    resolve: async (_, args, gqlCtx) => {
      // ACL check (and capture optional create-domain SQL for post-check).
      const createWhere = guard ? await guard(gqlCtx, "create") : undefined;

      // Fast path: no create-domain (admin bypass, no rules, or rbac disabled).
      // Behavior unchanged.
      if (!createWhere) {
        return db.insert(meta.table).values(args.values).returning();
      }

      // Need transactional post-check: insert, then verify each row matches the
      // create-domain by re-selecting through PK + create-domain AND. If any
      // row fails, the throw rolls the tx back.
      if (!pkEntries.length) {
        // No primary key to re-fetch by — refuse rather than silently accept.
        throw new GraphQLError("rbac: insert blocked by record rule", {
          extensions: { code: "FORBIDDEN" },
        });
      }
      // Drizzle's `db.transaction(...)` callback dispatch differs by driver:
      // better-sqlite3 invokes it synchronously and refuses a promise return
      // value; node-postgres / mysql2 / libsql expect an async callback. We
      // sniff the dialect to pick the right shape — both code paths do the
      // same per-row PK + create-domain re-select.
      const anyDb = db as any;
      const isSync = anyDb?.dialect?.constructor?.name === "SQLiteSyncDialect";
      const checkRow = (tx: any, row: any): SQL => {
        const pkConds: SQL[] = [];
        for (const [name, col] of pkEntries) {
          pkConds.push(eq(col, row[name] as any));
        }
        const pkSql = pkConds.length === 1 ? pkConds[0] : and(...pkConds)!;
        return combineWhere(pkSql, createWhere)!;
      };
      if (isSync) {
        return anyDb.transaction((tx: any) => {
          const inserted: any[] = tx
            .insert(meta.table)
            .values(args.values)
            .returning()
            .all();
          for (const row of inserted) {
            const matchWhere = checkRow(tx, row);
            const matched: any[] = tx
              .select()
              .from(meta.table)
              .where(matchWhere)
              .limit(1)
              .all();
            if (!matched.length) {
              throw new GraphQLError("rbac: insert blocked by record rule", {
                extensions: { code: "FORBIDDEN" },
              });
            }
          }
          return inserted;
        });
      }
      return await anyDb.transaction(async (tx: any) => {
        const inserted: any[] = await tx
          .insert(meta.table)
          .values(args.values)
          .returning();
        for (const row of inserted) {
          const matchWhere = checkRow(tx, row);
          const matched: any[] = await tx
            .select()
            .from(meta.table)
            .where(matchWhere)
            .limit(1);
          if (!matched.length) {
            throw new GraphQLError("rbac: insert blocked by record rule", {
              extensions: { code: "FORBIDDEN" },
            });
          }
        }
        return inserted;
      });
    },
  };
}

/** `Mutation.update<TypeName>(set, where?)` — partial update, returns affected rows. */
function buildUpdateMutationField(
  meta: TableMeta,
  db: DrizzleLike,
  ctx: DomainContext,
  guard: Guard,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: listType(meta),
    args: {
      set: { type: new GraphQLNonNull(meta.updateInput) },
      where: { type: GraphQLJSON },
    },
    resolve: async (_, args, gqlCtx) => {
      const extra = guard ? await guard(gqlCtx, "update") : undefined;
      const userWhere = whereDomainToSql(args?.where, meta, ctx, gqlCtx);
      const combined = combineWhere(extra, userWhere);
      // `where` is a nullable arg — a missing user filter combined with no
      // RBAC restriction would otherwise emit an unbounded UPDATE.
      if (!combined) {
        throw new GraphQLError(
          "rbac: refusing UPDATE with empty WHERE — misconfiguration",
          { extensions: { code: "FORBIDDEN" } },
        );
      }
      return db.update(meta.table).set(args.set).where(combined).returning();
    },
  };
}

/** `Mutation.deleteFrom<TypeName>(where?)` — delete by predicate, returns deleted rows. */
function buildDeleteMutationField(
  meta: TableMeta,
  db: DrizzleLike,
  ctx: DomainContext,
  guard: Guard,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: listType(meta),
    args: { where: { type: GraphQLJSON } },
    resolve: async (_, args, gqlCtx) => {
      const extra = guard ? await guard(gqlCtx, "delete") : undefined;
      const userWhere = whereDomainToSql(args?.where, meta, ctx, gqlCtx);
      const combined = combineWhere(extra, userWhere);
      // Same defensive guard as update — refuse an unbounded DELETE.
      if (!combined) {
        throw new GraphQLError(
          "rbac: refusing DELETE with empty WHERE — misconfiguration",
          { extensions: { code: "FORBIDDEN" } },
        );
      }
      return db.delete(meta.table).where(combined).returning();
    },
  };
}
