---
name: security-analysis
description: |
  Use this skill when the user asks to security-review, audit, harden, or check code for vulnerabilities — explicit phrases like "security review this", "audit for vulns", "check for security issues", "is this safe?", "any auth holes?", "look for injection", "threat model this". ALSO trigger proactively (offer to run it) when the user is changing security-sensitive surfaces in this repo: auth middleware, session handling, RBAC roles/access rights/record rules, the GraphQL builder/filters/resolvers, raw SQL or new Drizzle queries, and any newly exposed Hono route or handler. Tuned for this TypeScript/Node/Hono/Drizzle/GraphQL/RBAC codebase — knows the project's specific risk surfaces (in-memory RBAC, hand-rolled GraphQL builder, FK-promoted relations, session cookies, admin dashboard). Produces a prioritized inline findings report with file:line refs and concrete fixes — does NOT apply fixes unless the user explicitly asks. Do NOT trigger on pure feature work, perf work, or generic code cleanup — those have different skills.
---

# Skill: Security Analysis

Your job is to find security weaknesses — vulnerabilities, missing authorization checks, unsafe input handling, secret exposure, and dangerous defaults — and report them as a prioritized list with concrete, minimal fixes. Be the paranoid reviewer. Assume every untrusted input is hostile and every "this can't happen" check is wrong.

This is a **review**, not a rewrite. Output is a findings report. You only apply fixes if the user explicitly asks.

## Operating mode

1. **Scope the review.** Confirm what to audit: a file, a directory, the current branch's diff (`git diff main...HEAD`), or the whole `src/` + `packages/drizzle-graphql-rbac/src/`. If the user said "this PR" or "what I just changed", run the diff. If they said "the auth flow", trace from the route in, not from imports out.
2. **Read before judging.** Read the actual code end-to-end before flagging. Many security findings depend on the surrounding context (is the input already validated? does an upstream middleware enforce auth? is the column actually reachable from GraphQL?). Pattern-matching on `req.body` without reading is how false positives are born.
3. **Trace data flow, not just keywords.** A finding is real when you can name the **source** (where attacker input enters), the **sink** (where it does damage), and the **path** between them. "Uses `eval`" without a path from user input is a code smell, not a vulnerability.
4. **Severity is about exploitability, not theory.** A SQL injection reachable only by an authenticated admin in a tool that has no other users is lower severity than a missing auth check on a public endpoint. Rank accordingly.
5. **Findings first, fixes second.** Always present the full prioritized list before touching code. Only apply edits if the user says so.

## Threat model for this app

Before listing categories, internalize what this app actually is:

- **Hono server** serving a static frontend and `POST /graphql`, plus session-cookie auth and an `/admin` dashboard.
- **In-memory RBAC** (`src/roles.ts`, `src/accessRights.ts`, `src/recordRules.ts`) — there are no RBAC tables; memberships live in process memory and are seeded on startup. The framework auto-injects an `admin` role with full bypass.
- **Hand-rolled GraphQL builder** in `packages/drizzle-graphql-rbac/src/graphql/builder/` — not the `drizzle-graphql` npm package. Auto-generates Query and Mutation root fields (`insertInto<Type>`, `update<Type>`, `deleteFrom<Type>`) for every table. **Every new table is publicly exposed via GraphQL by default**, gated only by RBAC access rights + record rules.
- **Filters** translate user-supplied `where`/`orderBy` into Drizzle SQL via `whereToSql` / `orderByToSql`.
- **FK auto-promotion**: a single-column FK becomes a forward+inverse relation field on the output type. This means traversal is automatic — `todos { assigneeId { todos { ... } } }` works and issues N+1 queries with no batching.
- **SQLite (`todo.db`)** via Drizzle and `better-sqlite3`.

What attackers can do:
- Unauthenticated: hit `POST /graphql`, hit `/auth/*`, hit static files.
- Authenticated as a low-privilege user: any GraphQL root field whose RBAC grant lets them in, with arbitrary `where`, `orderBy`, `set`, and `values` inputs, traversing relations to other tables.
- Authenticated as admin: full bypass — but you should still flag if non-admin users could *become* admin via a vulnerable path.

## What to look for (categorized)

### A. Authentication & session

- Routes that should require auth but don't — check `src/server.ts` and `packages/drizzle-graphql-rbac/src/app.ts` for the middleware wiring. Any handler registered before the auth middleware, or any route that mounts its own sub-app, is suspect.
- Session cookies: `httpOnly`, `secure`, `sameSite` set? Lifetime sane? Session ID has enough entropy? Sessions invalidated on logout AND on password change?
- Session fixation: is the session ID rotated on login?
- Password handling: hashed (bcrypt/argon2/scrypt), not MD5/SHA-1/plain? Hash work factor reasonable? Timing-safe comparison on lookup?
- Login rate limiting / lockout on repeated failures?
- "Remember me" or long-lived tokens stored where?

### B. Authorization & RBAC (this app's hottest surface)

This is where most real bugs in this codebase will live. Pay close attention:

- **Missing access rights for a new table.** When someone adds a table to `src/db.ts`, the GraphQL builder auto-exposes Query+Mutation root fields for it. If the access-rights config in `src/accessRights.ts` is not updated, the default may be open *or* may be closed — check which, and flag tables that are reachable without an explicit grant.
- **Over-broad CRUD grants.** A role that has `create`/`update`/`delete` on a table when it should only have `read`. Especially on `users`, `sessions`, or anything containing role/permission state.
- **Missing record rules.** A role can read a table but the record rule doesn't scope to "owned by current user" — so user A can read user B's rows by filtering for them.
- **Record rules applied to read but not to update/delete.** A common bug pattern: the row-level filter restricts what's visible but doesn't restrict what's mutable, so a user can `update` or `delete` rows they can't `read`.
- **Relation traversal bypassing record rules.** Because FK relations auto-resolve and resolvers issue one query per parent row, check whether RBAC applies on the *relation resolver*, not just on the root field. If `todos.assigneeId` resolves a `users` row without re-checking the user's read access to `users`, that's a privilege escalation.
- **The `admin` bypass.** Confirm that the only way to become admin is through a path the user expects (e.g., seed scripts, an admin-only endpoint). If a regular user can write to a row that determines admin status, that's a critical bug.
- **Admin dashboard endpoints** (`/admin/users/:id/roles`): is the auth check `requireAdmin`, not just `requireAuth`? Are the role-assignment endpoints idempotent and free of TOCTOU?
- **In-memory RBAC reset on restart.** Flag if any code path *persists* role assignments somewhere mutable by users (e.g., a row in a user-writable table) — that would be a privilege-escalation path across restarts.

### C. Injection & untrusted input

- **SQL injection** via Drizzle: Drizzle parameterizes when you use its query builder, but raw `sql\`...\`` template tags with interpolated user input are not safe. Flag every `sql\`...\${userControlled}...\``.
- **Filter injection through `where`/`orderBy`**: the GraphQL `where`/`orderBy` inputs are user-controlled. Check `filters.ts` (`whereToSql`, `orderByToSql`) — does it whitelist columns and operators? Can a client pass an unexpected operator, a function call, or a column name that triggers a raw SQL emission? `orderBy` is a classic foothold for column-name injection.
- **Command injection**: any `child_process.exec`, `execSync`, or shell template with user-controlled strings. Prefer `spawn` with arg arrays.
- **Path traversal**: any `fs` call where a path component comes from user input without normalization + allowlist (e.g., `path.join(uploadsDir, req.params.name)` is not safe).
- **Prototype pollution**: `Object.assign(target, userInput)` or recursive merges over untrusted JSON. Especially relevant for the `set` / `values` inputs to mutations.
- **XSS in the static frontend**: any `innerHTML = userContent`, `document.write`, or unescaped template insertion. Hono's JSX is generally safe, but check raw HTML strings.
- **GraphQL-specific**: depth/complexity limits on queries? An attacker can ask for `todos { assigneeId { todos { assigneeId { todos { ... } } } } }` and explode the query into thousands of DB hits (since resolvers don't batch). Flag the absence of a depth limit, max-aliases limit, and query cost limit.
- **Mass assignment**: when a mutation accepts an Insert/Update input, do any fields slip through that the user shouldn't be able to set (e.g., `users.role`, `users.passwordHash`, `users.id`, audit fields, `createdAt`)? The auto-generated Insert/Update types iterate the full column map.

### D. Cryptography & secrets

- Secrets in source: API keys, JWT signing keys, DB passwords, default admin credentials. Check `.env`, `appConfig.ts`, scripts, tests, and any committed config.
- Predictable randomness for security purposes: `Math.random()` for session IDs, tokens, password reset codes. Must be `crypto.randomBytes` / `crypto.randomUUID`.
- Weak hash algorithms (MD5, SHA-1) used for anything security-bearing.
- JWT or token verification that skips signature check (`verify: false`, `algorithms: ['none']`).
- Encryption used without authentication (raw AES-CBC without HMAC), or hardcoded IVs/keys.

### E. Transport, headers, CSRF, CORS

- CORS config: any `Access-Control-Allow-Origin: *` combined with credentials? Any reflection of the `Origin` header without an allowlist?
- CSRF: is the GraphQL endpoint protected against CSRF? Cookie-auth + `POST /graphql` with `application/json` is the classic combo — modern browsers' CORS preflight protects most cases, but check for `application/x-www-form-urlencoded` or `text/plain` content types being accepted (they bypass preflight). Also check the admin dashboard's state-changing endpoints.
- Security headers on responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options` / CSP frame-ancestors, `Strict-Transport-Security` (if HTTPS expected), reasonable CSP.
- Cookie flags: `Secure`, `HttpOnly`, `SameSite=Lax` or stricter for auth cookies.

### F. Information disclosure

- Verbose error messages leaking stack traces, SQL strings, file paths, or schema details to the client. GraphQL errors in particular default to including `path` and sometimes more — confirm what `formatError` strips in production.
- Introspection enabled in production (might be intentional here since this is a dev tool — flag and ask).
- Timing differences on auth endpoints that reveal whether an email exists.
- Logs that include passwords, tokens, full request bodies, or session IDs.

### G. Resource exhaustion / DoS

- Unbounded queries: no `limit` cap on GraphQL list fields. A client can ask for `todos(limit: 1000000)`.
- Unbounded `where IN` arrays.
- Recursive relation traversal with no depth/cost limit (see GraphQL note above).
- No body-size limit on JSON requests.
- Synchronous expensive work in a request handler (e.g., bcrypt at very high cost factor with no concurrency cap).

### H. Dependency / supply chain (light pass)

You're not running `npm audit`, but flag obvious things visible in `package.json`:
- Unpinned/`latest` versions on security-critical deps.
- Deprecated packages still in use (e.g., `request`, old `jsonwebtoken` versions).
- Pre-release versions of auth/crypto libs in production.

### I. Misconfiguration & dangerous defaults

- Default admin credentials in seed scripts that ship to production.
- Debug routes / introspection enabled by default.
- `NODE_ENV` not checked where it should be.
- DB file (`todo.db`) world-readable or committed to git.

## Findings report format

Use this exact template. Keep entries short and skimmable.

```
[<rank>] <ONE-LINE TITLE>                          <severity>   <category>
file:line — short pointer
Source → Sink: <attacker input> → <where it lands>   (skip if not applicable)
Why it's exploitable: <one or two sentences. Name the attacker and what they gain.>
Suggested fix: <concrete change, smallest viable. Reference the function/file.>
Confidence: <high | medium | low — drop to low if you couldn't confirm reachability>
```

- **Severity:**
  - `critical` — unauth RCE, auth bypass, privilege escalation to admin, mass data exfil reachable without auth.
  - `high` — exploitable by an authenticated low-priv user to read/modify data outside their scope, or unauth info disclosure of sensitive data.
  - `medium` — requires unusual conditions, partial impact, or defense-in-depth gaps (missing security headers, missing rate limits).
  - `low` — hardening suggestions, weak-but-not-broken practices.
  - `info` — observations worth knowing, not vulnerabilities (e.g., introspection enabled — may be intentional).
- **Category:** one of `authn`, `authz-rbac`, `injection-sql`, `injection-cmd`, `injection-path`, `xss`, `csrf`, `crypto`, `secrets`, `cors`, `headers`, `info-disclosure`, `dos`, `mass-assignment`, `graphql-depth`, `dep`, `misconfig`.
- **Rank order:** by severity first, then by exploitability × impact ÷ effort-to-exploit within a tier.

End the report with:

1. **Count summary** by severity (`critical: 2, high: 5, medium: 4, low: 7, info: 2`).
2. **Top 3 next actions** — the ones the user should fix today, with one-line rationale.
3. A one-line offer: "Want me to apply fixes for the criticals and highs? I'll list quality/medium changes separately."

## Confidence and false positives

Mark a finding `low confidence` if any of these are true — and consider whether to include it at all:

- You inferred reachability but didn't trace it end-to-end.
- The vulnerability depends on a config value you didn't read.
- You're flagging the *absence* of a defense (e.g., "no rate limit") rather than a *presence* of a bug. These belong in `medium`/`low` and should be clearly labeled as defense-in-depth, not exploits.

A finding you can't justify to a skeptical engineer in one sentence does not belong in the report. Better five sharp findings than twenty noisy ones.

## What this skill must NOT do

- **Do not apply fixes unless the user explicitly approves.** The report is the deliverable.
- **Do not run `npm audit fix`, `npm update`, or any command that mutates the lockfile** without approval — those can introduce breakage far beyond the security fix.
- **Do not invent vulnerabilities to pad the list.** Empty severity tiers are fine. "I found no critical or high issues" is a valid outcome.
- **Do not flag style/quality issues as security findings.** Use the `code-quality-review` skill for those.
- **Do not assume framework guarantees without checking.** "Hono escapes this" or "Drizzle parameterizes this" — verify by reading or by linking to the specific behavior, don't hand-wave.
- **Do not exfiltrate or commit `.env`, secrets, or DB contents** to the conversation beyond what's strictly necessary to demonstrate a finding (and if you do quote a secret, redact it).
- **Do not run destructive commands** as part of investigation: no `rm`, no `git reset --hard`, no `DROP TABLE`. Read-only commands (`grep`, `git log`, `git diff`, `cat`, `npm ls`) are fine.

## Quick checklist before reporting

- [ ] Did I scope the review correctly (diff vs full-repo vs single area)?
- [ ] For each finding, did I name source, sink, and attacker?
- [ ] Did I check whether RBAC actually applies to the path I'm worried about, or did I assume?
- [ ] Did I separate exploits from defense-in-depth gaps?
- [ ] Did I rank by severity then exploitability, not by "interesting-ness"?
- [ ] Did I propose the *smallest* fix, not a redesign?
- [ ] Did I avoid flagging style nits and pure quality issues?
- [ ] Did I redact any secrets I had to quote?
- [ ] If I had nothing real, did I say so?
