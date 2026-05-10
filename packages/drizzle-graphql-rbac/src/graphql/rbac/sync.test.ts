import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";

import { syncRbacFromCode, loadRbacSnapshot } from "./sync.js";
import {
  buildRbacConfig,
  defineRoles,
  defineAccessRights,
  defineRecordRules,
} from "./config.js";

const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});
const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  xid: text("xid").notNull().unique(),
  key: text("key").notNull().unique(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
});
const accessRights = sqliteTable(
  "access_rights",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    xid: text("xid").notNull().unique(),
    roleId: integer("role_id").notNull().references(() => roles.id),
    resource: text("resource").notNull(),
    canCreate: integer("can_create", { mode: "boolean" }).notNull().default(false),
    canRead: integer("can_read", { mode: "boolean" }).notNull().default(false),
    canUpdate: integer("can_update", { mode: "boolean" }).notNull().default(false),
    canDelete: integer("can_delete", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({ uniqRoleResource: uniqueIndex("ar_role_resource_uniq").on(t.roleId, t.resource) }),
);
const recordRules = sqliteTable(
  "record_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    xid: text("xid").notNull().unique(),
    roleId: integer("role_id").notNull().references(() => roles.id),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    domain: text("domain").notNull(),
  },
  (t) => ({ uniqRoleResAct: uniqueIndex("rr_role_res_act_uniq").on(t.roleId, t.resource, t.action) }),
);
const userRoles = sqliteTable(
  "user_roles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id),
    roleId: integer("role_id").notNull().references(() => roles.id),
  },
  (t) => ({ uniqUserRole: uniqueIndex("ur_user_role_uniq").on(t.userId, t.roleId) }),
);

const schema = { roles, accessRights, recordRules, userRoles };

function setupDb(): { db: ReturnType<typeof drizzle>; sqlite: Database.Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      xid TEXT NOT NULL UNIQUE,
      key TEXT NOT NULL UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE access_rights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      xid TEXT NOT NULL UNIQUE,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      resource TEXT NOT NULL,
      can_create INTEGER NOT NULL DEFAULT 0,
      can_read INTEGER NOT NULL DEFAULT 0,
      can_update INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX ar_role_resource_uniq ON access_rights(role_id, resource);
    CREATE TABLE record_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      xid TEXT NOT NULL UNIQUE,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      resource TEXT NOT NULL,
      action TEXT NOT NULL,
      domain TEXT NOT NULL
    );
    CREATE UNIQUE INDEX rr_role_res_act_uniq ON record_rules(role_id, resource, action);
    CREATE TABLE user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      role_id INTEGER NOT NULL REFERENCES roles(id)
    );
    CREATE UNIQUE INDEX ur_user_role_uniq ON user_roles(user_id, role_id);
  `);
  return { db: drizzle(sqlite), sqlite };
}

const own = [["assigneeId", "=", "current_user.id"]];
const cfgA = buildRbacConfig({
  roles: defineRoles({
    admin: { xid: "x.role.admin", isAdmin: true },
    demo: { xid: "x.role.demo" },
  }),
  accessRights: defineAccessRights({
    demo: {
      todos: { xid: "x.ar.demo.todos", read: true, update: true },
    },
  }),
  recordRules: defineRecordRules({
    demo: {
      todos: { read: { xid: "x.rr.demo.todos.read", domain: own } },
    },
  }),
});

let db: ReturnType<typeof drizzle>;
let sqlite: Database.Database;

beforeEach(() => {
  ({ db, sqlite } = setupDb());
});

describe("syncRbacFromCode", () => {
  it("inserts roles, access rights, and record rules from an empty DB", async () => {
    const result = await syncRbacFromCode(db, schema, cfgA);
    assert.equal(result.rolesInserted, 2);
    assert.equal(result.accessRightsInserted, 1);
    assert.equal(result.recordRulesInserted, 1);

    const rRows = await db.select().from(roles);
    assert.equal(rRows.length, 2);
    const arRows = await db.select().from(accessRights);
    assert.equal(arRows.length, 1);
    const rrRows = await db.select().from(recordRules);
    assert.equal(rrRows.length, 1);
    assert.equal(rrRows[0].domain, JSON.stringify(own));
  });

  it("is idempotent — second run with same config is a no-op", async () => {
    await syncRbacFromCode(db, schema, cfgA);
    const second = await syncRbacFromCode(db, schema, cfgA);
    assert.deepEqual(second, {
      rolesDeleted: 0, rolesInserted: 0, rolesUpdated: 0,
      accessRightsDeleted: 0, accessRightsInserted: 0, accessRightsUpdated: 0,
      recordRulesDeleted: 0, recordRulesInserted: 0, recordRulesUpdated: 0,
    });
  });

  it("cascade-deletes orphan roles (and their AR / RR / userRoles rows)", async () => {
    await syncRbacFromCode(db, schema, cfgA);
    // Add a user_roles row referencing the demo role.
    const [u] = await db.insert(users).values({ name: "U" }).returning();
    const [demoRole] = await db.select().from(roles).where(eq(roles.key, "demo"));
    await db.insert(userRoles).values({ userId: u.id, roleId: demoRole.id });

    // New config drops the 'demo' role entirely.
    const cfgB = buildRbacConfig({
      roles: defineRoles({ admin: { xid: "x.role.admin", isAdmin: true } }),
      accessRights: defineAccessRights({}),
      recordRules: defineRecordRules({}),
    });
    const result = await syncRbacFromCode(db, schema, cfgB);

    assert.equal(result.rolesDeleted, 1);
    // AR + RR cascade was done as part of the role-delete pass; the dedicated
    // AR/RR pass had nothing left to do.
    const arRows = await db.select().from(accessRights);
    assert.equal(arRows.length, 0);
    const rrRows = await db.select().from(recordRules);
    assert.equal(rrRows.length, 0);
    const urRows = await db.select().from(userRoles);
    assert.equal(urRows.length, 0);
  });

  it("updates an access right when CRUD booleans change", async () => {
    await syncRbacFromCode(db, schema, cfgA);
    const cfgB = buildRbacConfig({
      roles: defineRoles({
        admin: { xid: "x.role.admin", isAdmin: true },
        demo: { xid: "x.role.demo" },
      }),
      accessRights: defineAccessRights({
        demo: {
          todos: {
            xid: "x.ar.demo.todos",
            read: true,
            update: true,
            delete: true,
          },
        },
      }),
      recordRules: defineRecordRules({
        demo: {
          todos: { read: { xid: "x.rr.demo.todos.read", domain: own } },
        },
      }),
    });
    const result = await syncRbacFromCode(db, schema, cfgB);
    assert.equal(result.accessRightsUpdated, 1);
    const [row] = await db.select().from(accessRights).where(eq(accessRights.xid, "x.ar.demo.todos"));
    assert.equal(row.canDelete, true);
  });

  it("updates a record rule when the domain changes", async () => {
    await syncRbacFromCode(db, schema, cfgA);
    const cfgB = buildRbacConfig({
      roles: defineRoles({
        admin: { xid: "x.role.admin", isAdmin: true },
        demo: { xid: "x.role.demo" },
      }),
      accessRights: defineAccessRights({
        demo: { todos: { xid: "x.ar.demo.todos", read: true, update: true } },
      }),
      recordRules: defineRecordRules({
        demo: {
          todos: {
            read: {
              xid: "x.rr.demo.todos.read",
              domain: [["assigneeId", "!=", null]],
            },
          },
        },
      }),
    });
    const result = await syncRbacFromCode(db, schema, cfgB);
    assert.equal(result.recordRulesUpdated, 1);
    const [row] = await db.select().from(recordRules).where(eq(recordRules.xid, "x.rr.demo.todos.read"));
    assert.equal(row.domain, JSON.stringify([["assigneeId", "!=", null]]));
  });
});

describe("loadRbacSnapshot", () => {
  it("returns the synced state in a runtime-friendly shape", async () => {
    await syncRbacFromCode(db, schema, cfgA);
    const snap = await loadRbacSnapshot(db, schema);
    assert.equal(snap.rolesById.size, 2);
    const [admin] = await db.select().from(roles).where(eq(roles.key, "admin"));
    assert.equal(snap.rolesById.get(admin.id)?.isAdmin, true);
    const [demo] = await db.select().from(roles).where(eq(roles.key, "demo"));
    const demoAccess = snap.accessByRole.get(demo.id)!;
    assert.ok(demoAccess.get("todos")?.has("read"));
    assert.ok(demoAccess.get("todos")?.has("update"));
    const demoRules = snap.rulesByRole.get(demo.id)!.get("todos")!;
    assert.deepEqual(demoRules.get("read"), own);
  });
});

void sqlite;
