import { describe, it, expect, afterEach } from "vitest";
import { isAllowedRedirect } from "@/lib/payments/redirect-allowlist";

const ENV_KEYS = ["NEXT_PUBLIC_APP_URL", "VERCEL_ENV"] as const;
const ORIGINAL = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

// Delete-aware: `process.env.X = undefined` stores the STRING "undefined".
afterEach(() => {
  for (const k of ENV_KEYS) {
    const original = ORIGINAL[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
});

function prod() {
  process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
  process.env.VERCEL_ENV = "production";
}

const TENANT = "nihon-moment";
const REQ_ORIGIN = "https://nihon-moment.kuunyi.com";

describe("isAllowedRedirect — accepts the tenant's own origin", () => {
  it("allows the tenant's canonical origin", () => {
    prod();
    expect(
      isAllowedRedirect(
        "https://nihon-moment.kuunyi.com/enroll/x?hitpay=success",
        TENANT,
        REQ_ORIGIN,
      ),
    ).toBe(true);
  });

  it("allows any path and query on that origin", () => {
    prod();
    expect(isAllowedRedirect("https://nihon-moment.kuunyi.com/", TENANT, REQ_ORIGIN)).toBe(true);
  });
});

describe("isAllowedRedirect — rejects", () => {
  it("rejects an unrelated origin", () => {
    prod();
    expect(isAllowedRedirect("https://evil.com/phish", TENANT, REQ_ORIGIN)).toBe(false);
  });

  // The reason prefix matching is banned.
  it("rejects a lookalike suffix host", () => {
    prod();
    expect(isAllowedRedirect("https://nihon-moment.kuunyi.com.evil.com/x", TENANT, REQ_ORIGIN)).toBe(
      false,
    );
  });

  it("rejects another tenant's origin", () => {
    prod();
    expect(isAllowedRedirect("https://rival.kuunyi.com/enroll/x", TENANT, REQ_ORIGIN)).toBe(false);
  });

  it("rejects the platform root (no enrollment page lives there)", () => {
    prod();
    expect(isAllowedRedirect("https://kuunyi.com/", TENANT, REQ_ORIGIN)).toBe(false);
  });

  // URL.origin DISCARDS credentials, so this passes an origin check while the
  // browser shows a credential-stuffed URL. Needs its own rejection.
  it("rejects a credential-bearing URL whose origin otherwise matches", () => {
    prod();
    expect(
      isAllowedRedirect("https://user:pass@nihon-moment.kuunyi.com/x", TENANT, REQ_ORIGIN),
    ).toBe(false);
  });

  it("rejects http when the allowed origin is https", () => {
    prod();
    expect(isAllowedRedirect("http://nihon-moment.kuunyi.com/x", TENANT, REQ_ORIGIN)).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    prod();
    for (const bad of ["", "not a url", "/enroll/relative", "javascript:alert(1)", "//evil.com"]) {
      expect(() => isAllowedRedirect(bad, TENANT, REQ_ORIGIN)).not.toThrow();
      expect(isAllowedRedirect(bad, TENANT, REQ_ORIGIN)).toBe(false);
    }
  });

  // In production the request origin gets no latitude: only the canonical
  // tenant origin is allowed, so a Host that somehow differs cannot widen it.
  it("does not trust the request origin in production", () => {
    prod();
    expect(isAllowedRedirect("https://flashtic.com/enroll/x", TENANT, "https://flashtic.com")).toBe(
      false,
    );
  });
});

describe("isAllowedRedirect — non-production", () => {
  it("allows the request's own origin on a preview deployment", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
    process.env.VERCEL_ENV = "preview";
    const preview = "https://edu-enroll-git-x.vercel.app";
    expect(isAllowedRedirect(`${preview}/enroll/x`, TENANT, preview)).toBe(true);
  });

  it("allows localhost and the LAN dev host when unset (local dev)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3005";
    delete process.env.VERCEL_ENV;
    expect(isAllowedRedirect("http://localhost:3005/enroll/x", TENANT, "http://localhost:3005")).toBe(
      true,
    );
    expect(
      isAllowedRedirect("http://192.168.50.3:3005/enroll/x", TENANT, "http://192.168.50.3:3005"),
    ).toBe(true);
  });

  // Even off production, an arbitrary origin is not allowed — only the one the
  // request actually arrived on.
  it("still rejects an unrelated origin on a preview deployment", () => {
    process.env.VERCEL_ENV = "preview";
    expect(
      isAllowedRedirect("https://evil.com/x", TENANT, "https://edu-enroll-git-x.vercel.app"),
    ).toBe(false);
  });

  // THE ONE THAT MATTERS: without a hostname check the request origin allows
  // ITSELF — candidate and requestOrigin match, so the environment gate alone
  // would return true. VERCEL_ENV is not a control on its own.
  it("does not let an unknown request origin allow itself off production", () => {
    process.env.VERCEL_ENV = "preview";
    expect(isAllowedRedirect("https://evil.com/phish", TENANT, "https://evil.com")).toBe(false);
  });

  it("does not let a lookalike dev host allow itself", () => {
    process.env.VERCEL_ENV = "preview";
    for (const rogue of [
      "https://vercel.app.evil.com",
      "https://notlocalhost",
      "https://evil.com:3005",
    ]) {
      expect(isAllowedRedirect(`${rogue}/phish`, TENANT, rogue)).toBe(false);
    }
  });
});
