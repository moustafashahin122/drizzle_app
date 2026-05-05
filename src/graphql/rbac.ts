/**
 * @module graphql/rbac
 *
 * Odoo-style RBAC engine. Three concepts:
 *
 * - **Groups** (roles), with optional `parentGroupId` inheritance. Membership is
 *   transitive: being in a child group implies being in every ancestor group.
 *   A group flagged `isAdmin` short-circuits all checks for its members.
 * - **Access rights**: per-group CRUD booleans on a resource (the table's JS
 *   schema key, e.g. `"todos"`). Union across the user's effective groups.
 *   Deny-by-default if no group grants the action.
 * - **Record rules**: per-group row-level filters on a `(resource, permType)`
 *   pair, expressed as Odoo polish-prefix domains. Domains from groups granting
 *   the action are OR-combined and AND-ed into the resolver's `where`.
 *
 * Domain syntax
 * -------------
 * `[ "&" | "|" | "!", [field, op, value], ... ]` — operators are prefix and
 * consume the next 1 (`!`) or 2 (`&`, `|`) sub-expressions; the implicit
 * combinator across remaining top-level items is `&` (AND), matching Odoo.
 * Operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `not in`, `like`, `ilike`,
 * `not like`, `not ilike`, `=?` (eq-or-null).
 *
 * Placeholders: any string value equal to `current_user.id` is substituted with
 * the runtime user id. Unauthenticated callers get `null`, which makes
 * `=`/`!=` against it produce no row matches — the safe default.
 */
import {
  and,
  eq,
  getTableName,
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
  or,
  type Column,
  type SQL,
} from "drizzle-orm";
import { GraphQLError } from "graphql";
import type {
  groups as groupsTable,
  userGroups as userGroupsTable,
  accessRights as accessRightsTable,
  recordRules as recordRulesTable,
  User,
} from "../db.js";
import type { ColumnMap } from "./filters.js";

export interface RbacSchema {
  groups: typeof groupsTable;
  userGroups: typeof userGroupsTable;
  accessRights: typeof accessRightsTable;
  recordRules: typeof recordRulesTable;
}

export interface RbacDb {
  select: (...args: any[]) => any;
}

export type Action = "create" | "read" | "update" | "delete";

export interface RbacContext {
  user: User | null;
  /** Per-request cache shared with the relation loader. */
  batch?: Map<string, unknown>;
}

const forbidden = (msg: string) =>
  new GraphQLError(msg, { extensions: { code: "FORBIDDEN" } });

const ACTION_TO_PERM: Record<Action, "canCreate" | "canRead" | "canUpdate" | "canDelete"> = {
  create: "canCreate",
  read: "canRead",
  update: "canUpdate",
  delete: "canDelete",
};

interface CachedGroups {
  ids: number[];
  isAdmin: boolean;
}

/**
 * Resolve the user's effective group set: direct memberships plus every
 * ancestor reachable through `parentGroupId`. BFS with a visited set so a
 * cycle (parent_group_id pointing back at a descendant) terminates instead of
 * looping forever — the PRD calls this out as a required mitigation.
 */
async function resolveEffectiveGroups(
  db: RbacDb,
  schema: RbacSchema,
  userId: number,
): Promise<CachedGroups> {
  const direct: { groupId: number }[] = await db
    .select({ groupId: schema.userGroups.groupId })
    .from(schema.userGroups)
    .where(eq(schema.userGroups.userId, userId));
  if (!direct.length) return { ids: [], isAdmin: false };

  const visited = new Set<number>();
  let frontier = direct.map((r) => r.groupId);
  let isAdmin = false;
  while (frontier.length) {
    const fresh = frontier.filter((id) => !visited.has(id));
    for (const id of fresh) visited.add(id);
    if (!fresh.length) break;
    const rows: { id: number; parentGroupId: number | null; isAdmin: boolean }[] = await db
      .select({
        id: schema.groups.id,
        parentGroupId: schema.groups.parentGroupId,
        isAdmin: schema.groups.isAdmin,
      })
      .from(schema.groups)
      .where(inArray(schema.groups.id, fresh));
    if (rows.some((r) => r.isAdmin)) isAdmin = true;
    frontier = rows
      .map((r) => r.parentGroupId)
      .filter((id): id is number => id != null);
  }
  return { ids: Array.from(visited), isAdmin };
}

async function getEffectiveGroups(
  db: RbacDb,
  schema: RbacSchema,
  ctx: RbacContext,
): Promise<CachedGroups> {
  if (!ctx.user) return { ids: [], isAdmin: false };
  const cacheKey = `__rbac_groups:${ctx.user.id}`;
  const cached = ctx.batch?.get(cacheKey) as CachedGroups | undefined;
  if (cached) return cached;
  const out = await resolveEffectiveGroups(db, schema, ctx.user.id);
  ctx.batch?.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// Odoo domain parser
// ---------------------------------------------------------------------------

type Leaf = [string, string, unknown];
type DomainNode =
  | { kind: "leaf"; field: string; op: string; value: unknown }
  | { kind: "and" | "or"; children: DomainNode[] }
  | { kind: "not"; child: DomainNode };

/**
 * Parse a JSON-encoded Odoo domain (an array of leaves and prefix operators)
 * into a tree. Implicit AND across remaining top-level items.
 *
 * @throws if the domain is malformed (unknown operator, leaf shape wrong, or
 *         operators consume past the end of the token list).
 */
export function parseDomain(domain: unknown[]): DomainNode {
  let i = 0;

  const parseOne = (): DomainNode => {
    if (i >= domain.length) throw new Error("rbac: domain truncated mid-operator");
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
      const [field, op, value] = tok as Leaf;
      if (typeof field !== "string" || typeof op !== "string") {
        throw new Error(`rbac: malformed leaf ${JSON.stringify(tok)}`);
      }
      return { kind: "leaf", field, op, value };
    }
    throw new Error(`rbac: unrecognized domain token ${JSON.stringify(tok)}`);
  };

  const top: DomainNode[] = [];
  while (i < domain.length) top.push(parseOne());
  if (top.length === 0) throw new Error("rbac: empty domain");
  if (top.length === 1) return top[0];
  return { kind: "and", children: top };
}

const substitute = (value: unknown, user: User | null): unknown => {
  if (value === "current_user.id") return user?.id ?? null;
  if (Array.isArray(value)) return value.map((v) => substitute(v, user));
  return value;
};

/**
 * Translate a parsed domain tree into a Drizzle SQL fragment against `columns`.
 *
 * Returns `undefined` for a tree that contributes no usable predicates — e.g.
 * a leaf referencing an unknown column. The caller treats `undefined` as "this
 * rule grants nothing", which combined with the OR-of-rules semantics means a
 * malformed rule does *not* widen access.
 */
export function domainToSql(
  node: DomainNode,
  columns: ColumnMap,
  user: User | null,
): SQL | undefined {
  if (node.kind === "and" || node.kind === "or") {
    const parts = node.children
      .map((c) => domainToSql(c, columns, user))
      .filter((p): p is SQL => !!p);
    if (!parts.length) return undefined;
    if (parts.length === 1) return parts[0];
    return node.kind === "and" ? and(...parts) : or(...parts);
  }
  if (node.kind === "not") {
    const inner = domainToSql(node.child, columns, user);
    return inner ? not(inner) : undefined;
  }
  if (node.kind !== "leaf") return undefined;

  const col = columns[node.field] as Column | undefined;
  if (!col) return undefined;
  const value = substitute(node.value, user);

  switch (node.op) {
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
      // Odoo: "equal or null" — useful when the placeholder may resolve to null.
      return value === null ? undefined : eq(col, value as any);
    default:
      throw new Error(`rbac: unsupported domain operator '${node.op}'`);
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Hook passed to {@link buildSchema} as `options.rbac.enforce`. Throws
 * `FORBIDDEN` if the action is denied; otherwise returns an optional SQL
 * fragment to AND into the resolver's where (the union of matching record
 * rules' domains).
 *
 * Admins bypass entirely — they get `{ where: undefined }` and never throw.
 */
export interface RbacEnforce {
  (
    ctx: RbacContext,
    resource: string,
    action: Action,
    columns: ColumnMap,
  ): Promise<{ where?: SQL }>;
}

export function buildRbac(db: RbacDb, schema: RbacSchema): { enforce: RbacEnforce } {
  const enforce: RbacEnforce = async (ctx, resource, action, columns) => {
    if (!ctx.user) throw forbidden("Not authenticated");

    const { ids, isAdmin } = await getEffectiveGroups(db, schema, ctx);
    if (isAdmin) return {};
    if (!ids.length) throw forbidden(`Access denied on '${resource}'`);

    const permCol = ACTION_TO_PERM[action];
    const granting: { groupId: number }[] = await db
      .select({ groupId: schema.accessRights.groupId })
      .from(schema.accessRights)
      .where(
        and(
          eq(schema.accessRights.resource, resource),
          inArray(schema.accessRights.groupId, ids),
          eq(schema.accessRights[permCol], true),
        ),
      );
    if (!granting.length) {
      throw forbidden(`Access denied on '${resource}' for '${action}'`);
    }

    // Record rules: only those owned by groups that *also* grant the action
    // contribute. A group with read=true and no rule grants unrestricted read;
    // a group with read=true and a rule grants read filtered by that rule.
    // Effective filter is the OR of those per-group filters.
    const grantingIds = granting.map((g) => g.groupId);
    const rules: { groupId: number; domain: string }[] = await db
      .select({
        groupId: schema.recordRules.groupId,
        domain: schema.recordRules.domain,
      })
      .from(schema.recordRules)
      .where(
        and(
          eq(schema.recordRules.resource, resource),
          eq(schema.recordRules.permType, action),
          inArray(schema.recordRules.groupId, grantingIds),
        ),
      );
    if (!rules.length) return {};

    const rulesByGroup = new Map<number, SQL[]>();
    for (const r of rules) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.domain);
      } catch {
        throw new Error(`rbac: invalid JSON in record_rules.id (group ${r.groupId})`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`rbac: record rule domain must be a JSON array`);
      }
      const sql = domainToSql(parseDomain(parsed), columns, ctx.user);
      if (!sql) continue;
      let arr = rulesByGroup.get(r.groupId);
      if (!arr) rulesByGroup.set(r.groupId, (arr = []));
      arr.push(sql);
    }

    // A group with rules: AND its rules together (rules are *additional*
    // restrictions on that group's grant). Across groups: OR — being in any
    // qualifying group is enough.
    const groupsWithRules = new Set(rulesByGroup.keys());
    const groupsWithoutRules = grantingIds.filter((id) => !groupsWithRules.has(id));

    // If any granting group has no rule, that group grants unrestricted access
    // → no row filter needed.
    if (groupsWithoutRules.length) return {};

    const perGroup: SQL[] = [];
    for (const arr of rulesByGroup.values()) {
      perGroup.push(arr.length === 1 ? arr[0] : and(...arr)!);
    }
    if (!perGroup.length) return {};
    const combined = perGroup.length === 1 ? perGroup[0] : or(...perGroup)!;
    return { where: combined };
  };

  return { enforce };
}
