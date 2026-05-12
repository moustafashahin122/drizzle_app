/**
 * @module auth/csrf.test
 *
 * Unit tests for {@link createCsrfProtection}. The contract under test is
 * the wrapper's behaviour as observed through a minimal Hono app — we
 * intentionally do not mock `hono/csrf`; the wrapper's only job is to
 * forward config faithfully and hand back a working middleware.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createCsrfProtection, type CsrfConfig } from "./csrf.js";

/** A tiny app with one mutating + one safe route, protected by the wrapper. */
function makeApp(config?: CsrfConfig) {
  const app = new Hono();
  app.use("*", createCsrfProtection(config).middleware);
  // `app.all` covers every HTTP method including HEAD (which Hono doesn't
  // expose as a named helper); a single handler keeps the test fixture small.
  app.all("/r", (c) => c.text("ok"));
  return app;
}

/** Helper: POST with a chosen content-type + optional Origin / Sec-Fetch-Site. */
function postForm(
  app: ReturnType<typeof makeApp>,
  contentType: string,
  init: { origin?: string; secFetchSite?: string; url?: string; method?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": contentType };
  if (init.origin !== undefined) headers.origin = init.origin;
  if (init.secFetchSite !== undefined) headers["sec-fetch-site"] = init.secFetchSite;
  // Body content irrelevant for the CSRF decision (middleware never reads it),
  // but multipart needs a boundary token for content-type to parse.
  const body =
    contentType.startsWith("multipart/form-data") ? "--xxx--" :
    contentType.startsWith("application/x-www-form-urlencoded") ? "a=1" :
    "hello";
  return app.request(init.url ?? "http://app.localhost/r", {
    method: init.method ?? "POST",
    headers,
    body,
  });
}

describe("createCsrfProtection — default (same-origin) policy", () => {
  it("safe methods (GET, HEAD) are never blocked, even cross-origin form-style", async () => {
    const app = makeApp();
    for (const method of ["GET", "HEAD"]) {
      const res = await app.request("http://app.localhost/r", {
        method,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://evil.example",
        },
      });
      assert.equal(res.status, 200, `${method} should pass`);
    }
  });

  it("JSON POSTs are not inspected (browsers require preflight for cross-origin JSON)", async () => {
    const app = makeApp();
    const res = await app.request("http://app.localhost/r", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(res.status, 200);
  });

  it("form-submittable POST with same-origin Origin passes", async () => {
    const app = makeApp();
    const res = await postForm(app, "application/x-www-form-urlencoded", {
      origin: "http://app.localhost",
    });
    assert.equal(res.status, 200);
  });

  it("form-submittable POST with foreign Origin is blocked (403)", async () => {
    const app = makeApp();
    for (const ct of [
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=xxx",
      "text/plain",
    ]) {
      const res = await postForm(app, ct, { origin: "http://evil.example" });
      assert.equal(res.status, 403, `content-type ${ct} from foreign origin should be 403`);
    }
  });

  it("form-submittable POST with no Origin and no Sec-Fetch-Site is blocked (403)", async () => {
    // The middleware can't prove the request is same-origin → fail closed.
    const app = makeApp();
    const res = await postForm(app, "application/x-www-form-urlencoded");
    assert.equal(res.status, 403);
  });

  it("Sec-Fetch-Site: same-origin allows a form POST even when Origin is missing", async () => {
    const app = makeApp();
    const res = await postForm(app, "application/x-www-form-urlencoded", {
      secFetchSite: "same-origin",
    });
    assert.equal(res.status, 200);
  });

  it("Sec-Fetch-Site: cross-site does not rescue a foreign-origin form POST", async () => {
    const app = makeApp();
    const res = await postForm(app, "application/x-www-form-urlencoded", {
      origin: "http://evil.example",
      secFetchSite: "cross-site",
    });
    assert.equal(res.status, 403);
  });

  it("non-GET/HEAD unsafe methods (PUT, DELETE) are gated the same as POST", async () => {
    const app = makeApp();
    for (const method of ["PUT", "DELETE"]) {
      const blocked = await postForm(app, "application/x-www-form-urlencoded", {
        method,
        origin: "http://evil.example",
      });
      assert.equal(blocked.status, 403, `${method} from foreign origin should be 403`);

      const allowed = await postForm(app, "application/x-www-form-urlencoded", {
        method,
        origin: "http://app.localhost",
      });
      assert.equal(allowed.status, 200, `${method} from same origin should pass`);
    }
  });
});

describe("createCsrfProtection — explicit origin allowlist", () => {
  it("string origin permits only that exact origin", async () => {
    const app = makeApp({ origin: "https://app.example" });
    const ok = await postForm(app, "application/x-www-form-urlencoded", {
      origin: "https://app.example",
    });
    assert.equal(ok.status, 200);

    const bad = await postForm(app, "application/x-www-form-urlencoded", {
      origin: "https://other.example",
    });
    assert.equal(bad.status, 403);

    // Crucially, the request URL's own origin is *not* implicitly allowed
    // once an explicit `origin` is set — the allowlist is exhaustive.
    const sameAsUrl = await postForm(app, "application/x-www-form-urlencoded", {
      origin: "http://app.localhost",
    });
    assert.equal(sameAsUrl.status, 403);
  });

  it("string[] origin permits any value in the list and rejects others", async () => {
    const app = makeApp({ origin: ["https://a.example", "https://b.example"] });
    for (const origin of ["https://a.example", "https://b.example"]) {
      const r = await postForm(app, "application/x-www-form-urlencoded", { origin });
      assert.equal(r.status, 200, `${origin} should be allowed`);
    }
    const bad = await postForm(app, "application/x-www-form-urlencoded", {
      origin: "https://c.example",
    });
    assert.equal(bad.status, 403);
  });

  it("function origin predicate receives each origin and gates per its return value", async () => {
    const seen: string[] = [];
    const app = makeApp({
      origin: (origin) => {
        seen.push(origin);
        return origin.endsWith(".trusted");
      },
    });

    const ok = await postForm(app, "application/x-www-form-urlencoded", {
      origin: "https://x.trusted",
    });
    assert.equal(ok.status, 200);

    const bad = await postForm(app, "application/x-www-form-urlencoded", {
      origin: "https://x.evil",
    });
    assert.equal(bad.status, 403);

    assert.deepEqual(seen, ["https://x.trusted", "https://x.evil"]);
  });

  it("async function origin predicate is awaited", async () => {
    const app = makeApp({
      origin: async (origin) => {
        await Promise.resolve();
        return origin === "https://async.example";
      },
    });
    const ok = await postForm(app, "application/x-www-form-urlencoded", {
      origin: "https://async.example",
    });
    assert.equal(ok.status, 200);

    const bad = await postForm(app, "application/x-www-form-urlencoded", {
      origin: "https://other.example",
    });
    assert.equal(bad.status, 403);
  });
});

describe("createCsrfProtection — factory shape", () => {
  it("each call returns an independent middleware instance", () => {
    const a = createCsrfProtection();
    const b = createCsrfProtection();
    assert.notEqual(a.middleware, b.middleware);
    assert.equal(typeof a.middleware, "function");
  });

  it("default config (no argument) behaves identically to {}", async () => {
    const defaulted = makeApp();
    const empty = makeApp({});
    // Both should block a foreign-origin form POST.
    const [r1, r2] = await Promise.all([
      postForm(defaulted, "application/x-www-form-urlencoded", { origin: "http://evil.example" }),
      postForm(empty, "application/x-www-form-urlencoded", { origin: "http://evil.example" }),
    ]);
    assert.equal(r1.status, 403);
    assert.equal(r2.status, 403);
  });
});
