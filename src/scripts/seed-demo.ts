/**
 * Idempotent demo seed.
 *
 * Creates two demo users (`demo1`, `demo2`), a `Demo` group, a membership
 * joining `demo1` into the group, and the RBAC entries that scope the group
 * to "see only the todos assigned to me":
 *
 *   - Access right: `Demo` group can create/read/update/delete `todos`.
 *   - Record rule:  `Demo` group's read/update/delete on `todos` is filtered
 *                   by `[["assigneeId", "=", "current_user.id"]]` so members
 *                   only see and mutate the rows they own. (Create has no
 *                   record-rule check — see `rbacDb.ts`.)
 *
 * `demo2` is intentionally not in the group, so it has no `todos` access at
 * all — useful to contrast against `demo1`.
 *
 * Usage: `npx tsx src/scripts/seed-demo.ts`
 */
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import {
  db,
  users,
  groups,
  userGroups,
  accessRights,
  recordRules,
} from "../db.js";

const DEMO_GROUP_NAME = "Demo";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "demo123";

async function ensureUser(name: string, email: string, password: string): Promise<number> {
  const passwordHash = await bcrypt.hash(password, 10);
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    await db.update(users).set({ passwordHash, active: true }).where(eq(users.id, existing.id));
    console.log(`Updated user ${email} (id=${existing.id}); password reset.`);
    return existing.id;
  }
  const [created] = await db
    .insert(users)
    .values({ name, email, passwordHash, active: true })
    .returning();
  console.log(`Created user ${email} (id=${created.id}).`);
  return created.id;
}

async function ensureGroup(name: string): Promise<number> {
  const [existing] = await db.select().from(groups).where(eq(groups.name, name)).limit(1);
  if (existing) return existing.id;
  const [created] = await db.insert(groups).values({ name }).returning();
  console.log(`Created group '${name}' (id=${created.id}).`);
  return created.id;
}

async function ensureMembership(userId: number, groupId: number): Promise<void> {
  const [existing] = await db
    .select()
    .from(userGroups)
    .where(and(eq(userGroups.userId, userId), eq(userGroups.groupId, groupId)))
    .limit(1);
  if (existing) return;
  await db.insert(userGroups).values({ userId, groupId });
  console.log(`Added user ${userId} to group ${groupId}.`);
}

async function ensureAccessRight(
  groupId: number,
  resource: string,
  perms: { canRead?: boolean; canCreate?: boolean; canUpdate?: boolean; canDelete?: boolean },
): Promise<void> {
  const [existing] = await db
    .select()
    .from(accessRights)
    .where(and(eq(accessRights.groupId, groupId), eq(accessRights.resource, resource)))
    .limit(1);
  const values = {
    canRead: perms.canRead ?? false,
    canCreate: perms.canCreate ?? false,
    canUpdate: perms.canUpdate ?? false,
    canDelete: perms.canDelete ?? false,
  };
  if (existing) {
    await db.update(accessRights).set(values).where(eq(accessRights.id, existing.id));
    console.log(`Updated access rights for group ${groupId} on '${resource}'.`);
    return;
  }
  await db.insert(accessRights).values({ groupId, resource, ...values });
  console.log(`Added access rights for group ${groupId} on '${resource}'.`);
}

async function ensureRecordRule(
  groupId: number,
  resource: string,
  permType: "create" | "read" | "update" | "delete",
  domain: unknown[],
): Promise<void> {
  const domainJson = JSON.stringify(domain);
  const [existing] = await db
    .select()
    .from(recordRules)
    .where(
      and(
        eq(recordRules.groupId, groupId),
        eq(recordRules.resource, resource),
        eq(recordRules.permType, permType),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.domain !== domainJson) {
      await db.update(recordRules).set({ domain: domainJson }).where(eq(recordRules.id, existing.id));
      console.log(`Updated record rule (group ${groupId}, ${resource}.${permType}).`);
    }
    return;
  }
  await db.insert(recordRules).values({ groupId, resource, permType, domain: domainJson });
  console.log(`Added record rule (group ${groupId}, ${resource}.${permType}).`);
}

const demo1Id = await ensureUser("Demo One", "demo1@example.com", DEMO_PASSWORD);
const demo2Id = await ensureUser("Demo Two", "demo2@example.com", DEMO_PASSWORD);
const demoGroupId = await ensureGroup(DEMO_GROUP_NAME);

await ensureMembership(demo1Id, demoGroupId);

await ensureAccessRight(demoGroupId, "todos", {
  canCreate: true,
  canRead: true,
  canUpdate: true,
  canDelete: true,
});
const ownTodos = [["assigneeId", "=", "current_user.id"]];
await ensureRecordRule(demoGroupId, "todos", "read", ownTodos);
await ensureRecordRule(demoGroupId, "todos", "update", ownTodos);
await ensureRecordRule(demoGroupId, "todos", "delete", ownTodos);

console.log("");
console.log(`demo1 credentials: demo1@example.com / ${DEMO_PASSWORD}  (in '${DEMO_GROUP_NAME}' group — sees only todos assigned to them)`);
console.log(`demo2 credentials: demo2@example.com / ${DEMO_PASSWORD}  (no group — no todos access)`);
