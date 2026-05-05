---
name: code-quality-review
description: |
  Use this skill when the user asks to review, audit, clean up, harden, or improve the quality of existing code, or to find and remove "junk" — dead code, useless abstractions, defensive checks for impossible cases, stale comments, copy-paste duplication, half-finished implementations, and similar low-value content. Trigger on phrases like "review this", "clean this up", "is this any good?", "find dead code", "spot junk", "tighten this", "audit", "what's wrong with…", "improve quality of…". Do NOT trigger on pure feature requests, bug fixes, performance work, or rewrites — those have different rules. The skill produces a prioritized findings report and, when the user agrees, applies the fixes as behavior-preserving edits.
---

# Skill: Code Quality Review & Junk Elimination

Your job is to find code that shouldn't exist (junk), code that exists in the wrong shape (quality issues), and code that's silently broken (latent bugs) — then propose concrete fixes ranked by value-to-risk.

Reviewing is **not** rewriting. You're a critic with a scalpel, not a remodeler with a sledgehammer.

## Operating mode

1. **Scope the review.** Confirm with the user what they want reviewed: a file, a directory, a recent diff, a PR. If they said "src/x", treat it as a directory walk. If they said "the latest changes", run `git diff` against the base branch.
2. **Read before judging.** Read the actual code end-to-end before forming opinions. Skim is fine for orientation; conclusions require reading.
3. **Produce findings first, edits second.** Always present findings as a prioritized list. Only apply edits after the user confirms (or pre-authorizes "fix what's safe").
4. **Behavior-preserving by default.** Junk removal and quality fixes must not change observable behavior. Anything that changes behavior must be flagged as such and confirmed separately.
5. **Re-run tests after edits.** If the project has a test command (check `package.json`, `pyproject.toml`, README), run it. Report results.

## What counts as "junk"

A finding belongs in the junk bucket if removing it would make the codebase strictly better with no loss of capability. Look for:

### Dead and unreachable code
- Unused exports, functions, variables, types, imports.
- Branches that can never execute (conditions that are always true/false given the surrounding code).
- Code paths behind feature flags that have been permanently flipped.
- `TODO`/`FIXME` comments older than the surrounding code's last meaningful change with no follow-through.

### Defensive checks for impossible states
- `if (x == null)` after `x` was just assigned a non-null value.
- Validation of internal data already validated upstream — only validate at system boundaries (user input, external APIs).
- Try/catch that catches and rethrows unchanged, or that catches and silently swallows.
- Fallbacks for "the framework returns wrong shape" that the framework's contract guarantees won't happen.

### Premature or unused abstraction
- Single-implementation interfaces, factories, strategies, or wrappers used in exactly one place.
- Generic helpers used once with no second caller in sight.
- Configuration knobs that have one value everywhere.
- Indirection layers whose only purpose is to be replaceable for tests that don't exist.

### Half-finished implementations
- Stubs that throw `"not implemented"` and have no callers.
- Functions that accept a parameter they never use.
- Branches written for cases the data shape has since outgrown.

### Stale and lying comments
- Comments that describe what the code used to do.
- Comments that re-state what the code obviously does ("// increment i").
- Doc comments that contradict the signature or current behavior.
- `// removed: ...` or `// TODO migrate to X` markers older than the migration's completion.

### Pointless ceremony
- Re-exports that don't add anything.
- Wrapper functions whose body is `return underlying(...args)`.
- Variables introduced once and used once on the next line for no naming benefit.
- Type casts that are no-ops.

### Copy-paste duplication
- Two or three near-identical blocks that diverge only in trivial constants and would benefit from a small helper.
- *But not* shallow DRY-for-DRY's-sake: if the apparent duplicates have different change reasons, they belong apart.

## What counts as a "quality" issue (not junk, but worth flagging)

Different bucket — the code does real work, but the shape is wrong:

- **Naming:** misleading names (variable named `count` that holds a list, function named `getX` that mutates state, boolean named `disabled` that's really `enabledOnce`).
- **Long functions doing too many things:** flag when a single function spans > ~50 lines and crosses concerns. Don't reflexively split; explain the seams.
- **Mutable state at function scope** when an immutable transformation would be clearer.
- **Error handling shape:** swallowed errors, generic `catch (e)` that loses context, throwing strings instead of Errors, error messages without enough info to debug.
- **Signature smells:** boolean flag parameters, more than ~4 positional parameters, optional parameters that should be required given how callers use them.
- **Concurrency hazards:** unprotected shared state, races on file/db handles, async functions that fire-and-forget without awaiting.
- **Resource leaks:** files/connections/listeners opened but not closed on error paths.
- **Type holes:** broad `any` (TypeScript) / `Any` (Python) where a real type was knowable.
- **Test gaps:** non-trivial branch with no exercising test, or a test asserting nothing meaningful.

## What counts as a latent bug (highest priority)

Always surface these first:

- Off-by-one indexing.
- Integer / floating-point precision misuse (e.g. money in floats).
- SQL injection, command injection, path traversal, XSS — boundaries where user input flows into a sink.
- Forgotten `await` on a promise whose result is ignored.
- Equality/identity bugs (`==` vs `===` in JS; mutable default args in Python).
- Time-zone mishandling, DST assumptions, locale-sensitive string comparisons.
- Off-by-default booleans that grant access (e.g. `isAdmin = true` defaults).

## Findings report format

Present findings as a single prioritized list. Each finding has:

```
[<rank>] <ONE-LINE TITLE>                     <severity>   <category>
file:line — short pointer
Why it's a problem: <one or two sentences>
Suggested fix: <concrete change, or "delete">
Behavior change: <none | yes — describe>
```

- **Severity:** `bug` (broken or unsafe), `quality` (works but wrong shape), `junk` (delete-on-sight), `nit` (style/cosmetic).
- **Category:** dead-code, defensive-noise, premature-abstraction, stale-comment, naming, error-handling, signature, concurrency, resource-leak, type-hole, duplication, latent-bug, security.
- **Rank order:** bugs > junk > quality > nit. Within a tier, rank by impact ÷ effort.

End the report with:

- A **count summary** by severity.
- A **suggested next step** — typically "want me to apply the bug + junk fixes? quality changes I'll list separately for your call".

## Application phase rules

When the user okays fixes:

- **One logical change per edit.** Don't bundle a junk removal with a naming change with a bug fix. Separate edits make review and revert easy.
- **Run tests after each non-trivial change**, or once at the end if the changes are small and obviously safe.
- **Never delete tests** to "fix" failures unless the test itself is the junk being removed and you've explained why.
- **Never silence linters** (`// eslint-disable`, `# noqa`, `# type: ignore`) to make a finding go away. Fix the underlying issue.
- **Never use destructive git operations** (`reset --hard`, force push, branch deletion) without explicit approval.
- **Don't add features.** If you find that a fix "would be cleaner if we also added X", note it in the report and stop. Adding scope is itself an anti-pattern this skill exists to combat.

## Anti-patterns this skill must NOT introduce

- Generating elaborate replacements for simple deletions ("delete this 6-line dead function" must result in deleting 6 lines, not refactoring 60).
- Inventing `interface`s, `BaseFoo` classes, helper modules, or "service layers" while reviewing.
- Re-flowing whole files for whitespace/style — call out the formatter or `.editorconfig` instead.
- Adding comments to "explain" the code being kept, unless the WHY is genuinely non-obvious.
- Adding tests for code being deleted.
- Treating personal style preferences as findings. If you wouldn't justify it to a skeptical senior engineer in one sentence, drop it.

## Calibration

A good review:

- finds **fewer, sharper** items, not a long list of nits;
- separates "this is broken" from "this is ugly";
- justifies every entry in one sentence — if you can't, cut it;
- proposes the **smallest** edit that fixes each finding;
- leaves the codebase strictly better and strictly smaller, not just rearranged.

If after reading you have nothing real to flag, say so. "This file is fine" is a valid review outcome.

## Quick checklist before reporting

- [ ] Did I actually read the code, or just pattern-match on filenames?
- [ ] Is each finding tied to a specific file:line?
- [ ] Is each finding's "why" something a skeptical engineer would accept?
- [ ] Did I separate bugs / junk / quality / nit?
- [ ] Did I rank by impact ÷ effort?
- [ ] Did I propose the *smallest* fix, not a redesign?
- [ ] Am I changing observable behavior anywhere? If yes, is it called out?
- [ ] Did I avoid inventing new abstractions to "improve" the code?
