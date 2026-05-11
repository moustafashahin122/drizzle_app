## `loadRbacSnapshot` (RBAC runtime snapshot loader)

### Big picture

`loadRbacSnapshot(db, schema)` builds the **in-memory RBAC “lookup tables”** that the RBAC engine uses while handling requests.

The core idea is:

- The RBAC config is **stored in SQL tables** (`roles`, `access_rights`, `record_rules`).
- At runtime, you don’t want to keep doing expensive joins / scans to answer questions like “can role X update todos?”.
- So you read each table once and reshape it into **Maps/Sets optimized for fast checks** (mostly O(1) lookups).

It’s “cheap to call” because it does **one query per table** and no joins.

### What it returns

It returns an `RbacSnapshot`:

- **`rolesById`**: `roleId -> { key, isAdmin }`
- **`accessByRole`**: `roleId -> resource -> Set<action>`
- **`rulesByRole`**: `roleId -> resource -> action -> domainArray`

Think of it as: “given a roleId, quickly tell me the role metadata, the CRUD grants, and any row-level filters (domains).”

### How it builds each piece

#### 1) Roles (`rolesById`)

It selects `id`, `key`, and `isAdmin` from `schema.roles`, then populates:

- `rolesById.set(id, { key, isAdmin })`

This lets the engine quickly:

- map DB role IDs to stable human keys (like `"admin"` / `"demo"`), and
- short-circuit checks for admin roles (`isAdmin === true` typically means “bypass” elsewhere in the engine).

#### 2) Access rights (`accessByRole`)

It reads all rows from `schema.accessRights`. Each row is shaped like:

- `roleId`
- `resource` (a string key like `"todos"` or `"users"`)
- booleans `canCreate/canRead/canUpdate/canDelete`

It converts the boolean flags into a **Set of action strings**:

- `canCreate` → `"create"`
- `canRead` → `"read"`
- `canUpdate` → `"update"`
- `canDelete` → `"delete"`

So instead of checking four columns every time, the runtime check becomes:

- “does `accessByRole.get(roleId)?.get(resource)?.has(action)`?”

#### 3) Record rules (`rulesByRole`)

It reads all rows from `schema.recordRules`. Each row contains:

- `roleId`
- `resource`
- `action`
- `domain` (stored as a JSON string)

Then it builds a nested map and **parses the JSON domain**:

- `rulesByRole.get(roleId).get(resource).set(action, JSON.parse(domain))`

This is the row-level security part: for a given `(roleId, resource, action)`, the engine can fetch the domain array (often an Odoo-like “domain” AST) and apply it when deciding which rows are visible/mutable.

### Practical example

Imagine the DB contains:

- role 2 = `{ key: "demo", isAdmin: false }`
- access_rights row: role 2, resource `"todos"`, `canRead=true`, `canUpdate=true`
- record_rules row: role 2, resource `"todos"`, action `"read"`, domain `"[['assigneeId','=','@user.id']]"` (as JSON)

After `loadRbacSnapshot` you can do:

- `rolesById.get(2)` → `{ key: "demo", isAdmin: false }`
- `accessByRole.get(2).get("todos").has("update")` → `true`
- `rulesByRole.get(2).get("todos").get("read")` → the parsed domain array

### Important technical notes

- **No validation of `domain` JSON here**: if `record_rules.domain` isn’t valid JSON, `JSON.parse` will throw and snapshot loading fails.
- **Last-write-wins per `(roleId, resource, action)`**: if the DB contains multiple `record_rules` rows for the same triple, the later iteration overwrites the earlier one in the `Map`. (In practice, the schema/config should prevent duplicates.)
- **This function does not sync**: it only reads. If you want “sync then load”, the file provides `syncAndSnapshot(...)`.

