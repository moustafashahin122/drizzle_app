/**
 * Demo seed script — run with `npm run seed:demo`.
 *
 * Upserts the three well-known demo users (`demo_admin`, `demo_manager`,
 * `demo_user`) with password `demo123` (override via `DEV_PASSWORD`), and —
 * if the `todos` table is empty — seeds a handful of projects plus demo
 * todos distributed across those users (plus a couple unassigned). Demo-todo
 * seeding is one-shot: any pre-existing todo skips it entirely so developer
 * edits aren't clobbered.
 *
 * Run `npm run seed:demo:reset` to wipe the `todos` and `projects` tables
 * before seeding, forcing a fresh demo dataset.
 */
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import {
  logger,
  syncRoles,
  buildRbacConfig,
  mergeFrameworkRbac,
} from "drizzle-graphql-rbac";
import { sudoDb } from "../sudoDb.js";
import {
  projects,
  todos,
  roles as rolesTable,
  users as usersTable,
} from "../schema.js";
import {
  DEMO_ADMIN_EMAIL,
  DEMO_MANAGER_EMAIL,
  DEMO_USER_EMAIL,
} from "../demoUsers.js";
import { roles as codeRoles } from "../roles.js";
import { accessRights } from "../accessRights.js";
import { recordRules } from "../recordRules.js";

const log = logger.child({ component: "app.seed-demo" });

/**
 * Upsert a demo user and bind them to the named role. The role row must
 * exist in the `roles` table (it does after `syncRoles` runs above).
 * Idempotent — re-running refreshes the password hash.
 */
async function upsertDemoUser(
  name: string,
  email: string,
  password: string,
  roleName: string,
): Promise<number> {
  const passwordHash = await bcrypt.hash(password, 10);
  const [role] = await sudoDb
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.name, roleName))
    .limit(1);
  if (!role) throw new Error(`seedDemo: role '${roleName}' not found in DB`);

  const [existing] = await sudoDb
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (existing) {
    await sudoDb
      .update(usersTable)
      .set({ passwordHash, active: true, roleId: role.id })
      .where(eq(usersTable.id, existing.id));
    log.info({ email, userId: existing.id, roleName }, "demo user updated");
    return existing.id;
  }
  const [created] = await sudoDb
    .insert(usersTable)
    .values({ name, email, passwordHash, active: true, roleId: role.id })
    .returning();
  log.info({ email, userId: created.id, roleName }, "demo user created");
  return created.id;
}

async function seedDemoTodos(ids: { admin: number; manager: number; user: number }): Promise<void> {
  const [{ count }] = await sudoDb.select({ count: sql<number>`count(*)` }).from(todos);
  if (Number(count) > 0) {
    log.info({ existing: Number(count) }, "todos already present — skipping todo seed");
    return;
  }

  const insertedProjects = await sudoDb
    .insert(projects)
    .values([
      { name: "Platform" },
      { name: "Growth" },
      { name: "Onboarding" },
    ])
    .returning();
  const [platform, growth, onboarding] = insertedProjects;

  await sudoDb.insert(todos).values([
    // Admin — ops & governance work
    { title: "Review pending pull requests", assigneeId: ids.admin, projectId: platform.id },
    { title: "Audit role assignments", assigneeId: ids.admin, projectId: platform.id, completed: true },
    { title: "Rotate production API keys", assigneeId: ids.admin, projectId: platform.id },
    { title: "Investigate failing nightly job", assigneeId: ids.admin, projectId: platform.id },
    { title: "Document on-call runbook", assigneeId: ids.admin, projectId: onboarding.id, completed: true },

    // Manager — planning & people
    { title: "Plan next sprint", assigneeId: ids.manager, projectId: platform.id },
    { title: "1:1 with new hire", assigneeId: ids.manager, projectId: onboarding.id },
    { title: "Draft Q3 roadmap", assigneeId: ids.manager, projectId: growth.id },
    { title: "Review growth experiment results", assigneeId: ids.manager, projectId: growth.id, completed: true },
    { title: "Update team OKRs", assigneeId: ids.manager, projectId: growth.id },

    // Regular user — IC tasks
    { title: "Write GraphQL query for my todos", assigneeId: ids.user, projectId: platform.id },
    { title: "Try toggling completed flag", assigneeId: ids.user, projectId: platform.id, completed: true },
    { title: "Read onboarding docs", assigneeId: ids.user, projectId: onboarding.id, completed: true },
    { title: "Set up local dev environment", assigneeId: ids.user, projectId: onboarding.id, completed: true },
    { title: "Pair with manager on first ticket", assigneeId: ids.user, projectId: onboarding.id },
    { title: "Add a unit test for the todo list view", assigneeId: ids.user, projectId: platform.id },

    // Unassigned — triage backlog
    { title: "Triage unassigned bugs", projectId: platform.id },
    { title: "Investigate flaky signup funnel", projectId: growth.id },
  ]);
  log.info({ projectIds: insertedProjects.map((p) => p.id) }, "demo todos seeded");
}

async function resetDemoData(): Promise<void> {
  await sudoDb.delete(todos);
  await sudoDb.delete(projects);
  log.info("cleared existing todos and projects");
}

export async function seedDemo({ reset = false }: { reset?: boolean } = {}): Promise<void> {
  if (reset) await resetDemoData();

  // Sync the `roles` table with the in-code role config before assigning
  // `users.role_id` — the server normally does this at startup, but a fresh
  // checkout might run `seed:demo` before ever starting the server.
  const merged = mergeFrameworkRbac({ roles: codeRoles, accessRights, recordRules });
  const resolved = buildRbacConfig(merged);
  await syncRoles(
    sudoDb,
    { users: usersTable, roles: rolesTable },
    resolved.roles,
  );

  const password = process.env.DEV_PASSWORD ?? "demo123";
  const adminId   = await upsertDemoUser("Demo Admin",   DEMO_ADMIN_EMAIL,   password, "admin");
  const managerId = await upsertDemoUser("Demo Manager", DEMO_MANAGER_EMAIL, password, "manager");
  const userId    = await upsertDemoUser("Demo User",    DEMO_USER_EMAIL,    password, "demo");
  await seedDemoTodos({ admin: adminId, manager: managerId, user: userId });
}

const reset = process.argv.includes("--reset");
await seedDemo({ reset });
log.info("demo seed complete");
