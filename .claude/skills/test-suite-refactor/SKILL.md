---
name: test-suite-refactor
description: |
  Refactors an existing TypeScript test suite to remove redundancy and increase signal by scanning and grouping tests by feature/flow, merging highly similar cases (prefer table-driven tests), removing unnecessary or assertion-free tests only when coverage is preserved, detecting and filling assertion gaps for every row/record created or mutated by the test (all key fields, relations, counterparts, and isolation), strengthening assertions around business outcomes and side effects, and favoring end-to-end functional coverage while keeping readability, determinism, and debuggability. Use when the user asks to deduplicate, merge, prune, strengthen, or audit assertions in tests.
---

# Test suite refactor (dedupe + strengthen)

This skill is for improving an **existing** test suite (not writing tests from scratch): reduce duplication, keep coverage, and increase assertion quality.

It is calibrated for this repo’s stack:

- Node’s built-in test runner (`node:test`) via `tsx`
- GraphQL schema builder tests that execute queries/mutations end-to-end
- Drizzle + SQLite (often in-memory or temp-file DBs)

## Operating principles

- Prefer **fewer, higher-signal** tests over many fragmented ones.
- **Preserve coverage first**; only remove tests when their intent is fully covered elsewhere.
- Merge aggressively only when it does not harm **readability** or **debuggability**.
- Tests must validate **behavior and outcomes**, not implementation details.
- Keep tests **deterministic**: stable data, explicit assertions, no reliance on incidental side effects.
- When tests touch RBAC/record rules, assert both **allow** and **deny** boundaries explicitly.

## Workflow (use this order)

### 1) Inventory and group tests

Scan all tests in the target module(s) and produce a quick index. For each test, capture:

- **Feature**: user-facing/business area (e.g. “GraphQL filters”, “FK relation promotion”, “RBAC row rules”)
- **Functional flow**: end-to-end scenario (input → processing → output + side effects)
- **Invariant**: the business/contract rule the test proves
- **Setup shape**: DB seeding + schema builder wiring
- **Assertions**: what is asserted (and what is missing)

Use this compact index template:

```markdown
| Test | Feature | Flow | Invariant | Setup | Assertions (current → needed) |
|------|---------|------|-----------|-------|-------------------------------|
| filters__inArray | filters | query(where=inArray) | returns only matching rows | seed 3 todos | asserts ids only → add count + full row fields |
```

Group tests by:

- Feature (top-level)
- Functional flow (scenario)
- Invariant (contract/business rule)

### 2) Detect redundancy (high-confidence matches)

Mark tests as candidates for merging/removal when they are:

- Same flow, same invariant, only different constants
- Same invariant, tested multiple times via slightly different setup paths but asserting the same thing
- Setup-heavy tests with minimal or trivial asserts
- “Does not throw/crash” tests with no meaningful assertions

Practical heuristics:

- If two tests have the same arrange/act shape and differ mainly in literals, they are usually **table-driven** candidates.
- If a test’s asserts are a strict subset of another test’s asserts for the same flow, it is usually redundant.

### 3) Merge redundant tests (without over-merging)

Merge when tests differ only by input data but validate identical behavior.

Preferred merge patterns in `node:test`:

- **Table-driven single test**: iterate cases and use a clear per-case label; keep per-case assertions localized.
- **Subtests**: `await t.test(name, async (t) => { ... })` per case to isolate failures cleanly.
- **Shared helper**: extract a scenario runner helper (arrange/act) and call it from a few focused tests that assert different invariants.

Guardrails (do not over-merge):

- Do not combine unrelated invariants into one mega-test just to reduce count.
- Do not mix multiple failure modes into one test unless each is asserted explicitly and failures are easy to localize.
- Keep “big-flow” tests end-to-end, but keep edge-case tests separate when they represent a distinct contract.

### 4) Remove unnecessary tests (coverage-safe deletions)

Delete a test only if:

- Its invariant is asserted elsewhere in the same flow, and
- The remaining tests would fail if the behavior regressed, and
- The deleted test does not cover a unique edge case or boundary.

Always keep tests that cover unique:

- Edge cases (nulls, empty lists, limit/offset boundaries, zero rows, multi-row ordering ties)
- Security/access-right boundaries (deny paths are first-class coverage)
- Regression fixes (when linked to a known bug pattern) if they add distinct coverage

### 5) Strengthen assertions (make tests prove something)

Each test should assert at least one **business outcome** and, when applicable, a **side effect**.

Assertion types to prefer:

- **Correctness**: exact returned rows, ordering, pagination behavior, updated/deleted counts
- **Side effects**: rows inserted/updated/deleted; relation integrity preserved; sessions/todos linked properly
- **Error shape**: for deny/invalid input, assert the **error class/message shape** (don’t only assert “throws”)
- **No unintended changes**: unrelated rows unchanged when that matters (isolation)

Anti-patterns to eliminate:

- “It runs” tests with no asserts
- Asserting internal/private implementation artifacts
- Asserting only that a row exists without asserting its **key fields/relations**

### 5a) Detect and fill assertion gaps (systematic pass)

Most low-signal tests don’t miss *all* assertions — they assert one field and skip the rest.
Run this pass over every test that creates or mutates records.

Rule of thumb: for every **row** a test causes to exist or change, assert the **full identifying tuple** of business-relevant fields — not just one.

Gap detection procedure (per test):

1. Enumerate every row the test causes to exist or change (walk the “act” step).
2. For each row/table, list its **core fields** + **relation keys**.
3. Compare to what the test asserts. Missing fields = gaps.
4. Assert **cardinality** first (`count`), then assert full tuples.
5. Assert **counterparts** and **links** (FKs, inverse relations, join traversal) when the test’s flow implies them.
6. Assert **isolation** where the invariant claims “only X changed”.

#### Assertion-gap audit table (add to the inventory output in step 1)

```markdown
| Test | Row(s) affected | Fields currently asserted | Fields missing |
|------|------------------|---------------------------|----------------|
| insertTodo | todos(1) | id only | title, assigneeId, createdAt shape, FK exists |
| relationPromotion | users(1), todos(2) | nested names only | todo count, todo.user_id linkage, no extra rows |
```

Fill the “missing” column **before** merging tests — don’t merge two weak tests into one slightly less weak test.

#### Row-level checklist (generic, applies broadly)

- **Count**: if you expect one row, assert it’s one row (don’t index into arrays without checking length).
- **Primary identity**: `id` (or composite key), plus any human-meaningful identifier asserted by the invariant.
- **Scope**: owner/tenant/user scope when relevant (e.g. `assigneeId`).
- **All fields touched by the mutation**: set fields match expected values; untouched fields remain expected.
- **Relations**:
  - Forward FK: `todo.assigneeId === user.id`
  - Inverse relation: user’s `todos` includes the right ids and excludes others
- **Ordering/pagination**: if `orderBy/limit/offset` is used, assert the returned order and length.
- **Negative assertions**: verify excluded rows truly excluded (especially for filters and RBAC).

#### GraphQL-specific checklist (this repo)

- **Query shape**: assert the response shape (data present, errors absent) for success cases.
- **Error cases**: assert `errors` exists and message/category is stable enough to be meaningful (avoid brittle full-string matches if messages include dynamic ids).
- **Column-vs-relation rule**: when a column is replaced by a relation field on output types, assert the expected behavior:
  - Column is still usable in `where`/`set` inputs
  - Output traverses via the relation field (and does not expose the scalar in the same name)
- **Relations**: when testing relation traversal, assert both:
  - Link correctness (the joined row is the intended one)
  - Cardinality (no duplicates; expected number of children)
- **Mutations**: assert returned rows match DB state (not only that mutation returned “something”).

### 6) Prefer end-to-end functional coverage

Prefer tests that follow the real functional flow:

- Input: realistic seed data and operations
- Processing: execute through GraphQL (or the public API under test), not internal helpers
- Output: verify returned results
- Side effects: verify DB artifacts and relations

If a flow has multiple critical checkpoints, assert intermediate steps too (but keep them tied to business meaning).

### 7) Naming and structure

Use intention-revealing names. Recommended structure per test:

- Arrange: minimal setup, reuse fixtures/helpers
- Act: one primary action (or one coherent flow)
- Assert: outcomes + side effects

Naming patterns:

- `test_<feature>__<scenario>__<expected_outcome>`
- `test_<feature>__<edge_case>__<invariant>`

## Deliverable format (what to output after refactor)

When finishing a refactor, produce:

- List of merged tests (old → new)
- List of deleted tests with justification (“coverage preserved by X”)
- List of assertion upgrades (what invariants are now explicitly proven)
- Any new helpers/table-driven structures (and where they live)
- How you verified (e.g. `npm test`)

## Quick checklist

- [ ] All relevant test files scanned
- [ ] Tests grouped by feature/flow/invariant
- [ ] Assertion-gap audit run: every affected row has cardinality + full field tuple + relation links + isolation checks asserted
- [ ] No “silent tests” remain
- [ ] Redundant tests merged via table-driven tests or shared helpers (only after gaps are filled)
- [ ] Deletions are coverage-safe
- [ ] Assertions validate outcomes + side effects
- [ ] End-to-end flows covered holistically
- [ ] Names are intention-revealing and structure consistent
