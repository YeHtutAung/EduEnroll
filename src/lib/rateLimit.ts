// Minimal in-process rate limiting.
//
// Deliberately dependency-free and in-memory. On serverless each instance keeps
// its own counters, so a budget of N is really N per warm instance — see the
// caveat on `publicEnrollmentLookupLimiter` below. That is a large cost increase
// for an attacker rather than a hard wall; a durable store is the proper fix.

export interface RateLimiterOptions {
  /** Recorded events allowed within a window before the key is blocked. */
  limit: number;
  windowMs: number;
  /** Upper bound on tracked keys, so key rotation cannot grow memory. */
  maxKeys?: number;
  /** Injectable clock — keeps time-dependent behaviour testable. */
  now?: () => number;
}

export interface RateLimiter {
  /** Counts one event against `key`'s budget. */
  recordMiss(key: string): void;
  isBlocked(key: string): boolean;
  /** Seconds until the block lifts; 0 when not blocked. */
  retryAfter(key: string): number;
  reset(): void;
  size(): number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = 10_000,
  now = Date.now,
}: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, Bucket>();

  // Returns the key's bucket only while its window is still open, dropping it
  // otherwise. Expiry is resolved on read so a stale window can never block.
  function live(key: string): Bucket | undefined {
    const bucket = buckets.get(key);
    if (!bucket) return undefined;
    if (now() - bucket.windowStart >= windowMs) {
      buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  function prune(): void {
    if (buckets.size <= maxKeys) return;
    const t = now();
    for (const [key, bucket] of buckets) {
      if (t - bucket.windowStart >= windowMs) buckets.delete(key);
    }
    while (buckets.size > maxKeys) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [key, bucket] of buckets) {
        if (bucket.windowStart < oldest) {
          oldest = bucket.windowStart;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      buckets.delete(oldestKey);
    }
  }

  return {
    recordMiss(key) {
      const bucket = live(key);
      if (bucket) bucket.count += 1;
      else buckets.set(key, { count: 1, windowStart: now() });
      prune();
    },
    isBlocked(key) {
      const bucket = live(key);
      return bucket !== undefined && bucket.count >= limit;
    },
    retryAfter(key) {
      const bucket = live(key);
      if (!bucket || bucket.count < limit) return 0;
      return Math.ceil((bucket.windowStart + windowMs - now()) / 1000);
    },
    reset() {
      buckets.clear();
    },
    size() {
      return buckets.size;
    },
  };
}

/**
 * Best-effort client address.
 *
 * Trustworthy only behind a proxy that overwrites these headers (Vercel does).
 * If the app is ever exposed directly, a client can set them freely and defeat
 * any per-address budget.
 *
 * An unidentifiable caller shares one bucket rather than being exempt: failing
 * open here would hand an attacker a trivial bypass — just omit the header.
 */
export function clientIpFrom(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (first) return first;
  return "unknown";
}

/**
 * Budget for *failed* `GET /api/public/enrollment/[ref]` lookups.
 *
 * `enrollment_ref` is the access token for that route and is short enough that
 * the reference space cannot be treated as unguessable. A successful response
 * carries order details and ticket credentials.
 *
 * Only misses are counted, and that is the important part of the design: a
 * venue full of attendees behind one NAT address all opening valid ticket links
 * generates successes, not misses, so they are never throttled. Enumeration is
 * almost entirely misses and trips the budget immediately.
 *
 * Once the budget is spent every request from that address is refused, not just
 * the misses — refusing misses alone would leave the sweep working, since a hit
 * would still answer 200 and reveal a valid reference.
 */
export const publicEnrollmentLookupLimiter = createRateLimiter({
  limit: 10,
  windowMs: 10 * 60_000,
});
