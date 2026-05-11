/**
 * @module graphql/util
 *
 * Small helpers shared by more than one builder module. Anything here should be
 * trivially testable in isolation and have no opinion about GraphQL or Drizzle
 * configuration beyond accepting their primitives.
 */
import type { Column } from "drizzle-orm";

/**
 * Reverse-lookup the JS key of a Drizzle column inside a `{ jsKey: Column }` map.
 *
 * Drizzle's `getTableColumns(table)` returns a record keyed by the JS field name
 * the user wrote in their schema; this helper finds that key when only the
 * column instance is in hand (e.g. when walking foreign-key references or
 * relation `fields` arrays).
 *
 * @returns The matching JS key, or `undefined` if `target` isn't in `columns`.
 */
export function jsKeyOf(
  columns: Record<string, Column>,
  target: Column,
): string | undefined {
  for (const [k, c] of Object.entries(columns)) if (c === target) return k;
  return undefined;
}
