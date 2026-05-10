/**
 * @module graphql/relations
 *
 * Summary
 * -------
 * Walks a Drizzle schema namespace and produces a unified relation graph used
 * by the schema builder. Three sources are merged, in this order of
 * precedence:
 *
 *   1. **Tables** — every value branded with Drizzle's `Table` symbol, indexed
 *      by both SQL table name and JS export key.
 *   2. **Explicit `relations(...)`** — each `Relations` value's config is
 *      executed with the official `createTableRelationsHelpers` so we capture
 *      `One`/`Many` declarations and their `fields` / `references` / named
 *      relations exactly as Drizzle sees them.
 *   3. **Inline foreign keys** — single-column FKs declared via Drizzle column
 *      `.references(...)` are auto-promoted to a forward "one" relation
 *      (named after the FK column's JS key, e.g. `assigneeId`) and an inverse
 *      "many" relation on the referenced table (named after the source
 *      table's JS export key, e.g. `todos`). FK detection works across SQLite,
 *      Postgres, and MySQL because all dialects store the FK array under a
 *      dialect-specific `Symbol.for(...)` with the same shape.
 *
 * Explicit `relations(...)` always win: an FK is only auto-promoted when
 * there isn't already a same-named relation on the source side, and the
 * inverse "many" is skipped if the referenced table already declares a
 * relation with that field name. Composite FKs are skipped — declare those
 * via `relations(...)` instead.
 *
 * Notes
 * -----
 * - The final pass back-fills `fields` / `references` on declared "many"
 *   relations whose paired "one" side included an explicit `fields/references`
 *   config — this lets the resolver build a proper join condition without
 *   relying on naming conventions.
 */
import {
  Many,
  One,
  Relations,
  createTableRelationsHelpers,
  getTableColumns,
  getTableName,
  is,
  Table,
  type Column,
} from "drizzle-orm";
import { jsKeyOf } from "./util.js";

/**
 * Symbols Drizzle uses to attach inline foreign keys to a table instance, one
 * per dialect. The shape is identical across dialects (`{ columns,
 * foreignTable, foreignColumns }` returned by each FK's `reference()`); only
 * the key differs.
 */
const INLINE_FK_SYMBOLS = [
  Symbol.for("drizzle:SQLiteInlineForeignKeys"),
  Symbol.for("drizzle:PgInlineForeignKeys"),
  Symbol.for("drizzle:MySqlInlineForeignKeys"),
];

/**
 * Read inline FKs from a Drizzle table regardless of dialect.
 *
 * @param table A Drizzle table instance.
 * @returns A list of `{ columns, foreignTable, foreignColumns }` references —
 *          empty if the table has no inline FKs or runs on an unknown dialect.
 */
function getInlineForeignKeys(table: Table): Array<{
  columns: Column[];
  foreignTable: Table;
  foreignColumns: Column[];
}> {
  for (const sym of INLINE_FK_SYMBOLS) {
    const fks = (table as any)[sym];
    if (Array.isArray(fks) && fks.length) {
      return fks.map((fk) => fk.reference());
    }
  }
  return [];
}

/**
 * Normalized description of a single relation between two tables.
 *
 * The same shape covers explicit `relations(...)` declarations and FK-derived
 * relations, so the builder doesn't need to care about the source. `fields`
 * and `references` are the columns used to join the two tables when a
 * resolver runs:
 * - For a "one" relation: `parent.fields[i] === referencedRow.references[i]`.
 * - For a "many" relation: same predicate, where `parent` is a row on the
 *   `sourceTable` and matched rows live in `referencedTable`.
 */
export interface ExtractedRelation {
  /** GraphQL field name on the source object type. */
  fieldName: string;
  /** Cardinality of the relation. "one" → object or null; "many" → list. */
  kind: "one" | "many";
  /** The table this relation is declared on (the parent of the field). */
  sourceTable: Table;
  /** The table the relation points at. */
  referencedTable: Table;
  /** Local columns on `sourceTable` used as the join key. */
  fields?: Column[];
  /** Foreign columns on `referencedTable` used as the join key. */
  references?: Column[];
  /** Drizzle relation name, used to pair `one`/`many` sides when ambiguous. */
  relationName?: string;
}

/**
 * Result of {@link introspectSchema}: a structured view of the user's Drizzle
 * schema namespace, with relations already merged from explicit declarations
 * and inline FKs.
 */
export interface SchemaIntrospection {
  /** SQL table name → Drizzle table instance. */
  tables: Map<string, Table>;
  /** JS export key (as used in the schema namespace) → Drizzle table instance. */
  tablesByKey: Map<string, Table>;
  /** SQL table name → JS export key. */
  keyByTableName: Map<string, string>;
  /** SQL table name → relations declared on that table (forward + inverse). */
  relations: Map<string, ExtractedRelation[]>;
}

/**
 * Walk a Drizzle schema namespace and return a {@link SchemaIntrospection}.
 *
 * @param schema The result of `import * as schema from "./schema.js"` — a
 *               record whose values are Drizzle tables and/or `relations(...)`
 *               declarations. Non-Drizzle values are ignored.
 * @returns Tables (by SQL name and JS key) plus a relation graph that merges
 *          explicit `relations(...)` and auto-detected inline FKs.
 *
 * @example
 * import * as schema from "./schema.js";
 * const intro = introspectSchema(schema);
 * intro.relations.get("todos");      // → [{ fieldName: "assigneeId", kind: "one", ... }]
 * intro.relations.get("assignees");  // → [{ fieldName: "todos",      kind: "many", ... }]
 */
export function introspectSchema(schema: Record<string, unknown>): SchemaIntrospection {
  const tables = new Map<string, Table>();
  const tablesByKey = new Map<string, Table>();
  const keyByTableName = new Map<string, string>();
  const relationsByTable = new Map<string, ExtractedRelation[]>();

  for (const [key, value] of Object.entries(schema)) {
    if (is(value as any, Table)) {
      const t = value as Table;
      const name = getTableName(t);
      tables.set(name, t);
      tablesByKey.set(key, t);
      keyByTableName.set(name, key);
    }
  }

  for (const value of Object.values(schema)) {
    if (!is(value as any, Relations)) continue;
    const rels = value as Relations;
    const sourceTable = rels.table as Table;
    const sourceName = getTableName(sourceTable);
    const helpers = createTableRelationsHelpers(sourceTable as any);
    const config = rels.config(helpers as any);
    const list = relationsByTable.get(sourceName) ?? [];
    for (const [fieldName, rel] of Object.entries(config)) {
      const r = rel as One | Many<string>;
      if (is(r, One)) {
        const oneRel = r as One;
        list.push({
          fieldName,
          kind: "one",
          sourceTable,
          referencedTable: oneRel.referencedTable as Table,
          fields: (oneRel.config as any)?.fields,
          references: (oneRel.config as any)?.references,
          relationName: oneRel.relationName,
        });
      } else if (is(r, Many)) {
        const manyRel = r as Many<string>;
        list.push({
          fieldName,
          kind: "many",
          sourceTable,
          referencedTable: manyRel.referencedTable as Table,
          relationName: manyRel.relationName,
        });
      }
    }
    relationsByTable.set(sourceName, list);
  }

  // Auto-detect FK-based relations for tables without an explicit relations() entry,
  // and for FK columns not already covered by an explicit relation. Single-column FKs only.
  for (const [sourceName, sourceTable] of tables) {
    const sourceCols = getTableColumns(sourceTable) as Record<string, Column>;
    const list = relationsByTable.get(sourceName) ?? [];
    const existingFieldNames = new Set(list.map((r) => r.fieldName));

    for (const fk of getInlineForeignKeys(sourceTable)) {
      if (fk.columns.length !== 1) continue; // skip composite FKs
      const localCol = fk.columns[0];
      const refTable = fk.foreignTable;
      const refName = getTableName(refTable);
      // Only register if the referenced table is part of the schema we know about.
      if (!tables.has(refName)) continue;

      const localKey = jsKeyOf(sourceCols, localCol);
      if (!localKey) continue;

      // Forward "one": named after the FK column's JS key (e.g. "assigneeId").
      if (!existingFieldNames.has(localKey)) {
        list.push({
          fieldName: localKey,
          kind: "one",
          sourceTable,
          referencedTable: refTable,
          fields: fk.columns,
          references: fk.foreignColumns,
        });
        existingFieldNames.add(localKey);
      }

      // Inverse "many" on the referenced table: named after the source table's JS key
      // (e.g. "todos" on the assignees object). Skip if already taken.
      const inverseFieldName = keyByTableName.get(sourceName);
      if (!inverseFieldName) continue;
      const refList = relationsByTable.get(refName) ?? [];
      if (refList.some((r) => r.fieldName === inverseFieldName)) {
        relationsByTable.set(refName, refList);
        continue;
      }
      refList.push({
        fieldName: inverseFieldName,
        kind: "many",
        sourceTable: refTable,
        referencedTable: sourceTable,
        fields: fk.foreignColumns,
        references: fk.columns,
      });
      relationsByTable.set(refName, refList);
    }
    relationsByTable.set(sourceName, list);
  }

  // Auto-derive the "many" side when only the "one" side declared fields/references.
  for (const [tableName, list] of relationsByTable) {
    for (const rel of list) {
      if (rel.kind !== "one" || !rel.fields || !rel.references) continue;
      const refName = getTableName(rel.referencedTable);
      const refList = relationsByTable.get(refName) ?? [];
      for (const back of refList) {
        if (back.kind === "many" && getTableName(back.referencedTable) === tableName &&
            back.relationName === rel.relationName && !back.fields) {
          back.fields = rel.references;
          back.references = rel.fields;
        }
      }
    }
  }

  return { tables, tablesByKey, keyByTableName, relations: relationsByTable };
}
