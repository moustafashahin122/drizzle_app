/**
 * @module drizzle-graphql-rbac/testing/httpTestUtils
 *
 * Shared helpers for HTTP-style test fixtures: cookie extraction (with the
 * Headers#getSetCookie polyfill folded in once) and a JSON-aware fetch
 * wrapper that works against any Hono app.
 */

interface HonoLike {
  // Hono's `.request` is declared as `Response | Promise<Response>`; widen to
  // match so the test fixture types pass.
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

/**
 * Read every `Set-Cookie` header off a response. Node's WHATWG `Headers` only
 * exposes a single concatenated value via `get("set-cookie")`; the newer
 * `getSetCookie()` returns them as a list. This helper picks whichever is
 * available so callers don't have to.
 */
export function getSetCookieList(res: Response): string[] {
  const anyHdr = res.headers as unknown as {
    getSetCookie?: () => string[];
  };
  if (typeof anyHdr.getSetCookie === "function") return anyHdr.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

/**
 * Pull a single cookie value out of a Set-Cookie list. Returns `null` when
 * the cookie is missing or has an empty value.
 */
export function cookieValue(list: string[], name: string): string | null {
  for (const raw of list) {
    const first = raw.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    if (first.slice(0, eq).trim() !== name) continue;
    const v = first.slice(eq + 1).trim();
    return v || null;
  }
  return null;
}

export interface JsonFetchOpts {
  /** Object → JSON.stringify + content-type: application/json (unless overridden). */
  body?: unknown;
  /** Raw body string. Pairs with `contentType` when the route needs e.g. form-encoding. */
  rawBody?: BodyInit;
  /** Explicit content-type. Overrides the auto-JSON default. */
  contentType?: string;
  /** Extra headers merged in first; convenience opts below override on collision. */
  headers?: Record<string, string>;
  /** Sets `Authorization: Bearer <token>`. */
  bearer?: string;
  /** Sets the `Cookie` header verbatim — pass e.g. `sid=<token>`. */
  cookie?: string;
}

export interface JsonFetchResult {
  status: number;
  /** Parsed JSON when the response body is valid JSON, otherwise the raw text, else `null`. */
  body: any;
  /** Every `Set-Cookie` header on the response, in order. */
  setCookies: string[];
}

/**
 * Fire a request at a Hono app and parse the response. Accepts either a full
 * URL (when the route handler cares about origin, e.g. CSRF) or a bare path.
 */
export async function jsonFetch(
  app: HonoLike,
  method: string,
  path: string,
  opts: JsonFetchOpts = {},
): Promise<JsonFetchResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    if (opts.contentType) headers["content-type"] = opts.contentType;
  } else if (opts.body !== undefined) {
    headers["content-type"] = opts.contentType ?? "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  } else if (opts.contentType) {
    headers["content-type"] = opts.contentType;
  }
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = opts.cookie;

  const res = await app.request(path, { method, headers, body });
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try { parsed = JSON.parse(text); }
    catch { parsed = text; }
  }
  return { status: res.status, body: parsed, setCookies: getSetCookieList(res) };
}
