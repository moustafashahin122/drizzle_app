/**
 * @module graphql/builder/builder-resolvers
 *
 * Summary
 * -------
 * Pass 2 of {@link buildSchema}: wires per-table root fields onto the Query
 * and Mutation maps and implements the CRUD resolvers (RBAC ACL enforcement,
 * read/update/delete record-rule narrowing, JSON domain → SQL translation,
 * projected SELECTs, `.returning()` on mutations, and empty-WHERE guards on
 * update/delete).
 *
 * Note: row-level record rules currently apply to read/update/delete only.
 * Insert-time row filtering (record rule on `create`) is not modeled — the
 * ACL check still fires on insert, but no post-insert row verification runs.
 */
import {
  GraphQLError,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
} from "graphql";
import { applyListArgs, combineWhere } from "./filters.js";
import type { DomainContext } from "../domain/domain.js";
import { GraphQLJSON } from "./scalars.js";
import type { BuildSchemaOptions } from "./builder.js";
import type { DrizzleLike, Guard, TableMeta } from "./types.js";
import { selectProjected, whereDomainToSql } from "./util.js";
import type { RbacContext } from "../rbac/rbac.js";

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
  maxListLimit: number,
) {
  // Resolve once: a function that returns the rbac extra-where for a given
  // request context, or undefined when rbac is disabled / bypassed for this
  // resource.
  const bypass = rbac?.bypassResources?.has(meta.jsKey);
  const guard: Guard = rbac && !bypass
    ? async (gqlCtx: RbacContext, action: "create" | "read" | "update" | "delete") =>
        (await rbac.enforce(gqlCtx, meta.jsKey, action, meta.columns)).where
    : null;

  queryFields[meta.jsKey] = buildListQueryField(meta, db, ctx, guard, maxListLimit);
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
  maxListLimit: number,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: listType(meta),
    args: listArgsConfig(meta),
    resolve: async (_, args, gqlCtx, info) => {
      const extra = guard ? await guard(gqlCtx, "read") : undefined;
      const userWhere = whereDomainToSql(args?.where, meta, ctx, gqlCtx);
      const where = combineWhere(extra, userWhere);
      // Clamp the caller's limit to the configured cap to defend against
      // unbounded data dumps. Copy args; don't mutate the incoming object.
      const effectiveLimit = Math.min(args?.limit ?? maxListLimit, maxListLimit);
      const clampedArgs = { ...args, limit: effectiveLimit };
      return applyListArgs(selectProjected(db, meta, info), clampedArgs, meta.columns, where);
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
      // ACL check only — throws FORBIDDEN if the actor lacks `create` on this
      // resource. Record rules on `create` are not currently modeled, so the
      // returned `where` (if any) is ignored.
      if (guard) await guard(gqlCtx, "create");
      return db.insert(meta.table).values(args.values).returning();
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
