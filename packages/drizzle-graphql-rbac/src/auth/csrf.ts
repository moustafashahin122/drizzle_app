/**
 * @module auth/csrf
 *
 * Thin facade around Hono's built-in `csrf` middleware (origin-based CSRF
 * defense). The middleware short-circuits and only inspects requests that
 * are *plausibly forged from another site*:
 *
 *   1. The HTTP method is unsafe (anything other than GET / HEAD).
 *   2. The Content-Type is form-submittable from a `<form>` element —
 *      `application/x-www-form-urlencoded`, `multipart/form-data`, or
 *      `text/plain`. These are the only content types a browser will send
 *      cross-origin without first issuing a CORS preflight.
 *
 * When both hold, the request must satisfy at least one of:
 *
 *   - `Sec-Fetch-Site` matches the configured policy (default `same-origin`).
 *   - `Origin` matches the allow-list (default: same as the request URL).
 *
 * If neither matches, the middleware responds `403 Forbidden`.
 *
 * JSON requests are not inspected: browsers require a CORS preflight to
 * send `application/json` cross-origin, so a SOP-compliant browser cannot
 * forge them on its own. APIs that only accept JSON are therefore covered
 * by content-type negotiation alone; this middleware closes the
 * form-submission hole that lives outside that protection.
 *
 * @example
 * import { createCsrfProtection } from "drizzle-graphql-rbac/auth/csrf";
 *
 * // Default: same-origin only.
 * app.use("*", createCsrfProtection().middleware);
 *
 * // Multiple trusted origins (e.g. a separate admin SPA host):
 * app.use("*", createCsrfProtection({
 *   origin: ["https://app.example.com", "https://admin.example.com"],
 * }).middleware);
 */
import { csrf } from "hono/csrf";
import type { Context, MiddlewareHandler } from "hono";

export type CsrfOriginOption =
  | string
  | string[]
  | ((origin: string, c: Context) => boolean | Promise<boolean>);

export interface CsrfConfig {
  /**
   * Origin(s) allowed for state-changing, form-submittable requests.
   *  - omitted   → same-origin (the request URL's own origin)
   *  - string    → that origin only (e.g. `"https://app.example.com"`)
   *  - string[]  → any of those origins
   *  - function  → custom predicate `(origin, c) => boolean | Promise<boolean>`
   */
  origin?: CsrfOriginOption;
}

export interface CsrfProtection {
  /** Hono middleware to mount globally (or scoped to mutating routes). */
  middleware: MiddlewareHandler;
}

/**
 * Build a CSRF-protection middleware instance. Each call returns a fresh
 * middleware closed over the supplied {@link CsrfConfig}; mount with
 * `app.use("*", protection.middleware)`.
 *
 * `/auth/logout` is exempted: its only effect is destroying the caller's own
 * session, so a forged hit is at worst a self-DoS (the victim has to log in
 * again). Exempting it removes a per-call Origin-header requirement that
 * non-browser clients (curl, mobile, the framework's own test suite) would
 * otherwise have to satisfy.
 */
export function createCsrfProtection(config: CsrfConfig = {}): CsrfProtection {
  const inner = csrf({ origin: config.origin });
  const middleware: MiddlewareHandler = (c, next) => {
    if (c.req.path === "/auth/logout") return next();
    return inner(c, next);
  };
  return { middleware };
}
