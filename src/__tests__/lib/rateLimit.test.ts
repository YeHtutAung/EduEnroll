import { describe, it, expect } from "vitest";
import { createRateLimiter, clientIpFrom } from "@/lib/rateLimit";

// `now` is injected rather than faked globally, so these tests are
// deterministic without touching timers.
function at(t: { ms: number }) {
  return () => t.ms;
}

describe("createRateLimiter", () => {
  it("does not block while the budget is unspent", () => {
    const t = { ms: 0 };
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: at(t) });

    limiter.recordMiss("1.1.1.1");
    limiter.recordMiss("1.1.1.1");

    expect(limiter.isBlocked("1.1.1.1")).toBe(false);
  });

  it("blocks once the budget is spent", () => {
    const t = { ms: 0 };
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: at(t) });

    for (let i = 0; i < 3; i++) limiter.recordMiss("1.1.1.1");

    expect(limiter.isBlocked("1.1.1.1")).toBe(true);
  });

  it("lifts the block once the window has passed", () => {
    const t = { ms: 0 };
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: at(t) });
    for (let i = 0; i < 3; i++) limiter.recordMiss("1.1.1.1");
    expect(limiter.isBlocked("1.1.1.1")).toBe(true);

    t.ms = 60_000;

    expect(limiter.isBlocked("1.1.1.1")).toBe(false);
  });

  it("tracks each key independently", () => {
    const t = { ms: 0 };
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: at(t) });

    limiter.recordMiss("1.1.1.1");
    limiter.recordMiss("1.1.1.1");

    expect(limiter.isBlocked("1.1.1.1")).toBe(true);
    expect(limiter.isBlocked("2.2.2.2")).toBe(false);
  });

  it("reports the seconds remaining until the block lifts", () => {
    const t = { ms: 0 };
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: at(t) });
    limiter.recordMiss("1.1.1.1");

    t.ms = 15_000;

    expect(limiter.retryAfter("1.1.1.1")).toBe(45);
    expect(limiter.retryAfter("2.2.2.2")).toBe(0);
  });

  it("bounds memory by evicting the oldest keys", () => {
    const t = { ms: 0 };
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 2, now: at(t) });

    limiter.recordMiss("oldest");
    t.ms = 1_000;
    limiter.recordMiss("middle");
    t.ms = 2_000;
    limiter.recordMiss("newest");

    // An attacker rotating keys must not grow the map without bound.
    expect(limiter.size()).toBeLessThanOrEqual(2);
    expect(limiter.isBlocked("oldest")).toBe(false);
  });

  it("forgets everything on reset", () => {
    const t = { ms: 0 };
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: at(t) });
    limiter.recordMiss("1.1.1.1");
    expect(limiter.isBlocked("1.1.1.1")).toBe(true);

    limiter.reset();

    expect(limiter.isBlocked("1.1.1.1")).toBe(false);
    expect(limiter.size()).toBe(0);
  });
});

describe("clientIpFrom", () => {
  it("prefers x-real-ip", () => {
    const h = new Headers({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" });
    expect(clientIpFrom(h)).toBe("9.9.9.9");
  });

  it("falls back to the first x-forwarded-for entry", () => {
    const h = new Headers({ "x-forwarded-for": "1.1.1.1, 10.0.0.1, 10.0.0.2" });
    expect(clientIpFrom(h)).toBe("1.1.1.1");
  });

  it("returns a shared bucket rather than nothing when no IP is present", () => {
    // Fail closed: an unidentifiable caller must still be counted, not exempt.
    expect(clientIpFrom(new Headers())).toBe("unknown");
  });
});
