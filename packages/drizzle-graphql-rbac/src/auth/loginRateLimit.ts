/**
 * @module auth/loginRateLimit
 *
 * Rate-limit middleware for `POST /auth/login`. Two sliding-window buckets
 * stack on the route — both must pass for a request to reach the handler:
 *
 *   1. per (IP + email) — guards a known account against brute force
 *   2. per IP           — guards against horizontal scans across many emails
 *
 * Each call to {@link createLoginRateLimit} owns its own `MemoryStore`
 * instances, so there is no shared module-level state. Tests can construct
 * a fresh app per case (with whatever limits they want) instead of reaching
 * into the limiter to reset it.
 */
import type { Context, MiddlewareHandler } from "hono";
import { MemoryStore, rateLimiter } from "hono-rate-limiter";

export interface LoginRateLimitConfig {
  /** Sliding-window length in ms. Defaults to 60_000. */
  windowMs?: number;
  /** Max attempts per (IP, email) within the window. Defaults to 10. */
  maxPerIpEmail?: number;
  /** Max attempts per IP across all emails within the window. Defaults to 30. */
  maxPerIp?: number;
}

export interface LoginRateLimit {
  /** Middlewares to mount on the login route (per-(IP,email) first, per-IP second). */
  middlewares: MiddlewareHandler[];
  /**
   * Clear the requester's buckets — call after a successful login so prior
   * failures stop counting down the limit. Reads the same IP + email the
   * limiter middlewares used.
   */
  onSuccess(c: Context): Promise<void>;
}

const TOO_MANY_BODY = { error: "Too many attempts, try again in a minute" } as const;

/** Best-effort client IP from common proxy headers; falls back to "unknown". */
export function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

function readEmail(body: unknown): string {
  const v = (body as Record<string, unknown> | null)?.email;
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

const ipEmailKey = (ip: string, email: string) => `${ip}|${email}`;

export function createLoginRateLimit(config: LoginRateLimitConfig = {}): LoginRateLimit {
  const windowMs = config.windowMs ?? 60_000;
  const maxPerIpEmail = config.maxPerIpEmail ?? 10;
  const maxPerIp = config.maxPerIp ?? 30;

  const ipEmailStore = new MemoryStore();
  const ipStore = new MemoryStore();
  const handler = (c: Context) => c.json(TOO_MANY_BODY, 429);

  const perIpEmail = rateLimiter({
    store: ipEmailStore,
    windowMs,
    limit: maxPerIpEmail,
    standardHeaders: "draft-7",
    keyGenerator: async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return ipEmailKey(clientIp(c), readEmail(body));
    },
    handler,
  });

  const perIp = rateLimiter({
    store: ipStore,
    windowMs,
    limit: maxPerIp,
    standardHeaders: "draft-7",
    keyGenerator: (c) => clientIp(c),
    handler,
  });

  return {
    middlewares: [perIpEmail, perIp],
    async onSuccess(c) {
      const body = await c.req.json().catch(() => ({}));
      const ip = clientIp(c);
      await ipEmailStore.resetKey(ipEmailKey(ip, readEmail(body)));
      await ipStore.resetKey(ip);
    },
  };
}
