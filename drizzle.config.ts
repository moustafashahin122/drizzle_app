import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? "";
const usePg = url.startsWith("postgres://") || url.startsWith("postgresql://");

// Point drizzle-kit at the dialect-specific schema file directly. The runtime
// dispatcher at `src/schema.ts` uses ESM-style `.js` relative imports that
// drizzle-kit's CJS loader can't resolve, but pointing here at the concrete
// file sidesteps the dispatcher entirely.
export default (
  usePg
    ? {
        schema: "./src/schema.pg.ts",
        out: "./drizzle",
        dialect: "postgresql",
        dbCredentials: { url },
      }
    : {
        schema: "./src/schema.sqlite.ts",
        out: "./drizzle",
        dialect: "sqlite",
        dbCredentials: { url: "todo.db" },
      }
) satisfies Config;
