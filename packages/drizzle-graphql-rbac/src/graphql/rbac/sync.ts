/**
 * @module graphql/rbac/sync
 *
 * Reconcile the DB-side RBAC tables (`roles`, `access_rights`, `record_rules`)
 * with the in-code RBAC config. The code is the source of truth; each entry
 * declared in code carries an `xid` that anchors its identity in the DB.
 *
 * The sync runs in three phases, in order:
 *
 * 1. **Roles** — load existing rows; rows whose xid is no longer in code get
 *    cascade-deleted (their `userRoles`, `accessRights` and `recordRules`
 *    rows go with them). Then upsert each code-defined role by xid.
 * 2. **Access rights** — same pattern: delete by missing xid, upsert by xid.
 *    Updates compare role/resource/CRUD booleans; rewrite if any differ.
 * 3. **Record rules** — same pattern: delete by missing xid, upsert by xid.
 *    Domain is JSON-encoded; updates compare role/resource/action/domain.
 *
 * All work runs against the raw Drizzle handle (no RBAC enforcement). Designed
 * to be fired off after the server starts listening (`queueMicrotask`); the
 * returned promise resolves when the DB and the engine snapshot are in sync.
 */
import { and, eq, inArray } from "drizzle-orm";
import type {
  roles as rolesTable,
  accessRights as accessRightsTable,
  recordRules as recordRulesTable,
  userRoles as userRolesTable,
} from "../../tables.js";
import type {
  ResolvedRbacConfig,
  ResolvedRole,
  ResolvedAccessRight,
  ResolvedRecordRule,
} from "./config.js";

export interface SyncSchema {
  roles: typeof rolesTable;
  accessRights: typeof accessRightsTable;
  recordRules: typeof recordRulesTable;
  userRoles: typeof userRolesTable;
}

export interface SyncDb {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
}

export interface SyncResult {
  rolesDeleted: number;
  rolesInserted: number;
  rolesUpdated: number;
  accessRightsDeleted: number;
  accessRightsInserted: number;
  accessRightsUpdated: number;
  recordRulesDeleted: number;
  recordRulesInserted: number;
  recordRulesUpdated: number;
}

/**
 * Reconcile the DB to match `config`. Idempotent: a second call with the same
 * config is a no-op (returns all-zeros).
 */
export async function syncRbacFromCode(
  db: SyncDb,
  schema: SyncSchema,
  config: ResolvedRbacConfig,
): Promise<SyncResult> {
  const result: SyncResult = {
    rolesDeleted: 0,
    rolesInserted: 0,
    rolesUpdated: 0,
    accessRightsDeleted: 0,
    accessRightsInserted: 0,
    accessRightsUpdated: 0,
    recordRulesDeleted: 0,
    recordRulesInserted: 0,
    recordRulesUpdated: 0,
  };

  // ---- Phase 1: Roles ------------------------------------------------------

  const codeRolesByXid = new Map<string, ResolvedRole>();
  for (const r of config.roles) codeRolesByXid.set(r.xid, r);

  const dbRoles: { id: number; xid: string; key: string; isAdmin: boolean }[] =
    await db.select().from(schema.roles);
  const dbRolesByXid = new Map<string, (typeof dbRoles)[number]>();
  for (const r of dbRoles) dbRolesByXid.set(r.xid, r);

  // Cascade-delete roles whose xid is no longer in code.
  const orphanIds: number[] = [];
  for (const r of dbRoles) {
    if (!codeRolesByXid.has(r.xid)) orphanIds.push(r.id);
  }
  if (orphanIds.length) {
    await db.delete(schema.userRoles).where(inArray(schema.userRoles.roleId, orphanIds));
    await db
      .delete(schema.accessRights)
      .where(inArray(schema.accessRights.roleId, orphanIds));
    await db
      .delete(schema.recordRules)
      .where(inArray(schema.recordRules.roleId, orphanIds));
    await db.delete(schema.roles).where(inArray(schema.roles.id, orphanIds));
    result.rolesDeleted = orphanIds.length;
    for (const id of orphanIds) {
      // remove from local map so we don't try to update them
      for (const [xid, row] of dbRolesByXid) {
        if (row.id === id) dbRolesByXid.delete(xid);
      }
    }
  }

  // Upsert by xid.
  for (const r of config.roles) {
    const existing = dbRolesByXid.get(r.xid);
    if (!existing) {
      await db
        .insert(schema.roles)
        .values({ xid: r.xid, key: r.key, isAdmin: r.isAdmin });
      result.rolesInserted++;
    } else if (existing.key !== r.key || existing.isAdmin !== r.isAdmin) {
      await db
        .update(schema.roles)
        .set({ key: r.key, isAdmin: r.isAdmin })
        .where(eq(schema.roles.id, existing.id));
      result.rolesUpdated++;
    }
  }

  // Refresh the role-id lookup with any newly inserted rows.
  const finalRoles: { id: number; xid: string; key: string }[] = await db
    .select({ id: schema.roles.id, xid: schema.roles.xid, key: schema.roles.key })
    .from(schema.roles);
  const roleIdByXid = new Map<string, number>();
  const roleIdByKey = new Map<string, number>();
  for (const r of finalRoles) {
    roleIdByXid.set(r.xid, r.id);
    roleIdByKey.set(r.key, r.id);
  }

  // ---- Phase 2: Access rights ---------------------------------------------

  const codeArByXid = new Map<string, ResolvedAccessRight>();
  for (const a of config.accessRights) codeArByXid.set(a.xid, a);

  const dbAr: {
    id: number;
    xid: string;
    roleId: number;
    resource: string;
    canCreate: boolean;
    canRead: boolean;
    canUpdate: boolean;
    canDelete: boolean;
  }[] = await db.select().from(schema.accessRights);
  const dbArByXid = new Map<string, (typeof dbAr)[number]>();
  for (const a of dbAr) dbArByXid.set(a.xid, a);

  const orphanArIds: number[] = [];
  for (const a of dbAr) if (!codeArByXid.has(a.xid)) orphanArIds.push(a.id);
  if (orphanArIds.length) {
    await db.delete(schema.accessRights).where(inArray(schema.accessRights.id, orphanArIds));
    result.accessRightsDeleted = orphanArIds.length;
  }

  for (const a of config.accessRights) {
    const roleId = roleIdByKey.get(a.roleKey);
    if (roleId === undefined) {
      throw new Error(`rbac sync: accessRight '${a.xid}' refs unknown role '${a.roleKey}'`);
    }
    const existing = dbArByXid.get(a.xid);
    if (!existing) {
      await db.insert(schema.accessRights).values({
        xid: a.xid,
        roleId,
        resource: a.resource,
        canCreate: a.canCreate,
        canRead: a.canRead,
        canUpdate: a.canUpdate,
        canDelete: a.canDelete,
      });
      result.accessRightsInserted++;
    } else if (
      existing.roleId !== roleId ||
      existing.resource !== a.resource ||
      existing.canCreate !== a.canCreate ||
      existing.canRead !== a.canRead ||
      existing.canUpdate !== a.canUpdate ||
      existing.canDelete !== a.canDelete
    ) {
      await db
        .update(schema.accessRights)
        .set({
          roleId,
          resource: a.resource,
          canCreate: a.canCreate,
          canRead: a.canRead,
          canUpdate: a.canUpdate,
          canDelete: a.canDelete,
        })
        .where(eq(schema.accessRights.id, existing.id));
      result.accessRightsUpdated++;
    }
  }

  // ---- Phase 3: Record rules ----------------------------------------------

  const codeRrByXid = new Map<string, ResolvedRecordRule>();
  for (const r of config.recordRules) codeRrByXid.set(r.xid, r);

  const dbRr: {
    id: number;
    xid: string;
    roleId: number;
    resource: string;
    action: string;
    domain: string;
  }[] = await db.select().from(schema.recordRules);
  const dbRrByXid = new Map<string, (typeof dbRr)[number]>();
  for (const r of dbRr) dbRrByXid.set(r.xid, r);

  const orphanRrIds: number[] = [];
  for (const r of dbRr) if (!codeRrByXid.has(r.xid)) orphanRrIds.push(r.id);
  if (orphanRrIds.length) {
    await db.delete(schema.recordRules).where(inArray(schema.recordRules.id, orphanRrIds));
    result.recordRulesDeleted = orphanRrIds.length;
  }

  for (const r of config.recordRules) {
    const roleId = roleIdByKey.get(r.roleKey);
    if (roleId === undefined) {
      throw new Error(`rbac sync: recordRule '${r.xid}' refs unknown role '${r.roleKey}'`);
    }
    const domainJson = JSON.stringify(r.domain);
    const existing = dbRrByXid.get(r.xid);
    if (!existing) {
      await db.insert(schema.recordRules).values({
        xid: r.xid,
        roleId,
        resource: r.resource,
        action: r.action,
        domain: domainJson,
      });
      result.recordRulesInserted++;
    } else if (
      existing.roleId !== roleId ||
      existing.resource !== r.resource ||
      existing.action !== r.action ||
      existing.domain !== domainJson
    ) {
      await db
        .update(schema.recordRules)
        .set({
          roleId,
          resource: r.resource,
          action: r.action,
          domain: domainJson,
        })
        .where(eq(schema.recordRules.id, existing.id));
      result.recordRulesUpdated++;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Engine snapshot
// ---------------------------------------------------------------------------

/**
 * In-memory snapshot the engine consults at runtime. Built by reading the
 * DB *after* a sync has reconciled the rows. Any cache the engine maintains
 * should be cleared when the snapshot is replaced.
 */
export interface RbacSnapshot {
  /** roleId -> { key, isAdmin } */
  rolesById: Map<number, { key: string; isAdmin: boolean }>;
  /** roleId -> resource -> set of granted actions */
  accessByRole: Map<number, Map<string, Set<string>>>;
  /** roleId -> resource -> action -> Domain */
  rulesByRole: Map<number, Map<string, Map<string, unknown[]>>>;
}

/**
 * Read the DB tables and build the runtime snapshot. Cheap to call (one query
 * per table); the engine refreshes its cached snapshot via this on demand.
 */
export async function loadRbacSnapshot(
  db: SyncDb,
  schema: SyncSchema,
): Promise<RbacSnapshot> {
  const rolesById = new Map<number, { key: string; isAdmin: boolean }>();
  const dbRoles: { id: number; key: string; isAdmin: boolean }[] = await db
    .select({ id: schema.roles.id, key: schema.roles.key, isAdmin: schema.roles.isAdmin })
    .from(schema.roles);
  for (const r of dbRoles) rolesById.set(r.id, { key: r.key, isAdmin: r.isAdmin });

  const accessByRole = new Map<number, Map<string, Set<string>>>();
  const dbAr: {
    roleId: number;
    resource: string;
    canCreate: boolean;
    canRead: boolean;
    canUpdate: boolean;
    canDelete: boolean;
  }[] = await db.select().from(schema.accessRights);
  for (const a of dbAr) {
    let perResource = accessByRole.get(a.roleId);
    if (!perResource) accessByRole.set(a.roleId, (perResource = new Map()));
    let actions = perResource.get(a.resource);
    if (!actions) perResource.set(a.resource, (actions = new Set()));
    if (a.canCreate) actions.add("create");
    if (a.canRead) actions.add("read");
    if (a.canUpdate) actions.add("update");
    if (a.canDelete) actions.add("delete");
  }

  const rulesByRole = new Map<number, Map<string, Map<string, unknown[]>>>();
  const dbRr: { roleId: number; resource: string; action: string; domain: string }[] =
    await db.select().from(schema.recordRules);
  for (const r of dbRr) {
    let perResource = rulesByRole.get(r.roleId);
    if (!perResource) rulesByRole.set(r.roleId, (perResource = new Map()));
    let perAction = perResource.get(r.resource);
    if (!perAction) perResource.set(r.resource, (perAction = new Map()));
    perAction.set(r.action, JSON.parse(r.domain) as unknown[]);
  }

  return { rolesById, accessByRole, rulesByRole };
}

/** Convenience: sync then return a fresh snapshot. */
export async function syncAndSnapshot(
  db: SyncDb,
  schema: SyncSchema,
  config: ResolvedRbacConfig,
): Promise<{ result: SyncResult; snapshot: RbacSnapshot }> {
  const result = await syncRbacFromCode(db, schema, config);
  const snapshot = await loadRbacSnapshot(db, schema);
  return { result, snapshot };
}

/** An empty snapshot — used as the engine's pre-sync default (deny-all). */
export function emptySnapshot(): RbacSnapshot {
  return {
    rolesById: new Map(),
    accessByRole: new Map(),
    rulesByRole: new Map(),
  };
}
