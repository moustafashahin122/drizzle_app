# `graphql/domain` — Odoo-style domain handling

A "domain" is a polish-prefix array of leaves and operators that describes a
row predicate, e.g. `[["ownerId", "=", "current_user.id"]]`. This module
turns that data structure into a Drizzle `SQL` fragment that can be AND-ed
into any query's `where`.

The RBAC engine (`../rbac`) uses this module to evaluate record rules, but
the module is **authentication-agnostic**: callers supply a placeholder map
for any string tokens they want substituted at evaluation time. That keeps
domain handling reusable for non-RBAC use cases (e.g. saved filters,
seed-script validation, external admin UIs).

## Files

| File             | Role                                                                       |
|------------------|----------------------------------------------------------------------------|
| `domain.ts`      | Parser (`parseDomain`), translator (`domainToSql`), node + placeholder types. |
| `domain.test.ts` | Parser shape tests, placeholder substitution, null-safety, unknown-op throw. |

## Public API

```ts
import { parseDomain, domainToSql } from "./graphql/domain/domain.js";
import type {
  DomainNode,
  DomainLeaf,
  DomainPlaceholders,
} from "./graphql/domain/domain.js";
```

- `parseDomain(domainArr)` → `DomainNode` — parse a JSON-decoded domain into
  a tree. Throws on malformed input (unknown token, truncated operator,
  malformed leaf).
- `domainToSql(node, columns, placeholders)` → `SQL | undefined` — translate
  to a Drizzle fragment. Returns `undefined` when the tree contributes no
  usable predicates (so callers can drop the rule rather than emitting a
  no-op).
- `DomainNode` — discriminated union: `{ kind: "leaf" | "and" | "or" | "not", … }`.
- `DomainPlaceholders` — `Record<string, unknown>` substitution map.

## Domain syntax

```
[ "&" | "|" | "!", [field, op, value], ... ]
```

- Operators are **prefix** and consume the next 1 (`!`) or 2 (`&`, `|`)
  sub-expressions.
- The implicit combinator across remaining top-level items is `&` (AND),
  matching Odoo.
- Supported leaf operators: `=`, `!=` (alias `<>`), `>`, `>=`, `<`, `<=`,
  `in`, `not in`, `like`, `ilike`, `not like`, `not ilike`, `=?` (eq-or-null).

## Placeholders

Any string value present as a key in the supplied `DomainPlaceholders` is
substituted before the leaf is translated. Arrays are walked element-wise so
`["in", ["current_user.id", 5]]` resolves correctly.

The RBAC engine passes `{ "current_user.id": ctx.user?.id ?? null }`.
Unauthenticated callers get `null`, and leaves comparing a column to `null`
via `=` / `!=` (or `=?`) emit no SQL fragment — this is the deliberate
"safe default": a missing placeholder cannot widen access.

## Why the SQL-or-undefined return contract

`domainToSql` returns `undefined` for a tree that contributes no usable
predicates (e.g. unknown column, null-resolved placeholder). Callers
combining multiple rules — such as the RBAC engine — should treat
`undefined` as "this rule grants nothing". Combined with the OR-of-rules
semantics there, a malformed or null-bound rule does **not** widen access.

## Example

```ts
import { parseDomain, domainToSql } from "./graphql/domain/domain.js";

const node = parseDomain([
  "|",
  ["state", "=", "open"],
  ["ownerId", "=", "current_user.id"],
]);

const sql = domainToSql(node, todoColumns, {
  "current_user.id": ctx.user?.id ?? null,
});

if (sql) query = query.where(sql);
```
