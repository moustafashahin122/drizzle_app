/**
 * Idempotent demo user seed.
 *
 * Creates two demo users (`demo1`, `demo2`). Role assignment is in-memory in
 * this build — `server.ts` assigns the `demo` role to `demo1@example.com`
 * on startup. `demo2` stays unassigned so the contrast (no role → no todos
 * access) is observable.
 *
 * Usage: `npx tsx src/scripts/seed-demo.ts`
 */
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { logger } from "drizzle-graphql-rbac";
import { db, users } from "../db.js";

const log = logger.child({ component: "app.seed.demo" });

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "demo123";

async function ensureUser(name: string, email: string, password: string): Promise<number> {
  const passwordHash = await bcrypt.hash(password, 10);
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    await db.update(users).set({ passwordHash, active: true }).where(eq(users.id, existing.id));
    log.info({ email, userId: existing.id }, "updated user; password reset");
    return existing.id;
  }
  const [created] = await db
    .insert(users)
    .values({ name, email, passwordHash, active: true })
    .returning();
  log.info({ email, userId: created.id }, "created user");
  return created.id;
}

await ensureUser("Demo One", "demo1@example.com", DEMO_PASSWORD);
await ensureUser("Demo Two", "demo2@example.com", DEMO_PASSWORD);

log.info(
  { email: "demo1@example.com", password: DEMO_PASSWORD },
  "demo1 credentials (server.ts assigns the 'demo' role in memory)",
);
log.info(
  { email: "demo2@example.com", password: DEMO_PASSWORD },
  "demo2 credentials (no role — no todos access)",
);
