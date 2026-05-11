/**
 * @module graphql/builder/builder-types
 *
 * Summary
 * -------
 * Pass 1 of {@link buildSchema}: for each Drizzle table, construct the
 * per-table {@link GraphQLObjectType} (with a lazy fields-thunk that mixes
 * scalar columns and relation fields) plus the matching `Insert`, `Update`,
 * and `OrderBy` input types.
 *
 * The object type's fields-thunk is what enables cyclic relation types and
 * recursive traversal — relation fields are resolved through whichever
 * {@link TableMeta} the orchestrator has already registered for the referenced
 * table.
 */
import {
  GraphQLObjectType,
  type GraphQLFieldConfigMap,
} from "graphql";
import { getTableName, getTableColumns } from "drizzle-orm";
import type { ColumnMap } from "./filters.js";
import { buildOrderByInput } from "./filters.js";
import { buildInsertInput, buildUpdateInput } from "./builder-fields.js";
import { buildRelationField } from "./builder-relations.js";
import { introspectSchema } from "./relations.js";
import { columnToBaseType, wrapNonNull } from "./types.js";
import { isNotNull } from "./drizzle-internals.js";
import type { DrizzleLike, TableMeta } from "./types.js";
import type { DomainContext } from "../domain/domain.js";

/**
 * Lazy fields-thunk used by every per-table {@link GraphQLObjectType}.
 *
 * Emits one field per scalar column (default resolver reads from the source
 * row), then overlays relation fields. A relation field with the same name as
 * a scalar column **replaces** the scalar on the output type (the scalar value
 * is still reachable through `where` / `set` / Insert / Update inputs).
 *
 * Called via the GraphQL `fields: () => ...` thunk so that referenced object
 * types created in the same pass can be referenced before they are fully
 * registered — this is what enables cyclic relation types and recursive
 * traversal.
 */
function buildObjectFields(
  meta: TableMeta,
  intro: ReturnType<typeof introspectSchema>,
  metas: Map<string, TableMeta>,
  db: DrizzleLike,
  domainCtxFor: (m: TableMeta) => DomainContext,
  hiddenOutput: Set<string>,
  relationBatchSize: number,
  maxListLimit: number,
): GraphQLFieldConfigMap<any, any> {
  const fields: GraphQLFieldConfigMap<any, any> = {};
  for (const [name, col] of Object.entries(meta.columns)) {
    if (hiddenOutput.has(name)) continue;
    fields[name] = {
      type: wrapNonNull(columnToBaseType(col), isNotNull(col)),
      resolve: (src) => src?.[name],
    };
  }

  const sqlName = getTableName(meta.table);
  const rels = intro.relations.get(sqlName) ?? [];
  for (const rel of rels) {
    const refMeta = metas.get(getTableName(rel.referencedTable));
    if (!refMeta) continue;
    // Relation field replaces a same-named scalar column on the output type.
    // The scalar FK column remains usable in `set` / Insert / Update inputs
    // (and inside a domain leaf) because they iterate the unchanged column map.
    fields[rel.fieldName] = buildRelationField(rel, meta, refMeta, db, domainCtxFor(refMeta), relationBatchSize, maxListLimit);
  }
  return fields;
}

/**
 * Build the per-table {@link TableMeta} record (Pass 1 output) for a single
 * table. Returns the meta with all four GraphQL types attached; the object
 * type's fields-thunk closes over `metas` so it can resolve relation fields
 * lazily once every table in the schema has been registered.
 */
export function buildTableMeta(
  jsKey: string,
  table: any,
  typeName: string,
  intro: ReturnType<typeof introspectSchema>,
  metas: Map<string, TableMeta>,
  db: DrizzleLike,
  domainCtxFor: (m: TableMeta) => DomainContext,
  hiddenOutput: Set<string>,
  hiddenInput: Set<string>,
  relationBatchSize: number,
  maxListLimit: number,
): TableMeta {
  const sqlName = getTableName(table);
  const columns = getTableColumns(table) as ColumnMap;
  const relations = intro.relations.get(sqlName) ?? [];

  const objectType = new GraphQLObjectType({
    name: typeName,
    fields: () => buildObjectFields(meta, intro, metas, db, domainCtxFor, hiddenOutput, relationBatchSize, maxListLimit),
  });
  const insertInput = buildInsertInput(typeName, columns, hiddenInput);
  const updateInput = buildUpdateInput(typeName, columns, hiddenInput);
  const orderByInput = buildOrderByInput(typeName, columns);

  const meta: TableMeta = {
    jsKey,
    typeName,
    table,
    columns,
    relations,
    objectType,
    insertInput,
    updateInput,
    orderByInput,
  };
  return meta;
}
