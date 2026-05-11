/**
 * Cross-table RBAC traversal: a `projects` table with no record rules, plus
 * the existing `todos` read rule (demo: own rows only). Proves that the
 * auto-promoted inverse `projects.todos` relation enforces the **referenced**
 * table's record rule, so a demo user querying a shared project does not see
 * other users' todos via traversal.
 *
 * `projects.todos` is the inverse "many" relation auto-promoted from the
 * single-column FK `todos.projectId → projects.id`; the field name is the JS
 * key of the source table (`todos`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { setupAppTestCase, createUser } from "./testing/appTestCase.js";

const tc = setupAppTestCase(async (base) => {
  const carol = await createUser(base.sudoDb, { name: "Carol", email: "carol@example.com" });
  const alice = await createUser(base.sudoDb, { name: "Alice", email: "alice@example.com" });
  const bob   = await createUser(base.sudoDb, { name: "Bob",   email: "bob@example.com" });

  base.rbac.assignRole(carol.id, "manager");
  base.rbac.assignRole(alice.id, "demo");
  base.rbac.assignRole(bob.id,   "demo");

  const [project] = await base.sudoDb
    .insert(base.schema.projects)
    .values({ name: "shared-project" })
    .returning();

  const inserted = await base.sudoDb
    .insert(base.schema.todos)
    .values([
      { title: "alice-1", assigneeId: alice.id, projectId: project.id },
      { title: "alice-2", assigneeId: alice.id, projectId: project.id },
      { title: "bob-1",   assigneeId: bob.id,   projectId: project.id },
      { title: "bob-2",   assigneeId: bob.id,   projectId: project.id },
    ])
    .returning();
  const byTitle = Object.fromEntries(inserted.map((r) => [r.title, r])) as Record<
    "alice-1" | "alice-2" | "bob-1" | "bob-2",
    typeof inserted[number]
  >;

  return { carol, alice, bob, project, todos: byTitle };
});

const Q_PROJECT_WITH_TODOS = `
  query($w: JSON) {
    projectsSingle(where: $w) {
      id
      name
      todos { id title }
    }
  }
`;

const titlesOf = (rows: Array<{ title: string }>) => rows.map((r) => r.title).sort();
const idsOf = (rows: Array<{ id: string | number }>) => rows.map((r) => Number(r.id)).sort((a, b) => a - b);

describe("projects → todos relation traversal honors todos record rules", () => {
  // Same flow (load project, traverse `todos`), same invariant (relation list
  // is filtered by the referenced table's read rule). Only the actor + the
  // expected visible titles vary — table-driven so a regression on any actor
  // path fails its own case rather than blocking the others.
  const cases: Array<{
    name: string;
    actor: () => number;
    expectedTitles: string[];
    expectedIds: () => number[];
  }> = [
    {
      name: "demo Alice sees only her own 2 todos",
      actor: () => tc.seed.alice.id,
      expectedTitles: ["alice-1", "alice-2"],
      expectedIds: () => [tc.seed.todos["alice-1"].id, tc.seed.todos["alice-2"].id],
    },
    {
      name: "demo Bob sees only his own 2 todos",
      actor: () => tc.seed.bob.id,
      expectedTitles: ["bob-1", "bob-2"],
      expectedIds: () => [tc.seed.todos["bob-1"].id, tc.seed.todos["bob-2"].id],
    },
    {
      name: "manager Carol sees every todo (no record rule on manager)",
      actor: () => tc.seed.carol.id,
      expectedTitles: ["alice-1", "alice-2", "bob-1", "bob-2"],
      expectedIds: () => [
        tc.seed.todos["alice-1"].id,
        tc.seed.todos["alice-2"].id,
        tc.seed.todos["bob-1"].id,
        tc.seed.todos["bob-2"].id,
      ],
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const { status, body } = await tc.runHttp(Q_PROJECT_WITH_TODOS, {
        asUserId: c.actor(),
        variables: { w: [["id", "=", tc.seed.project.id]] },
      });
      assert.equal(status, 200);
      assert.equal(body.errors, undefined, JSON.stringify(body.errors));

      const project = body.data.projectsSingle;
      // Project identity: every actor reaches the same project (no record
      // rule on projects → table-level grant alone is sufficient).
      assert.ok(project, "projectsSingle must resolve for an authorized actor");
      assert.equal(Number(project.id), tc.seed.project.id);
      assert.equal(project.name, "shared-project");

      // Cardinality first, then full id + title tuples. Catches duplicates
      // and over/under-fetch independently of order.
      assert.equal(project.todos.length, c.expectedTitles.length, "todos cardinality");
      assert.deepEqual(titlesOf(project.todos), c.expectedTitles);
      assert.deepEqual(idsOf(project.todos), c.expectedIds().slice().sort((a, b) => a - b));
      const idSet = new Set(project.todos.map((t: any) => Number(t.id)));
      assert.equal(idSet.size, project.todos.length, "no duplicate todo ids in traversal");
    });
  }

  it("baseline: sudoDb still holds all 4 todos — the record rule narrows the GraphQL view, not the DB", async () => {
    // Guards against a regression where the rule is mis-applied as a DELETE
    // filter or a row-hiding side effect at the DB layer.
    const rows = await tc.sudoDb
      .select()
      .from(tc.schema.todos)
      .where(eq(tc.schema.todos.projectId, tc.seed.project.id));
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => r.title).sort(), ["alice-1", "alice-2", "bob-1", "bob-2"]);
  });

  it("nested where on `todos` AND-s with the read rule — Alice asking for Bob's todo through the project gets []", async () => {
    // Proves the rbac extra-where and the caller's args.where compose with
    // AND (not OR / not replacement). bob-1 exists in the project but is
    // outside Alice's read scope, so the rule must filter it out even when
    // the caller's `where` would otherwise match it.
    const { body } = await tc.runHttp(
      `query($pw: JSON, $tw: JSON) {
         projectsSingle(where: $pw) {
           id
           todos(where: $tw) { id title }
         }
       }`,
      {
        asUserId: tc.seed.alice.id,
        variables: {
          pw: [["id", "=", tc.seed.project.id]],
          tw: [["title", "=", "bob-1"]],
        },
      },
    );
    assert.equal(body.errors, undefined, JSON.stringify(body.errors));
    assert.equal(Number(body.data.projectsSingle.id), tc.seed.project.id);
    assert.deepEqual(body.data.projectsSingle.todos, []);
  });

  it("anonymous request is rejected at the HTTP layer (project resolver never runs)", async () => {
    const { status, body } = await tc.runHttp(Q_PROJECT_WITH_TODOS, {
      variables: { w: [["id", "=", tc.seed.project.id]] },
    });
    assert.equal(status, 401);
    assert.equal(body?.error, "Authentication required");
    assert.equal(body?.data, undefined);
  });
});
