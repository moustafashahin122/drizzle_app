// Shared client helpers: token storage, GraphQL fetch wrapper, light auth
// gates. Until RBAC lands, gating is purely client-side; the server still
// enforces "logged in" on the auth resolvers and `createUser`.

const TOKEN_KEY = "auth.token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export async function gql(query, variables = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch("/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    const msg = json.errors[0].message;
    // If the server rejects the session, drop it so the next page load
    // bounces to /login.html instead of looping on a stale token.
    if (/not authenticated/i.test(msg)) clearToken();
    throw new Error(msg);
  }
  return json.data;
}

export async function getMe() {
  if (!getToken()) return null;
  try {
    const { me } = await gql(`{ me { id name email active } }`);
    return me;
  } catch {
    return null;
  }
}

/** Redirect to /login.html when no valid session. Returns the current user. */
export async function requireAuth() {
  const me = await getMe();
  if (!me) {
    clearToken();
    window.location.replace("/login.html");
    // Promise that never resolves so callers' await pauses until redirect.
    return new Promise(() => {});
  }
  return me;
}

/** Used on /login.html: bounce to / when a valid session already exists. */
export async function redirectIfAuth() {
  const me = await getMe();
  if (me) window.location.replace("/");
}

export async function logout() {
  try {
    await gql(`mutation { logout }`);
  } catch {
    /* ignore — we're clearing local state regardless */
  }
  clearToken();
  window.location.replace("/login.html");
}
