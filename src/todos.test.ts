/**
 * App-level RBAC matrix for the todo demo.
 *
 * Cast (seeded once per suite, rolled back to between tests via savepoints):
 *   - Carol (manager) — full CRUD on every todo
 *   - Alice (demo)    — owns alice-1, alice-2
 *   - Bob   (demo)    — owns bob-1,   bob-2
 *
 * Each mutation test asserts three layers: the GraphQL response payload,
 * the DB cross-read for ground truth, and isolation of unrelated rows.
 * Deny paths match an error-category regex rather than a full message so
 * tests don't bind to phrasing.
 *
 * `where` uses the framework's JSON domain syntax (`[[field, op, value]]`);
 * `set` / `values` are typed (`TodosUpdate` / `TodosInsert`). Outputs don't
 * traverse the auto-promoted `assigneeId` relation — demo/manager have no
 * `users` access right — so FK checks go to the DB directly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { setupAppTestCase, createUser } from "./testing/appTestCase.js";

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const tc = setupAppTestCase(async (base) => {
  const carol = await createUser(base.sudoDb, { name: "Carol", email: "carol@example.com" });
  const alice = await createUser(base.sudoDb, { name: "Alice", email: "alice@example.com" });
  const bob   = await createUser(base.sudoDb, { name: "Bob",   email: "bob@example.com" });

  base.rbac.assignRole(carol.id, "manager");
  base.rbac.assignRole(alice.id, "demo");
  base.rbac.assignRole(bob.id,   "demo");

  const inserted = await base.sudoDb
    .insert(base.schema.todos)
    .values([
      { title: "alice-1", assigneeId: alice.id },
      { title: "alice-2", assigneeId: alice.id },
      { title: "bob-1",   assigneeId: bob.id   },
      { title: "bob-2",   assigneeId: bob.id   },
    ])
    .returning();
  const byTitle = Object.fromEntries(inserted.map((r) => [r.title, r])) as Record<
    "alice-1" | "alice-2" | "bob-1" | "bob-2",
    typeof inserted[number]
  >;

  return { carol, alice, bob, todos: byTitle };
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const Q_TODOS  = `query { todos { id title completed } }`;
const Q_SINGLE = `query($w: JSON) { todosSingle(where: $w) { id title } }`;
const M_INSERT = `mutation($v: [TodosInsert!]!) { insertIntoTodos(values: $v) { id title completed } }`;
const M_UPDATE = `mutation($w: JSON, $s: TodosUpdate!) { updateTodos(where: $w, set: $s) { id title completed } }`;
const M_DELETE = `mutation($w: JSON) { deleteFromTodos(where: $w) { id title } }`;

const DENY_PATTERN = /rbac|forbidden|access|denied|auth/i;
const titles = (rows: Array<{ title: string }>) => rows.map((r) => r.title).sort();

/**
 * A response should have no data for the given root field and a
 * recognizably-deny error. Two envelopes are accepted:
 *   - resolver-level GraphQL deny: `{ data: { <root>: null }, errors: [{ message }] }`
 *   - HTTP-layer auth gate:        `{ error: "Authentication required" }` (no data, no errors)
 *
 * Both shapes encode "operation refused"; the test only cares that the row
 * effect is the same.
 */
function assertDenied(body: any, rootField: string, label: string) {
  if (body && typeof body.error === "string" && body.data === undefined) {
    assert.match(body.error, DENY_PATTERN, `${label}: HTTP error doesn't look like a deny ("${body.error}")`);
    return;
  }
  assert.equal(body.data?.[rootField] ?? null, null, `${label}: expected ${rootField} = null`);
  const msg = body.errors?.[0]?.message ?? "";
  assert.ok(msg, `${label}: expected an error message`);
  assert.match(msg, DENY_PATTERN, `${label}: error doesn't look like a deny ("${msg}")`);
}

const dbAllTodos = () =>
  tc.sudoDb.select().from(tc.schema.todos).orderBy(tc.schema.todos.id);

const dbTodoById = (id: number) =>
  tc.sudoDb
    .select()
    .from(tc.schema.todos)
    .where(eq(tc.schema.todos.id, id))
    .limit(1)
    .then((r) => r[0]);

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

describe("todos.read — role-based row scoping", () => {
  const cases = [
    { name: "demo Alice sees only own todos (2)",  actor: () => tc.seed.alice.id, expected: ["alice-1", "alice-2"] },
    { name: "demo Bob sees only own todos (2)",    actor: () => tc.seed.bob.id,   expected: ["bob-1", "bob-2"] },
    { name: "manager Carol sees every todo (4)",   actor: () => tc.seed.carol.id, expected: ["alice-1", "alice-2", "bob-1", "bob-2"] },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const { status, body } = await tc.runHttp(Q_TODOS, { asUserId: c.actor() });
      assert.equal(status, 200);
      assert.equal(body.errors, undefined);
      assert.equal(body.data.todos.length, c.expected.length);
      assert.deepEqual(titles(body.data.todos), c.expected);
      // All rows default to completed:false — guards against accidental side
      // effects from a previous test bleeding through the savepoint.
      assert.equal(body.data.todos.every((t: any) => t.completed === false), true);
    });
  }

  it("anonymous query is rejected at the HTTP layer with 401 (parser never reached)", async () => {
    const { status, body } = await tc.runHttp(Q_TODOS);
    // The /graphql endpoint refuses unauthenticated traffic before parsing —
    // resolver-level RBAC would also throw "Not authenticated", but this is
    // defense-in-depth. The response is a plain JSON error, not a GraphQL
    // errors[] envelope, so there is no `data` field at all.
    assert.equal(status, 401);
    assert.equal(body?.error, "Authentication required");
    assert.equal(body?.data, undefined);
    assert.equal(body?.errors, undefined);
  });

  it("demo where(assigneeId=otherUser) returns nothing — rule AND-ed with user filter", async () => {
    const { body } = await tc.runHttp(
      `query($w: JSON) { todos(where: $w) { id title } }`,
      { asUserId: tc.seed.alice.id, variables: { w: [["assigneeId", "=", tc.seed.bob.id]] } },
    );
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.todos, []);
  });

  const singleCases = [
    { name: "demo single → null for non-owned row", actor: () => tc.seed.alice.id, expectTitle: null as string | null },
    { name: "manager single → resolves any row",     actor: () => tc.seed.carol.id, expectTitle: "bob-1" },
  ];
  for (const c of singleCases) {
    it(c.name, async () => {
      const targetId = tc.seed.todos["bob-1"].id;
      const { body } = await tc.runHttp(Q_SINGLE, {
        asUserId: c.actor(),
        variables: { w: [["id", "=", targetId]] },
      });
      assert.equal(body.errors, undefined);
      if (c.expectTitle == null) {
        assert.equal(body.data.todosSingle, null);
      } else {
        assert.equal(body.data.todosSingle.title, c.expectTitle);
        assert.equal(Number(body.data.todosSingle.id), targetId);
      }
    });
  }

  it("direct GraphQL transport matches HTTP scoping (demo Bob)", async () => {
    const res: any = await tc.runDirect(Q_TODOS, {
      user: { id: tc.seed.bob.id, name: tc.seed.bob.name },
    });
    assert.equal(res.errors, undefined);
    assert.equal(res.data.todos.length, 2);
    assert.deepEqual(titles(res.data.todos), ["bob-1", "bob-2"]);
  });
});

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

describe("todos.create — ACL allows creation; insert-row filtering not yet modeled", () => {
  type Outcome = "ok" | "anon";
  // Insert-time record-rule narrowing (e.g. demo → other-user assignee) is
  // intentionally not enforced for now — see src/recordRules.ts. The
  // "demo → other user" case is therefore expected to succeed under the
  // current configuration; re-add a `forbidden` case once create-rules ship.
  const cases: Array<{
    name: string;
    actor: () => number | undefined;
    assignee: () => number;
    outcome: Outcome;
  }> = [
    { name: "demo → self: row persisted with default completed=false", actor: () => tc.seed.alice.id, assignee: () => tc.seed.alice.id, outcome: "ok" },
    { name: "demo → other user: row persisted (no create-rule enforcement yet)", actor: () => tc.seed.alice.id, assignee: () => tc.seed.bob.id,   outcome: "ok" },
    { name: "manager → any user: row persisted for that assignee",      actor: () => tc.seed.carol.id, assignee: () => tc.seed.alice.id, outcome: "ok" },
    { name: "anonymous: denied, baseline unchanged",                     actor: () => undefined,         assignee: () => tc.seed.alice.id, outcome: "anon" },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const before = await dbAllTodos();
      assert.equal(before.length, 4, "fixture baseline");

      const asUserId = c.actor();
      const { body } = await tc.runHttp(M_INSERT, {
        ...(asUserId != null ? { asUserId } : {}),
        variables: { v: [{ title: "new-row", assigneeId: c.assignee() }] },
      });

      const after = await dbAllTodos();

      if (c.outcome === "ok") {
        assert.equal(body.errors, undefined);
        assert.equal(body.data.insertIntoTodos.length, 1);
        const returned = body.data.insertIntoTodos[0];
        assert.equal(returned.title, "new-row");
        assert.equal(returned.completed, false);
        assert.equal(after.length, 5, "exactly one new row persisted");

        // FK + defaults at the DB level (output relation isn't traversable here).
        const persisted = await dbTodoById(Number(returned.id));
        assert.equal(persisted.title, "new-row");
        assert.equal(persisted.assigneeId, c.assignee());
        assert.equal(persisted.completed, false);
        assert.ok(persisted.createdAt, "createdAt default populated");

        // Isolation: every seed row unchanged.
        for (const orig of before) {
          const still = after.find((r) => r.id === orig.id);
          assert.deepEqual(still, orig, `seed row #${orig.id} mutated by insert`);
        }
      } else {
        assertDenied(body, "insertIntoTodos", c.name);
        // Strict equality on the row set — no row added, no row touched.
        assert.deepEqual(after, before, "table mutated on rejected/denied insert");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

describe("todos.update — cross-actor isolation", () => {
  type Outcome = "applied" | "zero" | "denied";
  const cases: Array<{
    name: string;
    actor: () => number | undefined;
    target: () => number;
    outcome: Outcome;
  }> = [
    { name: "demo → own row: returns 1, row completed",            actor: () => tc.seed.alice.id, target: () => tc.seed.todos["alice-1"].id, outcome: "applied" },
    { name: "demo → other's row: returns 0, every row unchanged",  actor: () => tc.seed.alice.id, target: () => tc.seed.todos["bob-1"].id,   outcome: "zero" },
    { name: "manager → any row: returns 1, row completed",         actor: () => tc.seed.carol.id, target: () => tc.seed.todos["bob-2"].id,   outcome: "applied" },
    { name: "anonymous: denied, every row unchanged",              actor: () => undefined,         target: () => tc.seed.todos["alice-1"].id, outcome: "denied" },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const targetId = c.target();
      const before = await dbAllTodos();
      assert.equal(before.every((r) => r.completed === false), true, "baseline: nothing completed");

      const asUserId = c.actor();
      const { body } = await tc.runHttp(M_UPDATE, {
        ...(asUserId != null ? { asUserId } : {}),
        variables: { w: [["id", "=", targetId]], s: { completed: true } },
      });

      const after = await dbAllTodos();

      if (c.outcome === "applied") {
        assert.equal(body.errors, undefined);
        assert.equal(body.data.updateTodos.length, 1);
        const returned = body.data.updateTodos[0];
        assert.equal(Number(returned.id), targetId);
        assert.equal(returned.completed, true);

        // DB cross-read: target flipped, all others untouched.
        assert.equal((await dbTodoById(targetId)).completed, true);
        for (const orig of before.filter((r) => r.id !== targetId)) {
          const still = after.find((r) => r.id === orig.id);
          assert.deepEqual(still, orig, `unrelated row #${orig.id} mutated by update`);
        }
        assert.equal(after.length, 4, "no row added or removed");
      } else if (c.outcome === "zero") {
        // Rule narrows the WHERE; the resolver returns zero rows without an
        // error, and nothing in the table has changed.
        assert.equal(body.errors, undefined);
        assert.deepEqual(body.data.updateTodos, []);
        assert.deepEqual(after, before, "table mutated despite zero-match update");
      } else {
        assertDenied(body, "updateTodos", c.name);
        assert.deepEqual(after, before, "table mutated on denied update");
      }
    });
  }

  // The framework's update path doesn't post-check the mutated row against
  // the role's domain (insert does, update doesn't), so a demo user CAN
  // flip `assigneeId` to another user. That mutation succeeds — but the
  // read-side record rule must then filter the row out of the original
  // user's view, and surface it for the new assignee. This test enforces
  // that read-side consistency.
  it("demo who reassigns their todo to another user immediately loses read access to it", async () => {
    const targetId = tc.seed.todos["alice-1"].id;

    // Baseline: Alice currently sees alice-1.
    const before = await tc.runHttp(Q_TODOS, { asUserId: tc.seed.alice.id });
    assert.ok(
      before.body.data.todos.some((t: any) => Number(t.id) === targetId),
      "baseline: Alice should see her own todo before the reassignment",
    );

    // Alice reassigns alice-1 to Bob via update.set.assigneeId.
    const upd = await tc.runHttp(M_UPDATE, {
      asUserId: tc.seed.alice.id,
      variables: { w: [["id", "=", targetId]], s: { assigneeId: tc.seed.bob.id } },
    });
    assert.equal(upd.body.errors, undefined);
    assert.equal(upd.body.data.updateTodos.length, 1);

    // DB ground truth: the row's owner really did change.
    assert.equal((await dbTodoById(targetId)).assigneeId, tc.seed.bob.id);

    // Alice's view: the row must be filtered out by the read rule (it's no
    // longer assigned to her). The remaining 3 ids must all belong to her —
    // checked indirectly by id absence + length.
    const aliceAfter = await tc.runHttp(Q_TODOS, { asUserId: tc.seed.alice.id });
    assert.equal(aliceAfter.body.errors, undefined);
    assert.equal(
      aliceAfter.body.data.todos.some((t: any) => Number(t.id) === targetId),
      false,
      "Alice still sees the reassigned todo — read rule did not narrow on the new assigneeId",
    );
    assert.equal(aliceAfter.body.data.todos.length, 1, "Alice should only see alice-2 now");

    // Bob's view: the row must now appear in his list (3 rows: bob-1, bob-2, the reassigned alice-1).
    const bobAfter = await tc.runHttp(Q_TODOS, { asUserId: tc.seed.bob.id });
    assert.ok(
      bobAfter.body.data.todos.some((t: any) => Number(t.id) === targetId),
      "Bob should see the reassigned todo in his list",
    );
    assert.equal(bobAfter.body.data.todos.length, 3);
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe("todos.delete — cross-actor isolation", () => {
  type Outcome = "deleted" | "zero" | "denied";
  const cases: Array<{
    name: string;
    actor: () => number | undefined;
    target: () => number;
    outcome: Outcome;
  }> = [
    { name: "demo → own row: returns 1, row gone, others intact",  actor: () => tc.seed.alice.id, target: () => tc.seed.todos["alice-2"].id, outcome: "deleted" },
    { name: "demo → other's row: returns 0, target survives",       actor: () => tc.seed.alice.id, target: () => tc.seed.todos["bob-1"].id,   outcome: "zero" },
    { name: "manager → any row: returns 1, row gone",               actor: () => tc.seed.carol.id, target: () => tc.seed.todos["bob-1"].id,   outcome: "deleted" },
    { name: "anonymous: denied, every row survives",                actor: () => undefined,         target: () => tc.seed.todos["alice-1"].id, outcome: "denied" },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const targetId = c.target();
      const before = await dbAllTodos();
      assert.equal(before.length, 4, "baseline");

      const asUserId = c.actor();
      const { body } = await tc.runHttp(M_DELETE, {
        ...(asUserId != null ? { asUserId } : {}),
        variables: { w: [["id", "=", targetId]] },
      });

      const after = await dbAllTodos();

      if (c.outcome === "deleted") {
        assert.equal(body.errors, undefined);
        assert.equal(body.data.deleteFromTodos.length, 1);
        assert.equal(Number(body.data.deleteFromTodos[0].id), targetId);
        assert.equal(after.length, 3, "exactly one row removed");
        assert.equal(after.find((r) => r.id === targetId), undefined);
        // Surviving rows match their pre-delete state exactly.
        for (const orig of before.filter((r) => r.id !== targetId)) {
          const still = after.find((r) => r.id === orig.id);
          assert.deepEqual(still, orig, `unrelated row #${orig.id} mutated by delete`);
        }
      } else if (c.outcome === "zero") {
        assert.equal(body.errors, undefined);
        assert.deepEqual(body.data.deleteFromTodos, []);
        assert.deepEqual(after, before, "table mutated despite zero-match delete");
      } else {
        assertDenied(body, "deleteFromTodos", c.name);
        assert.deepEqual(after, before, "table mutated on denied delete");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// ACCESS RIGHTS — table-level deny
// ---------------------------------------------------------------------------

// Demo and manager have grants on `todos` only — neither has a grant on
// `users`, so a top-level `users` query must be rejected for both.
describe("todos — table-level access denial", () => {
  const cases = [
    { name: "demo cannot read users",    actor: () => tc.seed.alice.id },
    { name: "manager cannot read users", actor: () => tc.seed.carol.id },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const { body } = await tc.runHttp(`query { users { id name } }`, {
        asUserId: c.actor(),
      });
      assertDenied(body, "users", c.name);
    });
  }
});

// ---------------------------------------------------------------------------
// SAVEPOINT ROLLBACK
// ---------------------------------------------------------------------------

// Two intentionally-paired tests: the invariant is that the per-test
// SAVEPOINT rolls back BETWEEN tests, so merging them would defeat the
// point.
describe("todos — savepoint rollback between tests", () => {
  it("an insert in this test is visible inside this test", async () => {
    const { body } = await tc.runHttp(M_INSERT, {
      asUserId: tc.seed.alice.id,
      variables: { v: [{ title: "ephemeral", assigneeId: tc.seed.alice.id }] },
    });
    assert.equal(body.data.insertIntoTodos.length, 1);
    assert.equal(body.data.insertIntoTodos[0].title, "ephemeral");
    assert.equal((await dbAllTodos()).length, 5);
  });

  it("the next test does not see the previous insert (rolled back)", async () => {
    const found = await tc.sudoDb
      .select()
      .from(tc.schema.todos)
      .where(eq(tc.schema.todos.title, "ephemeral"));
    assert.equal(found.length, 0);
    assert.equal((await dbAllTodos()).length, 4);
  });
});
