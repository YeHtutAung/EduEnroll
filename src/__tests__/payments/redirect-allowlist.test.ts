import { describe, it, expect, afterEach } from "vitest";
import { isAllowedRedirect } from "@/lib/payments/redirect-allowlist";

const ENV_KEYS = ["NEXT_PUBLIC_APP_URL", "VERCEL_ENV", "TENANT_CUSTOM_DOMAINS"] as const;
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
  // Reset, not just restore. afterEach puts back the ORIGINAL value, which may
  // itself be set on a dev machine or in CI — every test would then start with
  // an ambient map feeding allowedOrigins(). Start from no map.
  delete process.env.TENANT_CUSTOM_DOMAINS;
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

describe("isAllowedRedirect — tenant custom origin", () => {
  it("allows a tenant's configured custom origin in production", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(
      isAllowedRedirect("https://flashtic.com/enroll/x?hitpay=success", "flashtic", REQ_ORIGIN),
    ).toBe(true);
  });

  // THE REQUIREMENT: the custom origin is allowed for ITS tenant only.
  it("rejects one tenant's custom origin for a different tenant", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(isAllowedRedirect("https://flashtic.com/enroll/x", "nihon-moment", REQ_ORIGIN)).toBe(
      false,
    );
  });

  it("rejects a custom origin lookalike", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(isAllowedRedirect("https://flashtic.com.evil.com/x", "flashtic", REQ_ORIGIN)).toBe(false);
  });

  it("rejects a credential-bearing custom origin", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(isAllowedRedirect("https://user:pass@flashtic.com/x", "flashtic", REQ_ORIGIN)).toBe(
      false,
    );
  });

  it("still allows the tenant's canonical origin when it has a custom domain", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(isAllowedRedirect("https://flashtic.kuunyi.com/enroll/x", "flashtic", REQ_ORIGIN)).toBe(
      true,
    );
  });

  // No map configured is the state everywhere today: behaviour must not change.
  it("changes nothing for a tenant with no custom domain", () => {
    prod();
    delete process.env.TENANT_CUSTOM_DOMAINS;
    expect(isAllowedRedirect("https://flashtic.com/x", "flashtic", REQ_ORIGIN)).toBe(false);
    expect(isAllowedRedirect(`${REQ_ORIGIN}/enroll/x`, "nihon-moment", REQ_ORIGIN)).toBe(true);
  });
});

// #166 folds www to the apex, so www.flashtic.com resolves to tenant flashtic
// and Vercel serves it. But customOriginForTenant returns only the apex, so a
// student who landed on www — window.location.origin is www — would 400.
describe("isAllowedRedirect — www of a custom domain", () => {
  it("allows www of the tenant's custom domain", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(
      isAllowedRedirect(
        "https://www.flashtic.com/enroll/x?hitpay=success",
        "flashtic",
        "https://www.flashtic.com",
      ),
    ).toBe(true);
  });

  // The student returns to the origin they started on — the client builds the
  // URL from window.location.origin, so apex→apex and www→www are the only
  // combinations that occur. The apex is also allowed from a www request
  // because it is the configured custom origin.
  it("allows the apex from a www request", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(isAllowedRedirect("https://flashtic.com/x", "flashtic", "https://www.flashtic.com")).toBe(
      true,
    );
  });

  // Deliberately NOT allowed: a student on the apex cannot be sent to www. Same
  // tenant, but a different origin, and no client produces it — the return goes
  // back where the student started.
  it("does not allow www from an apex request", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(isAllowedRedirect("https://www.flashtic.com/x", "flashtic", "https://flashtic.com")).toBe(
      false,
    );
  });

  // Cross-tenant must survive the www allowance.
  it("rejects www of one tenant's custom domain for a different tenant", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(
      isAllowedRedirect("https://www.flashtic.com/x", "nihon-moment", "https://www.flashtic.com"),
    ).toBe(false);
  });

  // The resolver is the gate, not the request. An unknown host resolves to null
  // and must not allow itself — the flaw this pattern is designed to avoid.
  it("does not let an unconfigured request origin allow itself in production", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(isAllowedRedirect("https://evil.com/phish", "flashtic", "https://evil.com")).toBe(false);
    expect(
      isAllowedRedirect("https://www.evil.com/phish", "flashtic", "https://www.evil.com"),
    ).toBe(false);
  });

  it("rejects a www lookalike", () => {
    prod();
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    expect(
      isAllowedRedirect("https://www.flashtic.com.evil.com/x", "flashtic", "https://flashtic.com"),
    ).toBe(false);
  });
});
