/**
 * @module graphql/builder/drizzle-internals
 *
 * Narrow, typed accessors over Drizzle column internals (`primary`, `notNull`,
 * `hasDefault`, `generated`, `name`). These properties are not part of
 * Drizzle's public type surface but are stable runtime shape across the
 * `drizzle-orm@^0.38.x` line pinned in this package's package.json. Treat
 * these helpers as a single shim point — if Drizzle changes any of these
 * field names in a future major, update them here.
 */
import type { Column } from "drizzle-orm";

/** True when the column is generated (e.g. `GENERATED ALWAYS AS`). */
export function isGenerated(col: Column): boolean {
  return !!(col as any).generated;
}

/** True when the column is declared `NOT NULL`. */
export function isNotNull(col: Column): boolean {
  return !!(col as any).notNull;
}

/** True when the column has a database-side default value. */
export function hasDefault(col: Column): boolean {
  return !!(col as any).hasDefault;
}

/** True when the column is part of the table's primary key. */
export function isPrimary(col: Column): boolean {
  return !!(col as any).primary;
}

/** SQL column name (the actual database identifier, not the JS export key). */
export function getColumnName(col: Column): string {
  return (col as any).name as string;
}

/** Drizzle's per-dialect column-type tag (e.g. "SQLiteInteger", "PgReal"). Used to disambiguate numeric subtypes for GraphQL type mapping. */
export function getColumnType(col: Column): string | undefined {
  return (col as any).columnType;
}
