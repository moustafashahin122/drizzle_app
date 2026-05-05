/**
 * Idempotent admin seed.
 *
 * Ensures a known admin user, an `Administration` group flagged `isAdmin`
 * (which bypasses every RBAC check), and a membership joining the two — so a
 * fresh clone always has a working credential that can manage groups, access
 * rights, and record rules.
 *
 * Usage: `npm run seed:admin` (overrides via env: ADMIN_EMAIL, ADMIN_PASSWORD,
 * ADMIN_NAME).
 */
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { db, users, groups, userGroups } from "../db.js";

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

const ADMIN_GROUP_NAME = "Administration";
const [adminGroup] = await db
  .select()
  .from(groups)
  .where(eq(groups.name, ADMIN_GROUP_NAME))
  .limit(1);
let adminGroupId: number;
if (adminGroup) {
  if (!adminGroup.isAdmin) {
    await db.update(groups).set({ isAdmin: true }).where(eq(groups.id, adminGroup.id));
  }
  adminGroupId = adminGroup.id;
} else {
  const [created] = await db
    .insert(groups)
    .values({ name: ADMIN_GROUP_NAME, isAdmin: true })
    .returning();
  adminGroupId = created.id;
  console.log(`Created group '${ADMIN_GROUP_NAME}' (id=${adminGroupId}).`);
}

const [membership] = await db
  .select()
  .from(userGroups)
  .where(and(eq(userGroups.userId, userId), eq(userGroups.groupId, adminGroupId)))
  .limit(1);
if (!membership) {
  await db.insert(userGroups).values({ userId, groupId: adminGroupId });
  console.log(`Added user ${userId} to group '${ADMIN_GROUP_NAME}'.`);
}

console.log(`Credentials: ${email} / ${password}`);
