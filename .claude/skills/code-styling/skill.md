---
name: framework-style-review
description: Review TypeScript/JavaScript framework or library code for the surface-polish a third party would expect — naming (variables, types, exports, files, generics), JSDoc completeness on the public API, import ordering, export discipline, barrel-file health, error-message consistency, `readonly`/`const` usage, `as any` policing, and arrow-vs-function-declaration consistency. Use this skill whenever the user asks to "review style", "review naming", "polish this", "is this idiomatic", "framework style review", "naming review", checks "professional/library quality", asks if a package is ready for external consumers, or pastes framework/library code asking what a maintainer-handover review would catch. Use it even when the user doesn't say "style" — if the intent is library-grade polish or readiness audit rather than business-logic correctness, this skill applies. Do NOT use for business-logic bugs, security, performance, architecture, or test coverage — those go to other skills.
---

# Framework Style Review

You are reviewing TypeScript/JavaScript framework or library code for the kind of polish a third-party consumer would notice on day one. This is a **style and surface review**, not a logic, security, performance, or architecture review. Stay in your lane — if you spot a logic bug, note it once at the end as out-of-scope, but don't dig in.

The user has asked because their code works but they want it to *look* like a library a stranger would happily depend on. Your goal is to make a concrete, prioritized list of changes they can act on in an afternoon.

## What "framework style" means here

Framework code is read by people who didn't write it, often years later, often in IDEs that surface only the name and the JSDoc. That gives you the bar:

- **Names carry the API.** A name that's ambiguous, abbreviated, or inconsistent with siblings is a real defect — even if the code runs fine.
- **JSDoc is the contract.** If a public export has no JSDoc, the consumer's only documentation is the type signature. For a real framework that's not enough.
- **Internals must stay internal.** Anything reachable from the package root (`index.ts` / barrel files) is a permanent public API commitment. A leaked helper is a future breaking change.
- **`as any` is a debt marker.** Each instance is a place where types stopped helping. Some are unavoidable (e.g. reaching into another lib's internals) but they should be rare, localized, and commented.
- **Errors are part of the API surface.** Inconsistent error-message phrasing makes the package feel hand-rolled.

Internalize the bar before you start reading. Don't apply a single style template — read the existing code and decide whether the package already has a consistent convention. If it does, defend it. If it doesn't, propose the most idiomatic one for the ecosystem (TypeScript ESM library, in most cases).

## Scope

**In scope:**
- Identifier naming (variables, parameters, types, type parameters, files, directories, exports).
- JSDoc presence, completeness, and consistency on public exports (everything reachable from the package root barrel).
- Import ordering and grouping (external → internal → relative; type imports separated).
- Export discipline: explicit named re-exports vs. `export *`, leaked internals, missing re-exports of types alongside values.
- Barrel-file (`index.ts`) health: duplication, missing exports, surprising omissions, dead re-exports.
- Error-message phrasing (capitalization, punctuation, voice, prefixing) and Error subclass usage.
- `readonly` on properties and arrays where the contract is read-only; `const` on locals that are never reassigned.
- `as any` and `as unknown as X` usage — flag every instance, recommend narrowing.
- Arrow function vs. `function` declaration consistency; default-export vs. named-export consistency.
- Type-only imports/exports (`import type`, `export type`) where applicable.
- Public API ergonomics: option-object shapes, optional-field defaults documented, return-type shapes that read clearly in IDE tooltips.

**Out of scope** (mention once at the end if obvious, then stop):
- Business logic bugs, race conditions, data-handling mistakes.
- Security issues — defer to `security-review`.
- Performance — defer elsewhere.
- Architectural decomposition or module boundaries — defer to `refactor` or `code-quality-review`.
- Test coverage or test quality — defer to `test-suite-refactor`.

If the user explicitly asks for one of these *alongside* style, do the style portion and politely point at the better-fit skill for the rest.

## Workflow

1. **Identify the package boundary.** Where is the public API? Usually `<package>/src/index.ts` plus any sub-path entries in `package.json` `exports`. Read that file first — it tells you what's public.

2. **Read the public surface fully.** Every file directly re-exported from the barrel. Then sample 2–4 internal files to gauge consistency. You don't need to read every file in a large package; you need enough to spot patterns.

3. **Note the package's existing conventions** before judging. If the package uses `camelCaseFile.ts`, don't recommend `kebab-case-file.ts` mid-package — recommend it as a future migration or stay consistent. The bar is *internal consistency first*, *ecosystem idiom second*.

4. **Collect findings into the categories below.** Use file:line citations — they're cheap to add and the user will jump to them.

5. **Rank by severity** (see scale below). Group within each severity by category.

6. **Output the report** using the template at the end.

7. **Offer to apply the fixes.** Don't apply without asking. When the user agrees, apply them as behavior-preserving edits — no logic changes, no error-message *content* changes beyond phrasing/punctuation unless the user signs off. Run the test suite after.

## Severity scale

- **HIGH** — Public API leak, missing JSDoc on a public export, `export *` leaking internals, `as any` in the public type surface, naming inconsistency that will confuse consumers in IDE tooltips, default-export of something that should be named (or vice versa per package convention).
- **MEDIUM** — `as any` in internals without comment, JSDoc that documents `what` instead of `why`, inconsistent error-message style across the package, mixed arrow/function declarations within the same file, missing `readonly` on properties of a frozen value or `Readonly<T>` on a value-object return.
- **LOW** — Import ordering, file-name casing inconsistency, single-letter type parameters that could be more descriptive, locals that could be `const`, redundant JSDoc on internal helpers.

Don't pad the report with LOW items if the package already does this well — only include LOWs when there are enough to be worth fixing in one sweep.

## Naming heuristics (apply judgment, not rules)

These are starting points, not absolutes. Defer to the package's existing convention if it has one.

- **Variables / parameters**: `camelCase`. Single letters only for indices, math, or generic-parameter-like roles. Avoid Hungarian (`strFoo`, `arrItems`).
- **Types / interfaces / classes**: `PascalCase`. Prefer `User` over `IUser`. Don't suffix types with `Type` unless disambiguating a value/type collision.
- **Type parameters**: `T`, `U`, `K`, `V` are fine for general containers; for domain generics prefer descriptive `TUser`, `TRow`, `TSchema` so they read in tooltips.
- **Files**: pick `kebab-case.ts` *or* `camelCase.ts` and hold it across the package. Test files mirror source (`foo.ts` → `foo.test.ts`).
- **Constants**: `SCREAMING_SNAKE_CASE` for true module-level immutables, `camelCase` for everything else (including configuration objects).
- **Booleans**: positive phrasing — `isReady`, `hasUser`, `canCreate`. Avoid `isNotReady` or `disableFoo`.
- **Function names**: verb-first for actions (`buildSchema`, `parseInput`), noun-first for getters/derivations (`schemaFor`, `userById`).
- **Acronyms**: `userId` not `userID`, `JsonValue` not `JSONValue`, `dbClient` not `DBClient` — TypeScript ecosystem convention. Follow the package's existing choice.

## JSDoc rules of thumb

- Every public export gets at least a one-line summary.
- Multi-line summaries: a `Summary` line, a `Typical Flow` / `Typical Usage` if non-obvious, and a `Notes` / `Caveats` section if there are footguns.
- `@param` only when the name doesn't tell you the meaning (skip `@param name The name`).
- `@returns` only when the return type alone is ambiguous (e.g. tuples, discriminated unions).
- `@example` is gold on top-level exports — one realistic snippet beats three paragraphs of prose.
- For options-bag fields, document defaults inline: `@default 10`.

## `as any` policy

Each `as any` is either:
- **Justifiable** (reaching into a third-party lib's internals, framework boundary, ambient context). → Wrap in a named helper, comment why, pin the lib version assumption.
- **Lazy** (used to silence the compiler in own code). → Replace with a real narrowing (`unknown` + type guard, `satisfies`, or a proper generic).

Flag every instance. Recommend the wrap-and-name pattern when 3+ casts touch the same surface.

## Report structure

Use this exact template:

```markdown
# Framework style review — `<package-name>`

## Scope reviewed
- Public surface: `<barrel path>` plus <N> files (<list or count>).
- Internal sample: <N> files.

## Strengths (1–4 bullets)
Lead with what's already good — names already consistent, JSDoc patterns to preserve, etc. Be specific and brief.

## Findings

| Sev | Category | Where | Problem | Fix direction |
|---|---|---|---|---|
| HIGH | <category> | `file.ts:LL` | <one sentence> | <one sentence> |
| ... | ... | ... | ... | ... |

(Group rows by severity, then by category within severity.)

## Suggested commit boundaries
If applied, propose 2–4 logical commits that group the fixes:
1. `style: <theme>` — <files>
2. `docs: <theme>` — <files>
3. ...

## Out of scope (noted, not actioned)
Brief one-line mentions of anything you saw that's logic/security/perf/architecture/tests. Defer to the appropriate skill.

## Next step
Offer to apply the fixes. Ask: "Want me to apply the HIGH + MEDIUM items as a single commit, or split by category?"
```

## When applying fixes

Once the user confirms:

1. **Behavior preservation.** Pure renames, JSDoc additions, import reorderings, `as any` narrowings that don't change runtime behavior. Don't change error-message *content* unless the user signed off — only phrasing/punctuation if you flagged it.
2. **Rename safely.** Renaming a public export is a breaking change. Either preserve a re-export under the old name (mark `@deprecated`) or confirm with the user first.
3. **Run the test suite.** Every applied batch ends with `npm test` (or the package's test command). If it fails, stop and report — don't power through.
4. **Commit at the proposed boundaries.** Use the conventional-commit prefixes (`style:`, `docs:`, `refactor:`) unless the repo uses a different convention.

## Anti-patterns to avoid in your review

- Don't write "this should be camelCase" without checking what the rest of the file uses. Internal consistency wins.
- Don't recommend a popular style guide wholesale ("apply Airbnb style"). Pick the specific deltas that matter.
- Don't flag every missing JSDoc on a 50-file package — sample the public surface and call out the *pattern*, not every instance, unless there are fewer than ~15.
- Don't reframe a logic bug as a style issue to fit your scope. Note it as out-of-scope.
- Don't produce an unprioritized wall of findings. The prioritized table is the deliverable.
- Don't apply fixes without asking, no matter how trivial they seem.

## Example finding rows (for tone reference)

| HIGH | export discipline | `index.ts:34` | `export * from "./internal/utils.js"` leaks 12 helpers as permanent API. | Replace with explicit named re-exports of only `formatDate` and `parseDuration`. |
| HIGH | JSDoc | `client.ts:18` | `createClient` (the main entry point) has no JSDoc. | Add module-level summary + `@example`. |
| MED | naming | `builder.ts:204` | Type parameter `T` on `buildSchema<T extends Schema>` reads as `T` in IDE tooltips — opaque for a public entry point. | Rename to `TSchema`. |
| MED | `as any` | `rbac.ts:74,77` | Two casts to access Drizzle column internals (`generated`, `notNull`). | Extract `drizzle-internals.ts` with `isGenerated(col)` / `isNotNull(col)` typed wrappers. |
| MED | errors | `auth.ts:88, session.ts:42` | One throws `"invalid token"` (lowercase), the other `"Token expired."` (sentence with period). | Pick one convention (lowercase, no period is most common in JS libs) and apply. |
| LOW | imports | `app.ts:1-12` | External and relative imports interleaved. | Group: external → internal aliases → relative; blank line between groups. |
