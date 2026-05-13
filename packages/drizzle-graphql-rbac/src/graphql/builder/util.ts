/**
 * @module graphql/builder/util
 *
 * Small helpers shared by more than one builder module. Anything here should be
 * trivially testable in isolation and have no opinion about GraphQL or Drizzle
 * configuration beyond accepting their primitives.
 */
import type { Column, SQL } from "drizzle-orm";
import type {
  GraphQLResolveInfo,
  SelectionSetNode,
  FragmentDefinitionNode,
} from "graphql";
import {
  domainToSql,
  parseDomain,
  type DomainContext,
  type DomainPlaceholders,
} from "../domain/domain.js";
import type { DrizzleLike, TableMeta } from "./types.js";
import type { RbacContext } from "../rbac/rbac.js";
import { isPrimary } from "./drizzle-internals.js";
import { jsKeyOf } from "./jsKey.js";

export { jsKeyOf };

/**
 * Default placeholder map for resolver-supplied domains. Pulls
 * `current_user.id` off the GraphQL request context so callers can write
 * domain rules that mirror RBAC conventions.
 */
function placeholdersFor(gqlCtx: RbacContext | undefined | null): DomainPlaceholders {
  return { "current_user.id": gqlCtx?.user?.id ?? null };
}

/**
 * Walk a selection set (resolving fragment spreads + inline fragments) and
 * collect the underlying field names the client asked for. Aliases are
 * ignored — we want the source field name to map back to a column / relation.
 */
function collectRequestedFieldNames(
  selectionSet: SelectionSetNode,
  fragments: Record<string, FragmentDefinitionNode>,
  out: Set<string>,
): void {
  for (const sel of selectionSet.selections) {
    if (sel.kind === "Field") {
      const name = sel.name.value;
      if (!name.startsWith("__")) out.add(name);
    } else if (sel.kind === "InlineFragment") {
      if (sel.selectionSet) collectRequestedFieldNames(sel.selectionSet, fragments, out);
    } else if (sel.kind === "FragmentSpread") {
      const frag = fragments[sel.name.value];
      if (frag) collectRequestedFieldNames(frag.selectionSet, fragments, out);
    }
  }
}

/**
 * Derive a Drizzle `select()` projection from a GraphQL selection set on
 * `meta`'s object type, so the SQL only fetches columns the client actually
 * needs. Always retains:
 *  - primary-key columns (needed for dedup / dataloader bucketing / inverse
 *    relations that target the PK);
 *  - the local FK columns of any requested relation field (the relation
 *    resolver reads them off the parent row at traversal time).
 *
 * Returns `undefined` (caller falls back to selecting all columns) when no
 * usable selection set is available — e.g. when called from a context where
 * `info` was not threaded through.
 */
export function projectionForSelection(
  meta: TableMeta,
  info: GraphQLResolveInfo | undefined,
): Record<string, Column> | undefined {
  if (!info) return undefined;
  const requested = new Set<string>();
  for (const fn of info.fieldNodes) {
    if (fn.selectionSet) {
      collectRequestedFieldNames(fn.selectionSet, info.fragments ?? {}, requested);
    }
  }
  if (!requested.size) return undefined;

  const proj: Record<string, Column> = {};
  // Primary key columns are unconditionally projected.
  for (const [k, c] of Object.entries(meta.columns)) {
    if (isPrimary(c)) proj[k] = c;
  }

  const relByName = new Map(meta.relations.map((r) => [r.fieldName, r]));

  for (const f of requested) {
    const col = meta.columns[f];
    if (col) {
      proj[f] = col;
      continue;
    }
    const rel = relByName.get(f);
    if (rel?.fields?.length) {
      // Local-side columns the relation resolver will read off the parent row.
      // For "one" relations these are the FK columns; for "many" inverse
      // relations they're the local PK/unique columns (typically already in
      // the projection via the PK pass above).
      for (const lc of rel.fields) {
        const k = jsKeyOf(meta.columns, lc);
        if (k) proj[k] = lc;
      }
    }
  }
  return proj;
}

/** Build a Drizzle SELECT chain projecting only the columns implied by `info`. */
export function selectProjected(
  db: DrizzleLike,
  meta: TableMeta,
  info: GraphQLResolveInfo | undefined,
): any {
  const proj = projectionForSelection(meta, info);
  return proj ? db.select(proj).from(meta.table) : db.select().from(meta.table);
}

/**
 * Translate the JSON `where` arg on a list/single/update/delete/many-relation
 * resolver into a Drizzle SQL fragment, or `undefined` when no usable where
 * was supplied. Throws a `GraphQLError`-friendly `Error` on malformed domains.
 */
export function whereDomainToSql(
  rawWhere: unknown,
  meta: TableMeta,
  ctx: DomainContext,
  gqlCtx: unknown,
): SQL | undefined {
  if (rawWhere == null) return undefined;
  if (!Array.isArray(rawWhere)) {
    throw new Error("where must be a JSON Odoo-style domain array");
  }
  // GraphQL resolver context is typed `unknown` at the field config level; we
  // narrow here to the RBAC-shaped subset placeholdersFor reads.
  return domainToSql(
    parseDomain(rawWhere),
    meta.columns,
    placeholdersFor(gqlCtx as RbacContext | null | undefined),
    ctx,
  );
}
