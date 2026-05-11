/**
 * Idempotent admin user seed.
 *
 * Creates (or resets the password on) a known admin user. Role assignment is
 * in-memory in this build — `server.ts` assigns the `admin` role to whichever
 * user matches `ADMIN_EMAIL` on startup, so this script only owns the DB row.
 *
 * Usage: `npm run seed:admin` (overrides via env: ADMIN_EMAIL, ADMIN_PASSWORD,
 * ADMIN_NAME).
 */
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, users } from "../db.js";

const email = process.env.ADMIN_EMAIL ?? "admin@example.com";
const password = process.env.ADMIN_PASSWORD ?? "admin123";
const name = process.env.ADMIN_NAME ?? "Admin";

const passwordHash = await bcrypt.hash(password, 10);

const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (existing) {
  await db.update(users).set({ passwordHash, active: true }).where(eq(users.id, existing.id));
  console.log(`Updated existing user ${email} (id=${existing.id}); password reset.`);
} else {
  const [created] = await db
    .insert(users)
    .values({ name, email, passwordHash, active: true })
    .returning();
  console.log(`Created admin user ${email} (id=${created.id}).`);
}

console.log(`Credentials: ${email} / ${password}`);
console.log("The 'admin' role is assigned in memory by server.ts on startup.");
