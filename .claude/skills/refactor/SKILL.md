---
name: refactor
description: |
  Use this skill whenever the user asks to refactor, clean up, restructure, simplify,
  extract, inline, rename, decompose, split, dedupe, or "tighten up" existing code —
  anything where the goal is to change shape without changing behavior. Also trigger
  on phrases like "this method is too long", "this is getting messy", "DRY this up",
  "pull this out", "make this more readable", "untangle this", or when the user pastes
  code and asks for it to be improved structurally rather than functionally. Use even
  when the word "refactor" isn't said, as long as the intent is a behavior-preserving
  structural change. Do NOT use for bug fixes, new features, performance work, or
  rewriting from scratch — those have different rules.
---

# Refactor

Refactoring is changing the **shape** of code while preserving its **behavior**. The
contract with the user is: every observable thing the code did before, it still does
after. If behavior changes, it isn't a refactor anymore — stop and renegotiate.

The hard part isn't the edits. It's resisting two failure modes:

1. **Doing too much.** Mixing in feature work, "while I'm here" cleanup, or
   speculative abstractions because the file is already open. Each extra change
   blurs the diff and makes regressions harder to bisect.
2. **Doing too little verification.** Renaming a symbol without checking callers.
   Extracting a function without re-running the tests or smoke-testing the path.
   Trusting that "it looks the same" means "it behaves the same."

This skill is structured around four steps: **triage → plan → execute → verify**.
Don't skip steps even when the change feels small — the discipline is what makes
a sequence of small refactors compound into a clean codebase instead of a series
of tiny regressions.

## Step 1 — Triage

Before touching anything, name the smell in one sentence. "This function does three
things." "These three branches are nearly identical." "This name no longer matches
what the code does." If you can't name it, the user is probably asking for something
other than a refactor — clarify before you start cutting.

A few common smells and the refactors that match them:

| Smell | Likely refactor |
|---|---|
| Function does multiple unrelated things | Extract function(s); rename original to its remaining job |
| Same code in 2–3 places | Wait for the third repetition before extracting; until then, accept the duplication |
| Long parameter list, especially booleans | Introduce parameter object, or split into separate functions |
| Conditional ladder branching on a type/string tag | Replace with a lookup table or polymorphic dispatch |
| Name no longer fits | Rename — but verify all callers, including dynamic ones (string keys, reflection, tests) |
| Module/file mixes unrelated concerns | Split file along the natural seam; move types with the code that owns them |
| `any` / loose types covering up real shape | Tighten types incrementally, one boundary at a time |
| Code that's never called | Delete it (don't refactor dead code) |

If the user's request implies a deeper problem (a bug, a missing feature, a wrong
abstraction at the design level), surface that observation before refactoring. A
refactor on top of a wrong design just polishes the wrongness.

### When *not* to refactor

- The code is dead — delete it instead.
- The duplication is twofold and the two copies might diverge for real reasons.
  Wait for the third occurrence (rule of three) before generalizing.
- The user wants a feature added. Add the feature first against the current shape;
  refactor afterward only if the new code revealed a real smell.
- The code is in a hot path and the refactor has perf implications you can't measure.
- You don't fully understand what the code does. Read it, write down the behavior,
  *then* decide whether to refactor.

## Step 2 — Plan

Refactors are sequences of small, individually verifiable steps — not a single big
edit. Before changing anything, sketch the steps. Each step should:

- Preserve behavior on its own (tests/typecheck/build still pass).
- Be small enough that the diff is obvious.
- Have a clear verification gate (run X, expect Y).

Show the plan to the user before executing if it's more than ~3 steps or touches
files outside the immediate target. They may know constraints you don't (an
in-flight branch, a public API contract, a rename that breaks downstream consumers).

A useful sanity check: if you can't say *what would tell you the refactor is wrong*,
you don't have a verification plan yet. For library code, that's typically the test
suite. For a server, it's a smoke request. For a UI, it's clicking through the
flow in a browser. "It still compiles" is rarely sufficient.

## Step 3 — Execute

Apply one step at a time. After each step, run the verification you planned for
that step *before* starting the next one. This is non-negotiable — it's what makes
a broken refactor cheap to bisect (you know the last step caused it) instead of
expensive (you have to read the whole sequence).

A few rules that keep execution honest:

- **Read all callers before renaming or changing a signature.** Grep for the old
  name as a string too — dynamic callers won't show up in static analysis. Tests
  often reference symbols by string.
- **Don't change behavior to fix something you noticed mid-refactor.** Stash it,
  finish the refactor, then deal with it as a separate change. Mixed diffs are
  the single biggest source of refactor regressions.
- **Don't introduce abstractions you don't immediately use.** If you're extracting
  a helper for one caller, the helper has one caller. Don't pre-parametrize it
  for hypothetical future callers — that work belongs to the change that adds
  the second caller, when the right shape is actually known.
- **Keep the diff small per step.** If a step's diff is hundreds of lines, it's
  probably two or three steps that should have been split.
- **Stop if the verification fails and you can't immediately see why.** Revert
  the step, re-read the code, and either redo it smaller or escalate. Don't
  push through with "I'll fix it after the next step."

## Step 4 — Verify

After all steps, do a full pass:

- Diff review: read the entire change as if you didn't write it. Does anything
  surprise you? Anything you can't justify? That's a sign of accidental
  behavior change.
- Run the project's full verification — typecheck, tests, build, and (for UI
  or server work) the actual feature in a browser or via curl. Don't claim
  success on typecheck alone.
- Compare behavior at the boundaries: same inputs in, same outputs out, same
  side effects, same error shapes. Logging, metrics, and error messages count
  — if they changed, that's a behavior change and the user should know.

When you report back, lead with what was preserved and what changed structurally.
Avoid the temptation to list every line touched — the diff already shows that.
The user wants to know: "is the behavior still right, and is the new shape
better?"

## Anti-patterns

These are the failure modes I see most often. Watch for them in your own work:

- **The drive-by**: "I'll just also fix this typo / rename this variable / add
  this null check." Each one feels free; together they make the diff
  unreviewable. Stash and come back.
- **The premature abstraction**: extracting a "generic" helper from a single
  caller, parametrized for use cases that don't exist yet. The cost is real
  (indirection, wider API surface); the benefit is hypothetical. Wait for the
  second real caller.
- **The big-bang**: replacing a working module wholesale rather than evolving
  it. High risk, hard to review, and you usually rediscover the constraints
  the old code was solving — just later, in production.
- **The rename without grep**: changing a symbol's name and trusting the type
  system. String references (test names, config keys, log queries, reflection)
  don't get caught. Always grep for the old name as text.
- **The "tests pass" overconfidence**: tests cover what was tested, not all
  behavior. For changes that touch user-visible paths, run the actual path.
- **The unstated scope creep**: starting on "refactor function X" and ending
  with "I also restructured the module, renamed three files, and changed the
  config schema." If scope grows, surface it explicitly to the user before
  continuing — don't present it as a fait accompli.

## A short worked example

User says: "this `processOrder` function is getting too long, can you refactor it?"

**Triage.** Read the function. It does: validate inputs, compute totals, apply
discounts, persist, then send a confirmation email. Five distinct responsibilities
in 120 lines. Smell: **function does multiple things**. Refactor: **extract
function** along the responsibility seams.

**Plan.**
1. Extract `validateOrderInputs(order)` — pure, easiest to verify.
2. Extract `computeOrderTotals(order)` — pure, has tests already.
3. Extract `applyDiscounts(order, totals)` — pure.
4. Leave persistence + email in `processOrder` (they share a transaction).
5. Verification after each: `npm test` + `tsc --noEmit`.

**Execute.** One extraction at a time. After step 1, run verification — green.
Then step 2 — green. Step 3 — a test fails because the discount function relied
on a closure variable. Revert step 3, re-plan: pass the discounts table in
explicitly, redo step 3. Green.

**Verify.** Read the full diff. `processOrder` is now 30 lines and reads as
five named operations. No call site changed (the function's signature is
unchanged). Tests pass. Smoke-test one real order through the API to confirm
end-to-end behavior. Report: "Extracted three pure helpers; `processOrder` is
now a thin orchestrator. No behavior changes; same tests pass; one real order
flows through identically."

That's the shape. Triage names the smell, plan sequences the work into
verifiable steps, execute keeps each step honest, verify earns the right to
say "done."
