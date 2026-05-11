/**
 * Production admin bootstrap.
 *
 * In `NODE_ENV === "production"`, upserts a single admin row from
 * `ADMIN_EMAIL` / `ADMIN_PASSWORD` (optional `ADMIN_NAME`) and throws if
 * either required env var is missing. In any other env this is a no-op.
 *
 * Demo-user/todo seeding has moved to `seedDemo.ts` and must be run
 * explicitly via `npm run seed:demo`.
 */
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { logger } from "drizzle-graphql-rbac";
import { sudoDb } from "../sudoDb.js";
import { users } from "../schema.js";

const log = logger.child({ component: "app.bootstrap" });

export interface BootstrappedAdmin {
  email: string;
  role: "admin";
}

export async function upsertUser(name: string, email: string, password: string): Promise<number> {
  const passwordHash = await bcrypt.hash(password, 10);
  const [existing] = await sudoDb.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    await sudoDb.update(users).set({ passwordHash, active: true }).where(eq(users.id, existing.id));
    log.info({ email, userId: existing.id }, "user updated");
    return existing.id;
  }
  const [created] = await sudoDb
    .insert(users)
    .values({ name, email, passwordHash, active: true })
    .returning();
  log.info({ email, userId: created.id }, "user created");
  return created.id;
}

export async function bootstrapUsers(): Promise<BootstrappedAdmin | null> {
  if (process.env.NODE_ENV !== "production") return null;

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD env vars are required in production");
  }
  const name = process.env.ADMIN_NAME ?? "Admin";
  await upsertUser(name, email, password);
  return { email, role: "admin" };
}
