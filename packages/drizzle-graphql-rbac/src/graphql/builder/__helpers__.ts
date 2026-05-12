/**
 * Test fixtures for the GraphQL builder. Each fixture owns one in-memory
 * SQLite handle, materializes the Drizzle schema via `pushDrizzleSchema`
 * (no hand-written DDL — eliminates drift), and exposes a typed `run` that
 * throws on GraphQL errors so individual tests don't have to repeat
 * `result.errors === undefined` plumbing.
 *
 * `countQueries` installs a Drizzle logger that increments a counter on
 * every `select ...` statement — used by the relation-batching tests.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { graphql, type ExecutionResult, type GraphQLSchema } from "graphql";

import { buildSchema, type BuildSchemaOptions } from "./builder.js";
import { pushDrizzleSchema } from "../../testing/schemaPush.js";

type Db = ReturnType<typeof drizzle>;

export interface BuilderFixture {
  db: Db;
  schema: GraphQLSchema;
  /** Count of `select ...` statements observed so far (0 unless `countQueries`). */
  selects(): number;
  resetCounter(): void;
  /** Run a query and return `data`; throws if `errors` is non-empty. */
  run<T = Record<string, any>>(
    query: string,
    variables?: Record<string, unknown>,
    contextValue?: unknown,
  ): Promise<T>;
  /** Run a query and return the raw ExecutionResult. */
  runRaw(
    query: string,
    opts?: { variables?: Record<string, unknown>; contextValue?: unknown },
  ): Promise<ExecutionResult>;
}

export interface BuilderFixtureOptions {
  tables: Record<string, unknown>;
  /** Runs after schema is pushed, before the GraphQL schema is built. */
  seed?: (db: Db) => void | Promise<void>;
  builder?: BuildSchemaOptions;
  /** Install a logger that counts `select` queries. */
  countQueries?: boolean;
}

export async function makeBuilderFixture(
  opts: BuilderFixtureOptions,
): Promise<BuilderFixture> {
  const sqlite = new Database(":memory:");
  await pushDrizzleSchema(sqlite, opts.tables);

  let selectCount = 0;
  const db = drizzle(
    sqlite,
    opts.countQueries
      ? {
          logger: {
            logQuery: (q) => {
              if (q.toLowerCase().startsWith("select")) selectCount++;
            },
          },
        }
      : undefined,
  );

  if (opts.seed) await opts.seed(db);

  const { schema } = buildSchema(db, opts.tables, opts.builder ?? {});

  const runRaw: BuilderFixture["runRaw"] = (source, o) =>
    graphql({
      schema,
      source,
      variableValues: o?.variables,
      contextValue: o?.contextValue,
    });

  const run: BuilderFixture["run"] = async (source, variables, contextValue) => {
    const result = await runRaw(source, { variables, contextValue });
    if (result.errors?.length) {
      throw new Error(result.errors.map((e) => e.message).join("\n"));
    }
    return result.data as any;
  };

  return {
    db,
    schema,
    selects: () => selectCount,
    resetCounter: () => { selectCount = 0; },
    run,
    runRaw,
  };
}
