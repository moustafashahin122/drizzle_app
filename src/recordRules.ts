/**
 * Per-role row-level filters. Each entry carries an `xid` and a `domain`.
 *
 * A "domain" is an Odoo-style polish-prefix array. Each leaf is a triple
 * `[field, operator, value]`; values may use placeholders such as
 * `"current_user.id"` which the engine replaces with the caller's id at
 * enforce time.
 *
 * Semantics: a role's record rule narrows that role's access — anyone with
 * the matching CRUD grant from `accessRights.ts` will additionally have
 * their query AND-ed with this filter. Multiple roles' rules are OR-ed,
 * so a user in a less-restrictive role still sees the broader set.
 */
import { defineRecordRules } from "drizzle-graphql-rbac";

const ownTodos = [["assigneeId", "=", "current_user.id"]];

export const recordRules = defineRecordRules({
  demo: {
    todos: {
      read:   { xid: "todo.rr.demo.todos.read",   domain: ownTodos },
      update: { xid: "todo.rr.demo.todos.update", domain: ownTodos },
      delete: { xid: "todo.rr.demo.todos.delete", domain: ownTodos },
    },
  },
});
