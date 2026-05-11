---
name: test-suite-refactor
description: |
  Refactors an existing TypeScript test suite in this repo to remove redundancy and increase signal: scan and group tests by feature/flow/invariant, merge near-duplicates (prefer table-driven cases under `node:test`), delete coverage-redundant or assertion-free tests only when coverage is preserved, run a per-row assertion-gap audit (cardinality, full field tuples, FK + inverse relations, isolation), and strengthen assertions around business outcomes and side effects. Calibrated for `node:test` + better-sqlite3 in-memory DBs + the custom GraphQL builder in `packages/drizzle-graphql-rbac`. Use when the user asks to deduplicate, merge, prune, strengthen, or audit assertions in tests.
---

# Test suite refactor (dedupe + strengthen)

For improving an **existing** test suite — not writing new tests. Goal: fewer tests, higher signal, same or better coverage.

## Stack assumptions (this repo)

- Test runner: Node's built-in `node:test` via `tsx`, invoked by `npm test` (runs the `drizzle-graphql-rbac` workspace).
- Assertions: `node:assert/strict` (`assert.equal`, `assert.deepEqual`, `assert.ok`, `assert.rejects`).
- DB: `better-sqlite3` in-memory (`new Database(":memory:")`) + `drizzle-orm/better-sqlite3`. Each test file builds its own minimal schema and seeds rows directly — do not import `src/db.ts`.
- GraphQL: tests execute end-to-end through `graphql({ schema, source, contextValue, variableValues })` against schemas produced by `buildSchema(...)` in `packages/drizzle-graphql-rbac/src/graphql/builder/`. Treat the GraphQL response (`data`/`errors`) as the contract under test — do not reach into builder internals.
- RBAC: built with `buildRbac(...)` from `defineRoles` / `defineAccessRights` / `defineRecordRules`. The `admin` role is framework-injected and bypasses all rules; declaring `admin` in app config throws. RBAC state is in-memory.
- Column-vs-relation rule: a single-column FK (e.g. `todos.assigneeId`) is replaced by a relation field on the **output** type. The scalar remains usable inside `where` / `set` / Insert / Update inputs.

## Operating principles

- **Fewer, higher-signal tests** beat many fragmented ones.
- **Preserve coverage first.** Only remove a test when its invariant is asserted elsewhere and would fail on regression.
- **Validate behavior and outcomes**, never builder internals.
- **Deterministic by construction**: fresh in-memory DB per test or `beforeEach` reset; no shared mutable fixtures across files; no time/random without seeding.
- **Assert both sides of every access boundary.** For RBAC/record-rule tests, allow and deny paths are both first-class coverage.

## Workflow

### 1) Inventory and group

Scan the target test files and build a compact index. For each test record: feature, flow (input → act → output + side effects), invariant proved, setup shape, and current vs. needed assertions.

```markdown
| Test | Feature | Flow | Invariant | Setup | Assertions (current → needed) |
|------|---------|------|-----------|-------|-------------------------------|
| filters__inArray | filters | query(where=inArray) | returns only matching rows | seed 3 todos | ids only → +length, +full tuple, +excluded ids absent |
```

Group by **feature → flow → invariant**. Hits in the same cell are merge candidates.

### 2) Detect redundancy

Merge candidates:

- Same flow + same invariant, differ only in literals.
- Asserts are a strict subset of another test's asserts on the same flow.
- Setup-heavy with trivial asserts (often a renamed duplicate).
- "Does not throw" tests with no behavioral assertion.

Heuristic: if two tests have identical arrange/act shape and differ in input data, they are table-driven candidates.

### 3) Merge without over-merging

Preferred patterns in `node:test`:

- **Table-driven `it`**: iterate `cases` inside one `it`, label each case, assert per case. Best when failure mode is uniform.
- **`t.test` subtests**: when per-case failure isolation matters, use `await t.test(label, ...)` so each case reports independently.
- **Scenario helper**: extract an `arrange/act` helper, keep multiple focused `it`s that each assert a distinct invariant.

Guardrails:

- Do not collapse distinct invariants into one mega-test.
- Keep edge cases that represent a separate contract (nulls, empty lists, limit/offset boundaries, RBAC deny) as their own tests.
- Big end-to-end flow tests stay intact; do not shred them into micro-tests.

### 4) Coverage-safe deletion

Delete only when **all** hold:

- Invariant is asserted elsewhere in the same flow.
- The remaining suite would fail if the behavior regressed.
- The deleted test contributes no unique edge case, security boundary, or known-regression coverage.

Always keep unique coverage of: null/empty/boundary inputs, ordering ties, `limit`/`offset` edges, RBAC deny paths, column-vs-relation behavior, and inverse-relation traversal.

### 5) Assertion-gap audit (the highest-leverage pass)

Most weak tests assert one field and skip the rest. For every test that **creates or mutates a row**, run this pass before any merging.

Procedure per test:

1. Enumerate every row the test causes to exist or change (walk the act step end-to-end, including cascades).
2. For each affected row/table, list core fields + relation keys.
3. Diff against current assertions → gaps.
4. Assert **cardinality first** (`length === N`), then full identifying tuples.
5. Assert **counterparts and links**: forward FK value, inverse relation contents, GraphQL relation traversal.
6. Assert **isolation** wherever the invariant claims "only X changed" — unrelated rows untouched, untouched columns unchanged.

```markdown
| Test | Rows affected | Asserted | Missing |
|------|---------------|----------|---------|
| insertTodo | todos(1) | id | title, assigneeId, FK resolves to user, length===1 |
| relationPromotion | users(1), todos(2) | nested names | todo count per user, inverse relation excludes other user's todos |
```

Fill gaps **before** merging. Never merge two weak tests into one slightly less weak test.

#### Row-level checklist

- **Count**: `assert.equal(rows.length, N)` before indexing.
- **Identity**: `id` (or composite key) plus any human-meaningful identifier the invariant names.
- **Scope/ownership**: `assigneeId`, tenant, or session owner when the invariant depends on it.
- **All touched fields** match expected; untouched fields remain unchanged (read back and compare).
- **Relations**:
  - Forward FK: `todo.assigneeId === user.id` at the DB level.
  - Inverse: querying the user's `todos` returns exactly the expected ids — no extras, no duplicates.
- **Ordering/pagination**: when `orderBy`/`limit`/`offset` is used, assert both order and length.
- **Negative**: rows that should be filtered out are absent (especially for `where`, record rules).

#### GraphQL-specific checklist

- **Success shape**: `assert.equal(result.errors, undefined)`, then assert `result.data` shape with `deepEqual` for small payloads or field-by-field for large ones.
- **Error shape**: assert `result.errors` length and a stable substring of the message (avoid full-string matches against messages that embed dynamic ids).
- **Column-vs-relation**: assert both halves explicitly when relevant:
  - The scalar `assigneeId` still works inside `where` / `set` / Insert / Update inputs.
  - The output traversal `assignee { id name }` returns the joined row; the scalar is **not** exposed under the same name on the output type.
- **Mutations**: cross-check the mutation's `.returning()` result against a follow-up DB read — do not trust only the GraphQL payload.
- **RBAC**: every record-rule test asserts both allow (rows visible/mutable as expected) and deny (filtered out or rejected with the expected error category). Confirm `admin` bypasses the rule in a dedicated case.

### 6) Prefer end-to-end functional coverage

Drive tests through `graphql(...)`, not internal builder helpers. Verify both the returned payload and the resulting DB state. Keep filter/order-translator unit tests (e.g. `filters.test.ts`) — they are intentional micro-tests on pure functions and should stay focused.

### 7) Naming and structure

- Arrange (minimal), Act (one coherent flow), Assert (outcomes + side effects + isolation).
- Names: `<feature>__<scenario>__<expected_outcome>` or `<feature>__<edge_case>__<invariant>`.
- Co-locate helpers in the same file or a `__helpers__.ts` sibling — do not invent new shared-fixture packages.

## Verification

After the refactor: run `npm test` from the repo root (executes the `drizzle-graphql-rbac` workspace under `node:test` via `tsx`). All tests must pass. If a test now fails because a previously-hidden gap is exposed, fix the **code** or correct the assertion — do not weaken the assertion to make it pass.

## Deliverable

Output a short report:

- **Merged**: `old → new` mapping with one-line justification each.
- **Deleted**: each removal with the test that now covers its invariant.
- **Strengthened**: per test, the invariants now explicitly proven (cardinality, full tuples, relations, isolation, deny paths).
- **New helpers / table structures**: where they live and what they encapsulate.
- **Verification**: confirm `npm test` is green and note runtime if it changed materially.

## Quick checklist

- [ ] All target test files inventoried; tests grouped by feature/flow/invariant.
- [ ] Assertion-gap audit done **before** any merging: cardinality + full tuples + forward FK + inverse relation + isolation.
- [ ] No "silent" or assertion-free tests remain.
- [ ] Merges use table-driven cases or subtests; no distinct invariants collapsed together.
- [ ] Deletions are coverage-safe and named in the report.
- [ ] Column-vs-relation behavior asserted on both input and output sides where applicable.
- [ ] RBAC tests assert allow, deny, and admin-bypass.
- [ ] `npm test` green; runtime not materially worse.
