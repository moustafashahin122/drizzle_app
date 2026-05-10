/**
 * Idempotent admin seed.
 *
 * Ensures a known admin user and assigns them the `admin` role. The role
 * row itself is materialized from `src/roles.ts` via `syncRbacFromCode`,
 * which the script runs first so the `roles` table is populated before
 * we try to FK into it.
 *
 * Usage: `npm run seed:admin` (overrides via env: ADMIN_EMAIL, ADMIN_PASSWORD,
 * ADMIN_NAME).
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

// Sync the code-defined RBAC config to the DB so 'admin' has a row.
// Merge the framework's built-in `admin` role so this script can find it.
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

const email = process.env.ADMIN_EMAIL ?? "admin@example.com";
const password = process.env.ADMIN_PASSWORD ?? "admin123";
const name = process.env.ADMIN_NAME ?? "Admin";

const passwordHash = await bcrypt.hash(password, 10);

const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
let userId: number;
if (existing) {
  await db.update(users).set({ passwordHash, active: true }).where(eq(users.id, existing.id));
  userId = existing.id;
  console.log(`Updated existing user ${email} (id=${userId}); password reset.`);
} else {
  const [created] = await db
    .insert(users)
    .values({ name, email, passwordHash, active: true })
    .returning();
  userId = created.id;
  console.log(`Created admin user ${email} (id=${userId}).`);
}

const ADMIN_ROLE_KEY = "admin";
const [adminRole] = await db
  .select({ id: roles.id })
  .from(roles)
  .where(eq(roles.key, ADMIN_ROLE_KEY))
  .limit(1);
if (!adminRole) {
  throw new Error(`Role '${ADMIN_ROLE_KEY}' not found in DB after sync.`);
}

const [membership] = await db
  .select()
  .from(userRoles)
  .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, adminRole.id)))
  .limit(1);
if (!membership) {
  await db.insert(userRoles).values({ userId, roleId: adminRole.id });
  console.log(`Assigned user ${userId} to role '${ADMIN_ROLE_KEY}'.`);
}

console.log(`Credentials: ${email} / ${password}`);
