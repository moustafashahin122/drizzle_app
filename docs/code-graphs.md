# Code Graphs

How to generate module dependency graphs for this repo using [`madge`](https://github.com/pahen/madge).

`madge` is installed as a devDependency. Graphviz (`dot`) must be on `PATH` for image output (`apt install graphviz` on Debian/Ubuntu/WSL).

## Render the full graph to SVG

Entry points are `src/server.ts` (app) and `packages/drizzle-graphql-rbac/src/index.ts` (framework). Pass both so the graph spans the workspace.

```bash
npx madge \
  --extensions ts \
  --ts-config tsconfig.json \
  --exclude '(\.test\.ts$|/testing/)' \
  --image graph.svg \
  src/server.ts packages/drizzle-graphql-rbac/src/index.ts
```

Output: `graph.svg` at the repo root. Open in a browser.

## Find circular dependencies

```bash
npx madge --extensions ts --ts-config tsconfig.json --circular \
  src/ packages/drizzle-graphql-rbac/src/
```

Exits non-zero if cycles are found — useful in CI.

## List dependents of a module

How many modules import a given file (highest = most central):

```bash
npx madge --extensions ts --ts-config tsconfig.json --summary \
  src/server.ts packages/drizzle-graphql-rbac/src/index.ts
```

## Dependencies of a single file

```bash
npx madge --extensions ts --ts-config tsconfig.json \
  packages/drizzle-graphql-rbac/src/graphql/builder/builder.ts
```

## JSON output (for scripting)

```bash
npx madge --extensions ts --ts-config tsconfig.json --json \
  src/server.ts > deps.json
```

## Notes

- `madge` is **module-level**. It shows which files import which, not which functions call which. For function-level, see below.
- The `.js` import extensions in source files (NodeNext ESM convention) are resolved correctly when `--ts-config tsconfig.json` is passed.
- Test files and the `testing/` helpers are excluded above to keep the graph focused on production code; drop the `--exclude` flag to include them.

# Function-Level Call Graphs (jelly)

[`jelly`](https://github.com/cs-au-dk/jelly) (`@cs-au-dk/jelly`) is installed as a devDependency. It performs static analysis on JS/TS to produce a true function-to-function call graph.

## Generate the call graph

```bash
npx jelly \
  --ignore-unresolved \
  --no-print-progress --no-tty \
  -m callgraph.html \
  -j callgraph.json \
  src/server.ts packages/drizzle-graphql-rbac/src/index.ts
```

Outputs:
- `callgraph.html` — interactive visualization (open in browser, supports filtering by module/function).
- `callgraph.json` — raw `{files, functions, calls, fun2fun, call2fun}` for scripting.

Expect ~15s analysis, ~1GB peak memory on this repo. The summary line reports counts:

```
Analyzed packages: 42, modules: 644, functions: 6063
Call edges function->function: 8904, call->function: 10796
```

## Limit to project code only

`--ignore-dependencies` excludes node_modules **and** workspace packages — too aggressive for this monorepo (it drops `drizzle-graphql-rbac`). Use `--exclude-packages` to drop specific third-party packages instead:

```bash
npx jelly \
  --ignore-unresolved --no-print-progress --no-tty \
  --exclude-packages graphql '@graphql-tools/*' \
  -m callgraph.html -j callgraph.json \
  src/server.ts packages/drizzle-graphql-rbac/src/index.ts
```

## Bounded depth around a function (CLI)

After `callgraph.json` exists, list callees and callers up to a chosen depth without opening the HTML graph:

```bash
npm run callgraph:neighborhood -- --match "rbac.ts" --down 2 --up 2
# shorthand: first positional is the match substring
npm run callgraph:neighborhood -- createApp --down 3 --up 1
npm run callgraph:neighborhood -- --list --match "builder/builder.ts"
```

- `--down N` — how many function-to-function hops **outward** (this function calls … calls …).
- `--up N` — hops **inward** (who calls this function, who calls them, …).
- `--cap K` — max distinct edges shown per node (default 50); raise if you hit `… and N more callees`.
- `--list` — only print matching `[id] file:Lx` lines (useful before widening `--down`).

The HTML viewer’s “package / module / function” radios are a different notion of “level” (graph granularity). Depth control is this script (or ad‑hoc queries on `fun2fun` as below).

## Query the JSON

Find all callers of a specific function:

```bash
node -e "
const j = require('./callgraph.json');
const target = j.functions.findIndex(f => f.includes('builder.ts') && f.includes(':createSchema'));
const callers = j.fun2fun.filter(([_, to]) => to === target).map(([from]) => j.functions[from]);
console.log(callers);
"
```

The arrays in `fun2fun` / `call2fun` are pairs of integer indices into `functions` / `calls`.

## Notes / gotchas

- Jelly analyses **compiled JS semantics** — TS-only constructs (decorators, types) are stripped. Pass `--typescript` only when used with `-p` (API-usage patterns).
- ~33% of calls are "native or external" (Node built-ins, unresolved dynamic dispatch). This is normal for a Node/Hono app.
- 2298 warnings in the default run are mostly about unsupported language features deep inside dependencies — see them with `--warnings-unsupported`.
- For per-class diagrams (smaller, less precise), `ts-call-graph` is the lighter alternative — not installed here.
