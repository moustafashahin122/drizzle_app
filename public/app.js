// Shared client helpers. The session is held in a same-origin HttpOnly cookie
// set by /auth/* — the browser ships it automatically with every fetch, so
// the JS side just deals with JSON.

async function jsonOrError(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error ?? `HTTP ${res.status}`);
  }
  return data;
}

/** GraphQL fetch wrapper — used by the todo + admin pages for data queries. */
export async function gql(query, variables = {}) {
  const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrf_token="))?.split("=")[1];
  const res = await fetch("/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    credentials: "same-origin",
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    const msg = json.errors[0].message;
    if (/not authenticated|unauthenticated/i.test(msg)) {
      window.location.replace("/login.html");
      return new Promise(() => {});
    }
    throw new Error(msg);
  }
  return json.data;
}

/** Generic REST helper. Reads JSON, throws Error(data.error) on non-2xx. */
export async function api(path, { method = "GET", body } = {}) {
  const init = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    window.location.replace("/login.html");
    return new Promise(() => {});
  }
  return jsonOrError(res);
}

/** Returns the current user, or null if no session. Never throws. */
export async function getMe() {
  try {
    const res = await fetch("/auth/me", { credentials: "same-origin" });
    if (!res.ok) return null;
    const { user } = await res.json();
    return user ?? null;
  } catch {
    return null;
  }
}

/** Redirect to /login.html when no valid session. Returns the current user. */
export async function requireAuth() {
  const me = await getMe();
  if (!me) {
    window.location.replace("/login.html");
    return new Promise(() => {});
  }
  return me;
}

/** Used on /login.html: bounce to / when a valid session already exists. */
export async function redirectIfAuth() {
  const me = await getMe();
  if (me) window.location.replace("/");
}

export async function login(email, password) {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ email, password }),
  });
  return jsonOrError(res);
}

export async function register(name, email, password) {
  const res = await fetch("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ name, email, password }),
  });
  return jsonOrError(res);
}

export async function logout() {
  try {
    const csrf = document.cookie.split("; ").find((c) => c.startsWith("csrf_token="))?.split("=")[1];
    await fetch("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: csrf ? { "X-CSRF-Token": csrf } : {},
    });
  } catch {
    /* ignore — server-side cookie clear is best-effort */
  }
  window.location.replace("/login.html");
}
