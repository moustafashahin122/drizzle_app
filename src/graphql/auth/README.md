# `graphql/auth` — authentication surface

Hand-rolled `register` / `login` / `logout` mutations and a `me` query, plus
the server-side helpers that resolve a request's session into an `AuthContext`.
Plugs into the auto-generated schema through the `extraQueryFields` /
`extraMutationFields` hooks on `buildSchema`.

## Files

| File          | Role                                                                          |
|---------------|-------------------------------------------------------------------------------|
| `auth.ts`     | Resolvers, session helpers, cookie helpers, `AuthContext` type.               |
| `auth.test.ts`| End-to-end exercise of the auth resolvers against an in-memory SQLite schema. |

## Public API

```ts
import {
  buildAuthExtensions,
  resolveSessionFromHeader,
  resolveSessionFromToken,
  extractBearerToken,
  parseSessionCookie,
  buildSessionCookie,
  buildClearSessionCookie,
  SESSION_COOKIE_NAME,
  type AuthContext,
} from "./graphql/auth/auth.js";
```

- `buildAuthExtensions(db, { users, sessions })` →
  `{ extraQueryFields, extraMutationFields }` to spread into `buildSchema`'s
  options. Adds `Query.me`, `Mutation.register`, `Mutation.login`,
  `Mutation.createUser`, `Mutation.logout`, plus the `AuthPayload` object type.
- `resolveSessionFromHeader(db, schema, authorizationHeader)` /
  `resolveSessionFromToken(db, schema, token)` — resolve a request's bearer
  token (or any session token source) into `{ user, session }`. Used in
  `server.ts` to populate the Yoga request context.
- Cookie helpers — produce/consume the `sid` cookie (HttpOnly, SameSite=Lax,
  7-day Max-Age). `register` / `login` / `logout` call them via the
  `setSessionCookie` / `clearSessionCookie` callbacks on `AuthContext`.

## Sessions

Login (and register) issues a 32-byte hex token persisted in the `sessions`
table with a 7-day **sliding** expiry — every successful resolution refreshes
`expiresAt`. The client sends the token in either:

- `Authorization: Bearer <token>` — works for any client (curl, GraphiQL with a
  custom header, native apps).
- The `sid` cookie — same-origin browser clients (e.g. GraphiQL on the same
  host) get this for free after `login` / `register`.

`server.ts` checks the bearer header first, then falls back to the cookie.

## Why `GraphQLError`?

Yoga's default error shield masks plain `Error` instances as
`"Unexpected error"`. The resolvers throw `GraphQLError` with explicit
`extensions.code` (`BAD_USER_INPUT`, `UNAUTHENTICATED`) so the client receives
the actual message and can branch on it.

## Relationship to the rest of the GraphQL layer

- The `register` / `login` mutations bypass RBAC by design (the `users` table
  is in `bypassResources`) — there is no caller yet, so an RBAC check could
  not succeed. `createUser` does **not** bypass: it goes through `ctx.db`
  (the RBAC-bound wrapper), which enforces `create` on `users` for the
  caller.
- `AuthContext.batch` is a per-request `Map`. The auto-builder's relation
  resolver consults this same map to coalesce relation lookups
  (`createRelationLoader`); the RBAC engine reuses it as a per-request cache
  for effective-group lookups (`getEffectiveGroups`). One map serves both.
