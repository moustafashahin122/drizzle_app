# PRD: RBAC System for Custom Framework (Odoo-like)

## 1. Overview

### 1.1 Purpose

Build a flexible and extensible **Role-Based Access Control (RBAC)** system that controls access to data and actions within the framework, similar to Odoo's security architecture (roles, access rights, record rules).

### 1.2 Goals

* Provide fine-grained access control for models, fields, and records
* Support multi-role assignment per user
* Allow dynamic permission evaluation at runtime
* Ensure secure-by-default architecture

### 1.3 Non-Goals

* Identity authentication (login/session)
* UI design for permission management
* Encryption or cryptographic security mechanisms

---

## 2. Background (Odoo-inspired model)

Odoo RBAC consists of:

* Users
* Roles (called "groups" in Odoo)
* Access Rights (CRUD per model)
* Record Rules (row-level security)
* Implied roles (hierarchical inheritance)

This system generalizes the same concept, but moves the role catalog,
access rights, and record rules **into TypeScript code** (three small files
per app) rather than the database. Only the `user_roles` join table is
persisted, so the admin dashboard can move users between roles at runtime
without a code change.

---

## 3. System Architecture

### 3.1 Core Components

* User (DB)
* Role (code — `defineRoles`)
* Permission / Access Rights (code — `defineAccessRights`)
* Policy / Record Rules (code — `defineRecordRules`)
* User → Role assignment (DB — `user_roles`)
* Resource (Drizzle table JS key, e.g. `"todos"`)

---

## 4. Data Model

### 4.1 User (DB)

* id
* name
* email
* active
* createdAt
* (roles via `user_roles`)

### 4.2 User → Role (DB)

`user_roles` is the only role-related table.

| Field    | Description                          |
| -------- | ------------------------------------ |
| id       | unique                               |
| user_id  | FK → users.id                        |
| role_key | string id of a role from the code config |

Role keys aren't foreign-keyed; rows referencing a role that no longer
exists in code are simply ignored when computing effective access.

### 4.3 Role (code)

Declared in `src/roles.ts` with `defineRoles({ ... })`.

```ts
defineRoles({
  admin: { isAdmin: true },
  user:  {},
  demo:  { parent: "user" },
});
```

* key (object key) — string id
* `isAdmin` (optional) — short-circuits every check for members
* `parent` (optional) — inherits the parent's grants transitively

### 4.4 Access Rights (code)

Declared in `src/accessRights.ts` with `defineAccessRights({ ... })`.

```ts
defineAccessRights({
  demo: {
    todos: { create: true, read: true, update: true, delete: true },
  },
});
```

The shape is `role -> resource -> { create?, read?, update?, delete? }`.
A role with a missing entry has no grant on that resource. Effective
grants are the union of the role's own + every ancestor's.

### 4.5 Record Rules (code)

Declared in `src/recordRules.ts` with `defineRecordRules({ ... })`.

```ts
const own = [["assigneeId", "=", "current_user.id"]];
defineRecordRules({
  demo: { todos: { read: own, update: own, delete: own } },
});
```

Shape: `role -> resource -> action -> domain` (Odoo-style polish-prefix
array). Multiple rules contributed by ancestor roles are AND-ed within
a role; across roles the engine OR-s them.

### 4.6 Role Inheritance

* Roles may declare a `parent` role
* Effective grants = union(self + ancestors)
* Cycles are detected and throw at config-build time

---

## 5. Permission Evaluation Flow

### Step 1: Identify user context

* user_id (from session)
* role keys from `user_roles`, expanded via the `parent` chain

### Step 2: ACL check

```
if not has_permission(user, resource, action):
    deny
```

### Step 3: Apply Record Rules

```
filtered_records = apply_domain_filters(user_roles, resource)
```

### Step 4: Return result

---

## 6. API Design

### 6.1 Check Permission

```ts
enforce(ctx, resource, action, columns) -> { where?: SQL }
```

### 6.2 Filter Records

`rbacDb` automatically AND-injects the record-rule SQL into resolvers'
where clauses; manual callers can use the SQL fragment from `enforce`.

### 6.3 Assign Role (admin REST)

```
POST   /admin/users/:id/roles      { roleKey }
DELETE /admin/users/:id/roles/:key
```

### 6.4 Define Role (code)

```ts
// src/roles.ts
export const roles = defineRoles({ ... });
```

Roles cannot be created at runtime; the config is loaded once at startup.

---

## 7. Domain Rule Engine

Operators:

* `=`, `!=`
* `in`, `not in`
* `>`, `<`, `>=`, `<=`
* `like`, `ilike`, `not like`, `not ilike`
* `=`/`!=` against `null` (is null / is not null)
* `AND`, `OR`, `NOT` combinators

Example:

```
[ ["state", "!=", "draft"] ]
```

---

## 8. Security Rules

* Deny by default
* Enforce at service/DB layer
* No client-side trust
* Prevent role inheritance cycles (rejected at config-build time)

---

## 9. Performance Requirements

* Permission check < 5ms average
* DB-level filtering where possible
* Cached role resolution (TTL+LRU on `(userId)` and `(userId, resource, action)`)
* Lazy evaluation of policies

---

## 10. Extensibility

Future support:

* Field-level security
* API-level permissions
* Custom permission types
* ABAC hybrid model

---

## 11. Advanced Features

### 11.1 Multi-company support

Automatic filtering by company context

### 11.2 Field-level security

Hide fields per role

### 11.3 Implicit roles

Auto role assignment rules

### 11.4 Audit logging

Track permission decisions

---

## 12. Success Metrics

* 100% endpoint coverage
* Zero unauthorized access incidents
* <10% request overhead
* Simple role configuration in three small files per app

---

## 13. Risks

| Risk               | Mitigation            |
| ------------------ | --------------------- |
| Complex rules      | caching + grouping    |
| Performance issues | DB filtering          |
| Misconfiguration   | validation at startup |
| Circular roles     | graph cycle detection |

---

## 14. Future Improvements

* UI role editor (config-aware, not DB-driven)
* Role graph visualization
* AI-assisted role suggestions
* Permission simulation tool
