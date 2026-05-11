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
import { logger } from "drizzle-graphql-rbac";
import { sudoDb } from "../sudoDb.js";
import { users } from "../schema.js";

const log = logger.child({ component: "app.seed.admin" });

const email = process.env.ADMIN_EMAIL ?? "admin@example.com";
const password = process.env.ADMIN_PASSWORD ?? "admin123";
const name = process.env.ADMIN_NAME ?? "Admin";

const passwordHash = await bcrypt.hash(password, 10);

const [existing] = await sudoDb.select().from(users).where(eq(users.email, email)).limit(1);
if (existing) {
  await sudoDb.update(users).set({ passwordHash, active: true }).where(eq(users.id, existing.id));
  log.info({ email, userId: existing.id }, "updated existing user; password reset");
} else {
  const [created] = await sudoDb
    .insert(users)
    .values({ name, email, passwordHash, active: true })
    .returning();
  log.info({ email, userId: created.id }, "created admin user");
}

log.info({ email, password }, "admin credentials");
log.info("the 'admin' role is assigned in memory by server.ts on startup");
