/**
 * @module graphql/builder/schemaKey
 *
 * Standalone helper extracted from `./util.ts` so that `relations.ts` can
 * import it without introducing a cycle through `util.ts → types.ts →
 * relations.ts` or `util.ts → domain.ts → relations.ts`.
 */
import type { Column } from "drizzle-orm";

/**
 * Reverse-lookup the JS key of a Drizzle column inside a `{ schemaKey: Column }` map.
 *
 * @returns The matching JS key, or `undefined` if `target` isn't in `columns`.
 */
export function schemaKeyOf(
  columns: Record<string, Column>,
  target: Column,
): string | undefined {
  for (const [k, c] of Object.entries(columns)) if (c === target) return k;
  return undefined;
}
