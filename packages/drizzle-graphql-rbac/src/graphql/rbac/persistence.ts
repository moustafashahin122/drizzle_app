/**
 * @module graphql/rbac/persistence
 *
 * DB-backed role state: the `roles` table is the persisted projection of the
 * in-code role config, and `users.role_id` is each user's single role.
 *
 * On startup, {@link syncRoles} reconciles DB rows with the code config:
 *
 *   1. Code roles missing from the DB → INSERT.
 *   2. DB roles missing from the code config → users referencing them get
 *      `role_id = NULL` (defense in depth — the FK is `ON DELETE SET NULL`
 *      already, but doing the UPDATE explicitly avoids relying on dialect
 *      behaviour for cascading), then the orphan role rows are deleted.
 *   3. Surviving DB rows → `is_admin` is overwritten with the code value
 *      (the user explicitly asked for "invalidation" of this flag on each
 *      startup — DB drift gets stomped).
 *
 * After sync, RBAC reads `users.role_id` to learn a user's role. The lookup
 * is one indexed FK join (`users` JOIN `roles`) and is done once per request
 * by `sessionMiddleware`, not per RBAC check.
 */
import { eq, inArray } from "drizzle-orm";
import type { Role, roles as rolesTable, users as usersTable } from "../../tables.js";
import type { SudoDb } from "../../auth/session.js";
import type { ResolvedRole } from "./config.js";

/**
 * Structural shape — typed against the framework's own `users` / `roles`
 * tables in `../../tables.js`. Host apps should re-export those tables
 * (or spread `frameworkTables`) rather than declaring their own.
 */
export interface RolePersistenceSchema {
  roles: typeof rolesTable;
  users: typeof usersTable;
}

/**
 * Reconcile DB role rows with the code-defined role config. Idempotent —
 * safe to call on every server start. Returns the post-sync row set.
 */
export async function syncRoles(
  db: SudoDb,
  schema: RolePersistenceSchema,
  codeRoles: ReadonlyArray<ResolvedRole>,
): Promise<Role[]> {
  const { roles, users } = schema;
  const codeByName = new Map(codeRoles.map((r) => [r.key, r]));

  const existing: Role[] = await db.select().from(roles);
  const existingByName = new Map(existing.map((r) => [r.name, r]));

  const orphanIds = existing
    .filter((r) => !codeByName.has(r.name))
    .map((r) => r.id);
  const toInsert = codeRoles.filter((r) => !existingByName.has(r.key));
  const toUpdate = codeRoles.flatMap((r) => {
    const dbRow = existingByName.get(r.key);
    if (!dbRow) return [];
    if (dbRow.isAdmin === r.isAdmin) return [];
    return [{ id: dbRow.id, isAdmin: r.isAdmin }];
  });

  // Run all reconciliation writes (unhook, delete, insert, update) in a single
  // transaction so partial failures don't leave the table in a state where
  // users point at deleted roles or `is_admin` is half-converged. The callback
  // is intentionally synchronous and uses explicit `.run()`: better-sqlite3's
  // `db.transaction` rejects Promise-returning callbacks, and on async
  // dialects this entire reconciliation runs once at startup so atomicity via
  // a sync code path is sufficient.
  const tx = db as SudoDb & {
    transaction: (cb: (tx: SudoDb) => void) => void;
  };
  tx.transaction((trx) => {
    // (1) Orphans — unhook referencing users first (defense in depth — the
    // FK's ON DELETE SET NULL would handle it, but doing it explicitly keeps
    // behaviour identical across dialects), then delete the role rows.
    if (orphanIds.length) {
      trx
        .update(users)
        .set({ roleId: null })
        .where(inArray(users.roleId, orphanIds))
        .run();
      trx.delete(roles).where(inArray(roles.id, orphanIds)).run();
    }

    // (2) Insert rows for code-declared roles missing from DB.
    if (toInsert.length) {
      trx
        .insert(roles)
        .values(toInsert.map((r) => ({ name: r.key, isAdmin: r.isAdmin })))
        .run();
    }

    // (3) Invalidate `is_admin` on survivors — code config wins. Only write
    // rows whose value actually drifted, to avoid pointless journal churn.
    for (const u of toUpdate) {
      trx.update(roles).set({ isAdmin: u.isAdmin }).where(eq(roles.id, u.id)).run();
    }
  });

  return await db.select().from(roles);
}

/**
 * Load a user's role row. Returns `null` if the user is roleless (or the
 * user does not exist). Single indexed-FK query.
 */
export async function getUserRole(
  db: SudoDb,
  schema: RolePersistenceSchema,
  userId: number,
): Promise<Role | null> {
  const { roles, users } = schema;
  const [row] = await db
    .select({ role: roles })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId))
    .limit(1);
  return (row?.role as Role | undefined) ?? null;
}

/**
 * Set or clear a user's role. Pass `null` to make them roleless (RBAC will
 * deny everything). Throws on unknown role name. Returns the new role row
 * (or `null` when cleared).
 */
export async function setUserRole(
  db: SudoDb,
  schema: RolePersistenceSchema,
  userId: number,
  roleName: string | null,
): Promise<Role | null> {
  const { roles, users } = schema;
  if (roleName === null) {
    await db.update(users).set({ roleId: null }).where(eq(users.id, userId));
    return null;
  }
  const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
  if (!role) throw new Error(`rbac: unknown role '${roleName}'`);
  await db.update(users).set({ roleId: role.id }).where(eq(users.id, userId));
  return role as Role;
}

/** List every persisted role row. */
export async function listRoles(
  db: SudoDb,
  schema: RolePersistenceSchema,
): Promise<Role[]> {
  return await db.select().from(schema.roles);
}

export type { Role };
