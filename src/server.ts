import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createYoga } from "graphql-yoga";
import { buildSchema } from "./graphql/index.js";
import * as dbModule from "./db.js";

const { schema } = buildSchema(dbModule.db, dbModule);

const yoga = createYoga({
  schema,
  graphqlEndpoint: "/graphql",
  graphiql: true,
});

const app = new Hono();

app.all("/graphql", (c) => yoga.fetch(c.req.raw, {}));

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`Server running on http://localhost:${port}`);
console.log(`GraphiQL at http://localhost:${port}/graphql`);
