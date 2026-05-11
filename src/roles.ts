/**
 * App-defined roles for the todo demo.
 *
 * The framework provides the `admin` role (full bypass) automatically — do
 * not redeclare it here. Add only the roles your application needs. There
 * is no inheritance — each role's grants stand alone.
 */
import { defineRoles } from "drizzle-graphql-rbac";

export const roles = defineRoles({
  /**
   * Demo role: can manage todos but only the rows assigned to them. See
   * `accessRights.ts` for the CRUD grants and `recordRules.ts` for the
   * row-level filter.
   */
  demo: {},
});

/** Union type of every app-defined role key. */
export type RoleKey = keyof typeof roles;
