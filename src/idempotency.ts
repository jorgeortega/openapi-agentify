/**
 * Where `Idempotency-Key` records live. The default keeps them in memory, in
 * this process: right for one instance and for development. For several
 * instances, pass a store backed by your database (`idempotency.store`); any
 * object with these three methods works.
 */

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  /** The body, base64. */
  body: string;
}

export type IdempotencyBegin = { state: "new" } | { state: "in_progress" } | { state: "mismatch" } | { state: "completed"; response: StoredResponse };

export interface IdempotencyStore {
  /**
   * Claims `key` for a request whose contents hash to `requestHash`: "new" (go
   * ahead; the claim is held for `lockMs`), "in_progress" (another request
   * holds it), "mismatch" (the key was used with different contents) or
   * "completed" (the stored answer to replay). Records live for `ttlMs`.
   */
  beginIdempotent(key: string, requestHash: string, lockMs: number, ttlMs: number): Promise<IdempotencyBegin>;
  /** Stores the answer for `key`. */
  completeIdempotent(key: string, response: StoredResponse): Promise<void>;
  /** Drops the claim on `key` (the request failed; a retry may run). */
  releaseIdempotent(key: string): Promise<void>;
}

interface Entry {
  hash: string;
  lockedUntil: number;
  expiresAt: number;
  response: StoredResponse | null;
}

/** An in-memory IdempotencyStore holding at most `max` records (oldest dropped first). */
export function memoryIdempotencyStore(opts: { now?: () => number; max?: number } = {}): IdempotencyStore {
  const now = opts.now ?? Date.now;
  const max = opts.max ?? 10_000;
  const entries = new Map<string, Entry>();

  function sweep(t: number) {
    for (const [k, e] of entries) if (e.expiresAt < t) entries.delete(k);
    while (entries.size >= max) entries.delete(entries.keys().next().value!);
  }

  return {
    async beginIdempotent(key, requestHash, lockMs, ttlMs) {
      const t = now();
      let e = entries.get(key);
      if (e && e.expiresAt < t) {
        entries.delete(key);
        e = undefined;
      }
      if (!e) {
        if (entries.size >= max) sweep(t);
        entries.set(key, { hash: requestHash, lockedUntil: t + lockMs, expiresAt: t + ttlMs, response: null });
        return { state: "new" };
      }
      if (e.hash !== requestHash) return { state: "mismatch" };
      if (e.response) return { state: "completed", response: e.response };
      if (e.lockedUntil > t) return { state: "in_progress" };
      // The first attempt died holding the claim: this one takes over.
      e.lockedUntil = t + lockMs;
      return { state: "new" };
    },
    async completeIdempotent(key, response) {
      const e = entries.get(key);
      if (e) e.response = response;
    },
    async releaseIdempotent(key) {
      const e = entries.get(key);
      if (e && !e.response) entries.delete(key);
    },
  };
}
