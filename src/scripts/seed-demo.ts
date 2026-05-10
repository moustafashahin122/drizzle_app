/**
 * Idempotent demo seed.
 *
 * Creates two demo users (`demo1`, `demo2`) and assigns `demo1` to the
 * `demo` role. Runs `syncRbacFromCode` first so the `roles` table is
 * populated and the user_roles FK can resolve.
 *
 *   - Access rights for `demo`: create/read/update/delete on `todos`.
 *   - Record rule for `demo`: read/update/delete `todos` are filtered by
 *                              `[["assigneeId", "=", "current_user.id"]]`.
 *
 * `demo2` is intentionally unassigned, so it has no `todos` access at all
 * — useful to contrast against `demo1`.
 *
 * Usage: `npx tsx src/scripts/seed-demo.ts`
 */
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import {
  buildRbacConfig,
  mergeFrameworkRbac,
  syncRbacFromCode,
} from "drizzle-graphql-rbac";
import { db, users, userRoles, roles, accessRights, recordRules } from "../db.js";
import { roles as rolesCfg } from "../roles.js";
import { accessRights as arCfg } from "../accessRights.js";
import { recordRules as rrCfg } from "../recordRules.js";

const DEMO_ROLE_KEY = "demo";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "demo123";

const resolved = buildRbacConfig(
  mergeFrameworkRbac({
    roles: rolesCfg,
    accessRights: arCfg,
    recordRules: rrCfg,
  }),
);
await syncRbacFromCode(
  db,
  { roles, accessRights, recordRules, userRoles },
  resolved,
);

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

async function ensureRoleAssignment(userId: number, roleKey: string): Promise<void> {
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, roleKey)).limit(1);
  if (!role) throw new Error(`Role '${roleKey}' not found after sync.`);
  const [existing] = await db
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, role.id)))
    .limit(1);
  if (existing) return;
  await db.insert(userRoles).values({ userId, roleId: role.id });
  console.log(`Assigned user ${userId} to role '${roleKey}'.`);
}

const demo1Id = await ensureUser("Demo One", "demo1@example.com", DEMO_PASSWORD);
const demo2Id = await ensureUser("Demo Two", "demo2@example.com", DEMO_PASSWORD);

await ensureRoleAssignment(demo1Id, DEMO_ROLE_KEY);

console.log("");
console.log(`demo1 credentials: demo1@example.com / ${DEMO_PASSWORD}  (in '${DEMO_ROLE_KEY}' role — sees only todos assigned to them)`);
console.log(`demo2 credentials: demo2@example.com / ${DEMO_PASSWORD}  (no role — no todos access)`);
void demo2Id;
