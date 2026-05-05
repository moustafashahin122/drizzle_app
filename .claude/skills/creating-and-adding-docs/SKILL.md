---
name: creating-and-adding-docs
description: Documentation standards for drizzle_todo_app (TypeScript, JSDoc, README). Main modules use module JSDoc with Summary, Typical Flow or Typical Usage, and Notes; supporting exports use short summaries. Functions use @param, @returns, and @example where helpful. Use when documenting src/, updating GraphQL/Drizzle behavior in README, or when the user asks to document this app.
---

# Creating and Adding Documentation (drizzle_todo_app)

This skill applies to **`drizzle_todo_app`**: Hono, graphql-yoga, GraphQL (custom schema from Drizzle tables), Drizzle ORM + SQLite (`better-sqlite3`). Source lives under `drizzle_todo_app/src/`; user-facing run and API docs live in **`drizzle_todo_app/README.md`**.

## Where docs go

| Area | Location |
|------|----------|
| App run, layout, new resources, RBAC, GraphQL/curl examples | `drizzle_todo_app/README.md` |
| GraphQL schema builder API and behavior | `drizzle_todo_app/src/graphql/buildSchema.ts` (module + exported symbols) |
| Drizzle tables and inferred types | `drizzle_todo_app/src/schema.ts` (brief table/column intent if non-obvious) |
| Resource list and RBAC wiring | `drizzle_todo_app/src/resources.ts` |
| HTTP server, Yoga context | `drizzle_todo_app/src/server.ts` |
| DB bootstrap | `drizzle_todo_app/src/db.ts` |

When behavior visible to API users changes (new fields, filters, RBAC semantics, env vars, URLs), **update README** in the same change.

## Module documentation (main vs side)

Treat **`src/graphql/buildSchema.ts`** as the **main** documentation surface: it defines the reusable schema builder. Its **file-level** JSDoc should include:

- **Summary:** What the module does and why (3–5 lines). Use `{@link TypeName}` for key types (`ResourceDef`, `RBAC`, `Ctx`, `buildAppSchema`).
- **Typical Flow** *or* **Typical Usage:** Either the end-to-end flow (define resources → build schema → mount → per-request `Ctx`) *or* how integrators plug in tables and RBAC—no code blocks in this section if it reads as prose; code belongs in README or `@example`.
- **Notes:** Only when necessary (ordering/duplicate fields, filter semantics, security caveats).

**Side** modules (`server.ts`, `resources.ts`, `schema.ts`, `db.ts`) should not repeat the builder’s long flow. A short **Summary** (and optional **Notes** for that file only) is enough; point to `buildSchema.ts` or README for full behavior.

## Exported types and constants

- **`export type` / `export interface`:** One or two lines in a JSDoc on the symbol; list fields only when names are not self-explanatory or invariants matter (e.g. RBAC `read` merged into WHERE).
- **Prefer `{@link}`** to tie `Ctx`, `RBAC`, and `ResourceDef` together instead of duplicating prose.

## Function documentation (JSDoc)

For **exported functions** (e.g. `buildAppSchema`) and any non-obvious **internal** helpers:

- **Summary:** What it does in one sentence.
- **`@param`** for each parameter (name, intent, constraints).
- **`@returns`** for the return value.
- **`@example`** for integrator-facing or non-obvious usage (omit for trivial test-only code).

Use TypeScript types in signatures; JSDoc may repeat intent, not every type detail.

### Example (exported function)

```ts
/**
 * Builds a GraphQL schema with Query/Mutation roots from the given resources.
 *
 * @param db Drizzle instance with select/insert/update/delete supporting returning/get/all.
 * @param resources Resource definitions; order matters for duplicate GraphQL field names.
 * @returns Executable GraphQL schema for graphql-yoga or other servers.
 *
 * @example
 * const schema = buildAppSchema(db, resources);
 */
export function buildAppSchema(db: unknown, resources: ResourceDef[]): GraphQLSchema { ... }
```

## What to document lightly

- **GraphQL `resolve` callbacks** that only call Drizzle and RBAC hooks: no full template unless logic is non-obvious; the module JSDoc covers behavior.
- **One-line utilities** (`cap`, `uncap`, scalar mappers): a single-line JSDoc or omit if obvious from names + types.
- **Drizzle column definitions** in `schema.ts`: default to no per-column essays; add a line only for subtle modes (e.g. boolean stored as integer).

## Agent workflow

1. Identify whether the change is **user-visible** (HTTP, GraphQL shape, RBAC, setup). If yes, update **`README.md`** (examples, defaults, env vars).
2. Classify the file as **main** (`graphql/buildSchema.ts`) or **side** (everything else under `src/`). Apply the matching depth; avoid duplicating the main module’s Typical Flow on side files.
3. For new **exports**, add JSDoc with `@param` / `@returns` / `@example` as appropriate; use `{@link}` to related types.
4. Match existing tone: concise, technical, ESM paths in prose (`./graphql/buildSchema.js` in imports is project convention for emitted imports).
5. Do not strip existing **Notes** or README sections that still apply; extend or adjust them when behavior changes.
