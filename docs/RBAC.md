# PRD: RBAC System for Custom Framework (Odoo-like)

## 1. Overview

### 1.1 Purpose

Build a flexible and extensible **Role-Based Access Control (RBAC)** system that controls access to data and actions within the framework, similar to Odoo’s security architecture (groups, access rights, record rules).

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
* Groups (Roles)
* Access Rights (CRUD per model)
* Record Rules (row-level security)
* Implied groups (hierarchical roles)

This system generalizes the same concept.

---

## 3. System Architecture

### 3.1 Core Components

* User
* Role (Group)
* Permission (Access Rights)
* Policy (Record Rules / ABAC layer)
* Resource (Model / Entity)

---

## 4. Data Model

### 4.1 User

* id
* name
* email
* roles: List<Role>
* active

---

### 4.2 Role (Group)

* id
* name
* parent_role_id (optional inheritance)
* permissions: List<Permission>

---

### 4.3 Permission (Access Control List)

Defines CRUD access on a resource.

| Field      | Description      |
| ---------- | ---------------- |
| id         | unique           |
| role_id    | FK               |
| resource   | model/table name |
| can_create | bool             |
| can_read   | bool             |
| can_update | bool             |
| can_delete | bool             |

---

### 4.4 Record Rule (Policy Engine)

Row-level security rules.

| Field             | Description               |
| ----------------- | ------------------------- |
| id                | unique                    |
| role_id           | FK                        |
| resource          | model                     |
| domain_expression | rule logic                |
| perm_type         | create/read/update/delete |

Example:

```json
{
  "resource": "invoice",
  "perm_type": "read",
  "domain": "user_id = current_user.id"
}
```

---

### 4.5 Role Inheritance

* Roles may inherit from parent roles
* Effective permissions = union(parent + child)

---

## 5. Permission Evaluation Flow

### Step 1: Identify user context

* user_id
* roles
* tenant/company

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

```python
has_access(user, resource, action) -> bool
```

### 6.2 Filter Records

```python
apply_rules(user, resource, queryset) -> queryset
```

### 6.3 Assign Role

```python
assign_role(user_id, role_id)
```

### 6.4 Create Role

```python
create_role(name, permissions, parent_role=None)
```

---

## 7. Domain Rule Engine

Operators:

* =
* !=
* in
* not in
* >
* <
* AND
* OR

Example:

```
[ ("state", "!=", "draft")]
```

---

## 8. Security Rules

* Deny by default
* Enforce at service/DB layer
* No client-side trust
* Prevent role inheritance cycles


---

## 9. Performance Requirements

* Permission check < 5ms average
* DB-level filtering where possible
* Cached role resolution
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
* Simple role configuration without code changes

---

## 13. Risks

| Risk               | Mitigation            |
| ------------------ | --------------------- |
| Complex rules      | caching + grouping    |
| Performance issues | DB filtering          |
| Misconfiguration   | validation tools      |
| Circular roles     | graph cycle detection |

---

## 14. Future Improvements

* UI role editor
* Role graph visualization
* AI-assisted role suggestions
* Permission simulation tool
