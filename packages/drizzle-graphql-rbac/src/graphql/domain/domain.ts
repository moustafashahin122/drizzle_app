/**
 * @module graphql/domain
 *
 * Summary
 * -------
 * Odoo-style domain parser and Drizzle-SQL translator. A "domain" is a
 * polish-prefix array of leaves and operators that describes a row predicate
 * (e.g. `[["ownerId", "=", "current_user.id"]]`). This module turns that
 * data structure into a Drizzle `SQL` fragment that can be AND-ed into any
 * query's `where`.
 *
 * Used by the auto-CRUD GraphQL builder as the only `where` syntax it
 * accepts, and by the RBAC engine to evaluate record rules. The module
 * itself is authentication-agnostic: callers supply a placeholder map for
 * any string tokens they want substituted at evaluation time.
 *
 * Domain syntax
 * -------------
 * `[ "&" | "|" | "!", [field, op, value], ... ]` — operators are prefix and
 * consume the next 1 (`!`) or 2 (`&`, `|`) sub-expressions; the implicit
 * combinator across remaining top-level items is `&` (AND), matching Odoo.
 * Operators: `=`, `!=` (alias `<>`), `>`, `>=`, `<`, `<=`, `in`, `not in`,
 * `like`, `ilike`, `not like`, `not ilike`, `=?` (eq-or-null).
 *
 * Dotted relation paths
 * ---------------------
 * A leaf field may use dotted notation to traverse single-column relations:
 * `[["assigneeId.email", "ilike", "%@example.com"]]`. Each hop emits an
 * `IN (SELECT …)` subquery against the referenced table. Requires a
 * {@link DomainContext} so the translator can resolve the relation graph.
 * Without a context, dotted leaves are dropped (return `undefined`).
 *
 * Placeholders
 * ------------
 * Any string value present as a key in the {@link DomainPlaceholders} map is
 * substituted with the mapped value before the leaf is translated. Leaves
 * that compare a column to `null` via `=` / `!=` produce no SQL fragment —
 * combined with the OR-of-rules semantics this keeps "missing placeholder"
 * (resolved to `null`) from accidentally widening access.
 */
import {
  eq,
  gt,
  gte,
  ilike,
  inArray,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  and,
  getTableName,
  or,
  type Column,
  type SQL,
} from "drizzle-orm";
import type { ColumnMap } from "../builder/filters.js";
import type { ExtractedRelation } from "../builder/relations.js";

/** A single leaf predicate: `[field, op, value]`. */
export type DomainLeaf = [string, string, unknown];

/** Parsed domain tree node — the in-memory form of a domain. */
export type DomainNode =
  | { kind: "leaf"; field: string; op: string; value: unknown }
  | { kind: "and" | "or"; children: DomainNode[] }
  | { kind: "not"; child: DomainNode };

/**
 * Placeholder substitution map. Keys are exact string values that may appear
 * in a domain leaf's `value` slot; matching values are replaced with the
 * mapped value (typically a runtime-derived id). Arrays are walked
 * element-wise so `["in", ["current_user.id", 5]]` works as expected.
 *
 * Example: `{ "current_user.id": ctx.user?.id ?? null }`.
 */
export type DomainPlaceholders = Record<string, unknown>;

/**
 * Per-table info {@link domainToSql} needs to translate dotted-field leaves
 * into `IN (SELECT …)` subqueries. Looked up by SQL table name.
 */
export interface DomainTableInfo {
  table: unknown;
  columns: ColumnMap;
  relations: ExtractedRelation[];
}

/**
 * Context that lets {@link domainToSql} resolve dotted-field relation
 * traversals into subqueries. When absent, only direct column leaves work —
 * dotted fields are silently dropped (translator returns `undefined`).
 */
export interface DomainContext {
  /** Drizzle DB handle — only `select(...)` is used (to build subqueries). */
  db: { select: (...args: any[]) => any };
  /** Relations declared on the table that owns the current domain. */
  relations: ExtractedRelation[];
  /** Resolve a referenced table's info by its SQL table name. */
  lookup: (refSqlName: string) => DomainTableInfo | undefined;
}

/**
 * Parse a JSON-decoded Odoo domain (an array of leaves and prefix operators)
 * into a tree. Implicit AND across remaining top-level items.
 *
 * @throws if the domain is malformed (unknown operator, leaf shape wrong, or
 *         operators consume past the end of the token list).
 */
export function parseDomain(domain: unknown[]): DomainNode {
  let i = 0;

  const parseOne = (): DomainNode => {
    if (i >= domain.length) throw new Error("domain: truncated mid-operator");
    const tok = domain[i++];
    if (tok === "&" || tok === "|") {
      const a = parseOne();
      const b = parseOne();
      return { kind: tok === "&" ? "and" : "or", children: [a, b] };
    }
    if (tok === "!") {
      const a = parseOne();
      return { kind: "not", child: a };
    }
    if (Array.isArray(tok) && tok.length === 3) {
      const [field, op, value] = tok as DomainLeaf;
      if (typeof field !== "string" || typeof op !== "string") {
        throw new Error(`domain: malformed leaf ${JSON.stringify(tok)}`);
      }
      return { kind: "leaf", field, op, value };
    }
    throw new Error(`domain: unrecognized token ${JSON.stringify(tok)}`);
  };

  const top: DomainNode[] = [];
  while (i < domain.length) top.push(parseOne());
  if (top.length === 0) throw new Error("domain: empty");
  if (top.length === 1) return top[0];
  return { kind: "and", children: top };
}

const substitute = (value: unknown, placeholders: DomainPlaceholders): unknown => {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(placeholders, value)) {
    return placeholders[value];
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, placeholders));
  return value;
};

/**
 * Translate a parsed domain tree into a Drizzle SQL fragment against `columns`.
 *
 * Returns `undefined` for a tree that contributes no usable predicates — e.g.
 * a leaf referencing an unknown column, an `=` against a null-resolved
 * placeholder, or a dotted-field leaf when no {@link DomainContext} is
 * supplied. The caller treats `undefined` as "this rule grants nothing",
 * which combined with the OR-of-rules semantics means a malformed or
 * null-bound rule does *not* widen access.
 *
 * @param node Parsed domain tree from {@link parseDomain}.
 * @param columns Map of field name → Drizzle column for the table being filtered.
 * @param placeholders Substitution map (e.g. `{ "current_user.id": userId }`).
 * @param ctx Optional context enabling dotted-field relation traversal.
 *
 * @example
 * const node = parseDomain([["ownerId", "=", "current_user.id"]]);
 * const sql = domainToSql(node, todoColumns, { "current_user.id": 42 });
 * // → eq(todos.ownerId, 42)
 *
 * @example
 * // With ctx — filter todos by their assignee's email:
 * const node = parseDomain([["assigneeId.email", "ilike", "%@x.com"]]);
 * const sql = domainToSql(node, todoColumns, {}, ctx);
 * // → todos.assignee_id IN (SELECT assignees.id FROM assignees WHERE email ILIKE …)
 */
export function domainToSql(
  node: DomainNode,
  columns: ColumnMap,
  placeholders: DomainPlaceholders,
  ctx?: DomainContext,
): SQL | undefined {
  if (node.kind === "and" || node.kind === "or") {
    const parts = node.children
      .map((c) => domainToSql(c, columns, placeholders, ctx))
      .filter((p): p is SQL => !!p);
    if (!parts.length) return undefined;
    if (parts.length === 1) return parts[0];
    return node.kind === "and" ? and(...parts) : or(...parts);
  }
  if (node.kind === "not") {
    const inner = domainToSql(node.child, columns, placeholders, ctx);
    return inner ? not(inner) : undefined;
  }
  if (node.kind !== "leaf") return undefined;

  const value = substitute(node.value, placeholders);
  const path = node.field.split(".");
  if (path.length > 1) return dottedLeafToSql(path, node.op, value, columns, ctx);
  return leafToSql(columns[node.field], node.op, value);
}

/**
 * Translate a single dotted-path leaf into a chain of `IN (SELECT …)`
 * subqueries. Each non-final segment must name a single-column relation on
 * the current table; the final segment must name a column on the deepest
 * referenced table.
 */
function dottedLeafToSql(
  path: string[],
  op: string,
  value: unknown,
  columns: ColumnMap,
  ctx: DomainContext | undefined,
): SQL | undefined {
  if (!ctx) return undefined;
  const [head, ...rest] = path;
  const rel = ctx.relations.find(
    (r) => r.fieldName === head && r.fields?.length === 1 && r.references?.length === 1,
  );
  if (!rel) return undefined;
  const refInfo = ctx.lookup(getTableName(rel.referencedTable));
  if (!refInfo) return undefined;

  const innerSql = rest.length > 1
    ? dottedLeafToSql(rest, op, value, refInfo.columns, {
        db: ctx.db,
        relations: refInfo.relations,
        lookup: ctx.lookup,
      })
    : leafToSql(refInfo.columns[rest[0]], op, value);
  if (!innerSql) return undefined;

  const localCol = rel.fields![0];
  const remoteCol = rel.references![0];
  const sub = ctx.db.select({ __ref: remoteCol }).from(refInfo.table).where(innerSql);
  return inArray(localCol, sub);
}

/** Translate a single (column, op, value) tuple into a Drizzle SQL fragment. */
function leafToSql(col: Column | undefined, op: string, value: unknown): SQL | undefined {
  if (!col) return undefined;
  switch (op) {
    case "=":
      return value === null ? undefined : eq(col, value as any);
    case "!=":
    case "<>":
      return value === null ? undefined : ne(col, value as any);
    case ">":
      return gt(col, value as any);
    case ">=":
      return gte(col, value as any);
    case "<":
      return lt(col, value as any);
    case "<=":
      return lte(col, value as any);
    case "in":
      return Array.isArray(value) && value.length ? inArray(col, value as any[]) : undefined;
    case "not in":
      return Array.isArray(value) && value.length ? notInArray(col, value as any[]) : undefined;
    case "like":
      return like(col, value as any);
    case "ilike":
      return ilike(col, value as any);
    case "not like":
      return not(like(col, value as any));
    case "not ilike":
      return not(ilike(col, value as any));
    case "=?":
      // Odoo "equal or null": when the placeholder resolves to null, drop the
      // predicate rather than emitting `col = NULL`.
      return value === null ? undefined : eq(col, value as any);
    default:
      throw new Error(`domain: unsupported operator '${op}'`);
  }
}
