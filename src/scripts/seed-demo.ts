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
import { db, users } from "../db.js";

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

await ensureUser("Demo One", "demo1@example.com", DEMO_PASSWORD);
await ensureUser("Demo Two", "demo2@example.com", DEMO_PASSWORD);

console.log("");
console.log(`demo1 credentials: demo1@example.com / ${DEMO_PASSWORD}  (server.ts assigns the 'demo' role in memory)`);
console.log(`demo2 credentials: demo2@example.com / ${DEMO_PASSWORD}  (no role — no todos access)`);
