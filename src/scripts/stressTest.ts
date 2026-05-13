/**
 * GraphQL load test for the demo app.
 *
 * Usage:
 *   tsx src/scripts/stressTest.ts [--url=http://localhost:3000] [--concurrency=32] [--duration=15] [--ops=mixed]
 *
 * Logs in as the three demo users (admin/manager/demo), then fans out N
 * concurrent workers that each issue a randomised mix of GraphQL queries
 * and mutations against `/graphql` for `duration` seconds. Reports
 * throughput, error counts, and latency percentiles per operation kind.
 */

type Op = {
  name: string;
  weight: number;
  build: (ctx: { userIdx: number; counter: number }) => { query: string; variables?: Record<string, unknown> };
};

type Session = { email: string; sid: string };

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "true"];
  }),
) as Record<string, string>;

const URL_BASE = args.url ?? "http://localhost:3000";
const CONCURRENCY = Number(args.concurrency ?? 32);
const DURATION_S = Number(args.duration ?? 15);
const PASSWORD = process.env.DEV_PASSWORD ?? "demo123";

const USERS = (args.users ?? "demo_admin@example.com,demo_manager@example.com,demo_user@example.com").split(",");

async function login(email: string): Promise<Session> {
  const res = await fetch(`${URL_BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email} -> ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/sid=([^;]+)/);
  if (!m) throw new Error(`no sid cookie for ${email}`);
  return { email, sid: m[1] };
}

const OPS: Op[] = [
  {
    name: "todos.list",
    weight: 5,
    build: () => ({
      query: `{ todos(limit:20, orderBy:{id:DESC}) { id title completed assigneeId { id name } } }`,
    }),
  },
  {
    name: "todos.filter",
    weight: 4,
    build: () => ({
      query: `query($w:JSON){ todos(where:$w, limit:10) { id title completed } }`,
      variables: { w: [["completed", "=", Math.random() < 0.5]] },
    }),
  },
  {
    name: "todos.deepRelation",
    weight: 3,
    build: () => ({
      query: `{ todos(limit:5) { id title assigneeId { id name todos(limit:3) { id title } } } }`,
    }),
  },
  {
    name: "todos.single",
    weight: 2,
    build: ({ counter }) => ({
      query: `query($w:JSON){ todosSingle(where:$w) { id title } }`,
      variables: { w: [["id", "=", (counter % 50) + 1]] },
    }),
  },
  {
    name: "users.list",
    weight: 1,
    build: () => ({
      query: `{ users(limit:5) { id name email todos(limit:2) { id title } } }`,
    }),
  },
  {
    name: "todos.insert",
    weight: 2,
    build: ({ userIdx, counter }) => ({
      query: `mutation($v:[TodosInsert!]!){ insertIntoTodos(values:$v) { id } }`,
      variables: { v: [{ title: `stress-${userIdx}-${counter}-${Date.now()}`, assigneeId: userIdx + 1 }] },
    }),
  },
  {
    name: "todos.toggle",
    weight: 2,
    build: ({ counter }) => ({
      query: `mutation($w:JSON,$s:TodosUpdate!){ updateTodos(where:$w, set:$s) { id completed } }`,
      variables: { w: [["id", "=", (counter % 50) + 1]], s: { completed: Math.random() < 0.5 } },
    }),
  },
];

const TOTAL_WEIGHT = OPS.reduce((s, o) => s + o.weight, 0);

function pickOp(): Op {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const o of OPS) {
    r -= o.weight;
    if (r <= 0) return o;
  }
  return OPS[0]!;
}

type Stat = { count: number; errors: number; gqlErrors: number; latencies: number[] };
const stats = new Map<string, Stat>();
function getStat(name: string): Stat {
  let s = stats.get(name);
  if (!s) {
    s = { count: 0, errors: 0, gqlErrors: 0, latencies: [] };
    stats.set(name, s);
  }
  return s;
}

async function runWorker(sessions: Session[], stopAt: number, workerId: number): Promise<void> {
  let counter = 0;
  while (Date.now() < stopAt) {
    const userIdx = workerId % sessions.length;
    const sess = sessions[userIdx]!;
    const op = pickOp();
    const body = op.build({ userIdx, counter: counter++ });
    const stat = getStat(op.name);
    const t0 = performance.now();
    try {
      const res = await fetch(`${URL_BASE}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `sid=${sess.sid}` },
        body: JSON.stringify(body),
      });
      const dt = performance.now() - t0;
      stat.latencies.push(dt);
      stat.count++;
      if (!res.ok) {
        stat.errors++;
      } else {
        const json = (await res.json()) as { errors?: unknown[] };
        if (Array.isArray(json.errors) && json.errors.length > 0) stat.gqlErrors++;
      }
    } catch {
      stat.latencies.push(performance.now() - t0);
      stat.count++;
      stat.errors++;
    }
  }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function fmt(n: number): string {
  return n.toFixed(1).padStart(7);
}

async function main(): Promise<void> {
  console.log(`stress test → ${URL_BASE}  concurrency=${CONCURRENCY}  duration=${DURATION_S}s`);
  const sessions = await Promise.all(USERS.map(login));
  console.log(`logged in: ${sessions.map((s) => s.email).join(", ")}`);

  const start = Date.now();
  const stopAt = start + DURATION_S * 1000;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => runWorker(sessions, stopAt, i)),
  );
  const elapsed = (Date.now() - start) / 1000;

  let totalReq = 0;
  let totalErr = 0;
  let totalGqlErr = 0;
  console.log("");
  console.log(
    `op                    count   errs  gqlErr     rps     p50     p95     p99     max`,
  );
  console.log(
    `-----------------------------------------------------------------------------------`,
  );
  for (const [name, s] of [...stats.entries()].sort()) {
    const sorted = [...s.latencies].sort((a, b) => a - b);
    totalReq += s.count;
    totalErr += s.errors;
    totalGqlErr += s.gqlErrors;
    console.log(
      `${name.padEnd(22)}${String(s.count).padStart(6)}${String(s.errors).padStart(7)}${String(s.gqlErrors).padStart(8)}  ${fmt(s.count / elapsed)} ${fmt(pct(sorted, 50))} ${fmt(pct(sorted, 95))} ${fmt(pct(sorted, 99))} ${fmt(sorted.at(-1) ?? 0)}`,
    );
  }
  console.log(
    `-----------------------------------------------------------------------------------`,
  );
  console.log(
    `TOTAL                 ${String(totalReq).padStart(5)}${String(totalErr).padStart(7)}${String(totalGqlErr).padStart(8)}  ${fmt(totalReq / elapsed)}    (elapsed ${elapsed.toFixed(2)}s)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
