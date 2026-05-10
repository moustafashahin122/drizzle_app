/**
 * @module graphql/rbac/cache
 *
 * Cross-request RBAC cache. Keeps two bounded TTL+LRU stores:
 *
 * - **Effective roles** per user (`userId → { roleIds, isAdmin }`) — the
 *   role row ids the user is assigned in the `userRoles` table, plus a
 *   precomputed `isAdmin` flag if any of those roles is admin-flagged.
 * - **Enforce result** per `(userId, resource, action)` — either the granted
 *   record-rule SQL fragment (or `undefined` for unrestricted) or a
 *   `__forbidden` marker carrying the denial message so cached denials throw
 *   the same error.
 *
 * Both stores share one TTL (`cacheTtlMs`). Bounded `maxEntries` keeps memory
 * predictable; eviction is LRU on read so the hot working set stays warm.
 *
 * Coherence model: entries are valid up to TTL. Callers that mutate a user's
 * role assignments out-of-band (the admin dashboard, sign-out, etc.) should
 * call {@link RbacCache.invalidateUser} so the next request rereads from the
 * DB. Role/access/rule definitions are code-defined and can only change on
 * process restart, so they don't need invalidation.
 */
export interface CachedRoles {
  roleIds: number[];
  isAdmin: boolean;
}

/** A cached enforce result — either a record-rule SQL fragment or a denial. */
export type EnforceEntry<S> = { where?: S } | { __forbidden: string };

/** Tunables for {@link RbacCache}. Defaults disable cross-request caching. */
export interface RbacCacheOptions {
  /**
   * TTL in milliseconds for cross-request RBAC caches. `0` (the default)
   * disables cross-request caching — `RbacCache.enabled` returns `false`
   * and every read is a miss. Callers that mutate user-role membership
   * out-of-band should either keep this `0` or call `invalidateUser` after
   * the mutation.
   * @default 0
   */
  cacheTtlMs?: number;
  /**
   * Max entries in the per-user effective-roles cache (LRU eviction beyond
   * this). Each entry is small (an array of role keys).
   * @default 5000
   */
  rolesCacheMax?: number;
  /**
   * Max entries in the per-`(user,resource,action)` enforce-result cache (LRU
   * eviction beyond this). One entry per distinct triple a user actually
   * touches; in practice far less than `users × resources × 4`.
   * @default 20000
   */
  enforceCacheMax?: number;
}

/**
 * Bounded TTL cache. Map insertion order doubles as LRU order — `get()` on a
 * hit re-inserts the entry to the tail; on overflow we evict from the head.
 * Entries past their `expiresAt` are deleted lazily on read.
 */
export class TtlLruCache<V> {
  private readonly map = new Map<string, { v: V; e: number }>();
  constructor(private readonly maxEntries: number, private readonly ttlMs: number) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.e <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.v;
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { v: value, e: Date.now() + this.ttlMs });
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
  /** Snapshot of current keys (does not check expiry). */
  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

/**
 * Two-store RBAC cache (effective roles + enforce result), each backed by a
 * {@link TtlLruCache}. When TTL is `0` both stores are `null` and every
 * accessor is a no-op miss — callers can use the same instance whether or not
 * caching is enabled.
 */
export class RbacCache<S = unknown> {
  private readonly roles: TtlLruCache<CachedRoles> | null;
  private readonly enforce: TtlLruCache<EnforceEntry<S>> | null;

  constructor(options: RbacCacheOptions = {}) {
    const ttl = options.cacheTtlMs ?? 0;
    this.roles = ttl > 0 ? new TtlLruCache<CachedRoles>(options.rolesCacheMax ?? 5000, ttl) : null;
    this.enforce = ttl > 0
      ? new TtlLruCache<EnforceEntry<S>>(options.enforceCacheMax ?? 20000, ttl)
      : null;
  }

  /** `true` when cross-request caching is on (TTL > 0). */
  get enabled(): boolean {
    return this.roles !== null;
  }

  getRoles(userId: number): CachedRoles | undefined {
    return this.roles?.get(String(userId));
  }
  setRoles(userId: number, value: CachedRoles): void {
    this.roles?.set(String(userId), value);
  }

  private enforceKey(userId: number, resource: string, action: string): string {
    return `${userId}:${resource}:${action}`;
  }
  getEnforce(userId: number, resource: string, action: string): EnforceEntry<S> | undefined {
    return this.enforce?.get(this.enforceKey(userId, resource, action));
  }
  setEnforce(
    userId: number,
    resource: string,
    action: string,
    value: EnforceEntry<S>,
  ): void {
    this.enforce?.set(this.enforceKey(userId, resource, action), value);
  }

  /** Drop every entry for one user (roles + every (resource, action) triple). */
  invalidateUser(userId: number): void {
    this.roles?.delete(String(userId));
    if (!this.enforce) return;
    const prefix = `${userId}:`;
    for (const k of this.enforce.keys()) {
      if (k.startsWith(prefix)) this.enforce.delete(k);
    }
  }

  /** Drop the entire cache. */
  clear(): void {
    this.roles?.clear();
    this.enforce?.clear();
  }
}
