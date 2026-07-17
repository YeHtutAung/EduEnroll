import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

// Middleware calls Supabase auth.getUser(); stub it so these stay offline and
// deterministic. Without this, tests fail inside createServerClient() before
// reaching any tenant assertion.
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));

// process.env.X = undefined stores the STRING "undefined", not an absent var —
// which leaks between tests and causes order-dependent failures in the full
// suite. Every mutated variable must be restored delete-aware.
const ENV_KEYS = [
  "VERCEL_ENV",
  "TENANT_CUSTOM_DOMAINS",
  "NEXT_PUBLIC_DEV_TENANT",
  "NEXT_PUBLIC_APP_URL",
] as const;

const ORIGINAL = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(key: (typeof ENV_KEYS)[number]) {
  const original = ORIGINAL[key];
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

afterEach(() => {
  for (const k of ENV_KEYS) restoreEnv(k);
});

// ─── Host-aware request factory — REQUIRED, do not inline NextRequest ────────
// Verified against this runtime:
//   new NextRequest(new Request("https://flashtic.com/enroll"))
//     .headers.get("host")  →  null
//   ...while .nextUrl.hostname → "flashtic.com"
//
// Middleware reads `request.headers.get("host") ?? ""` — NOT nextUrl. So a test
// built from the URL alone hands middleware an EMPTY host, and every hostname
// assertion then passes or fails for a reason unrelated to its name. Host
// resolution is this feature's primary security boundary; a suite that doesn't
// set the header doesn't test it.
//
// Host is a forbidden header in browsers but settable under Node/undici —
// verified: Headers.set("host", ...) reads back correctly here.
//
// The URL's host always wins over any caller-supplied host header, so a
// spoofing test can never accidentally evaluate a different host than its title.
function middlewareRequest(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(url).host);
  return new NextRequest(new Request(url, { ...init, headers }));
}

const slug = (res: Response) => res.headers.get("x-middleware-request-x-tenant-slug");

// An unknown production host cannot acquire tenant context through the
// development fallback: query parameter, cookie, or NEXT_PUBLIC_DEV_TENANT.
//
// Scope, deliberately: a caller-supplied x-tenant-slug header IS still honoured
// where no tenant resolves. That is acknowledged debt (Follow-up F2) — it
// collides with requireAuth()'s agent contract, which requires that header.
// Do not read this group as "unknown hosts cannot get a tenant, full stop".
describe("middleware — unknown hosts cannot use the dev fallback", () => {
  function prodGet(url: string, init?: RequestInit) {
    process.env.VERCEL_ENV = "production";
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
    process.env.NEXT_PUBLIC_DEV_TENANT = "nihon-moment";
    return middleware(middlewareRequest(url, init));
  }

  it("ignores ?tenant= on an unknown host", async () => {
    expect(slug(await prodGet("https://flashtic.evil.com/enroll?tenant=flashtic"))).toBeNull();
  });

  it("ignores an x-tenant-slug cookie on an unknown host", async () => {
    const res = await prodGet("https://flashtic.evil.com/enroll", {
      headers: { cookie: "x-tenant-slug=flashtic" },
    });
    expect(slug(res)).toBeNull();
  });

  it("ignores NEXT_PUBLIC_DEV_TENANT on an unknown host in production", async () => {
    expect(slug(await prodGet("https://flashtic.evil.com/enroll"))).toBeNull();
  });

  it("ignores ?tenant= on a bare IP in production", async () => {
    expect(slug(await prodGet("https://192.168.50.3/enroll?tenant=flashtic"))).toBeNull();
  });

  // A configured custom domain overwrites any inbound header — which is why the
  // header trust boundary (Follow-up F2) is not this plan's problem. Where a
  // tenant DOES resolve, the resolver wins; where it doesn't, F2 applies.
  it("overwrites a forged tenant header on a configured custom domain", async () => {
    const res = await prodGet("https://flashtic.com/enroll", {
      headers: { "x-tenant-slug": "victim-tenant" },
    });
    expect(slug(res)).toBe("flashtic");
  });

  it("overwrites a forged tenant header on a tenant's own kuunyi subdomain", async () => {
    const res = await prodGet("https://nihon-moment.kuunyi.com/enroll", {
      headers: { "x-tenant-slug": "victim-tenant" },
    });
    expect(slug(res)).toBe("nihon-moment");
  });
});

// The conveniences must still work where they are meant to.
describe("middleware — dev fallback still works off production", () => {
  function devGet(url: string) {
    delete process.env.VERCEL_ENV; // local
    process.env.NEXT_PUBLIC_DEV_TENANT = "nihon-moment";
    return middleware(middlewareRequest(url));
  }

  it("honours ?tenant= on localhost", async () => {
    expect(slug(await devGet("http://localhost:3005/enroll?tenant=acme"))).toBe("acme");
  });

  it("honours NEXT_PUBLIC_DEV_TENANT on localhost", async () => {
    expect(slug(await devGet("http://localhost:3005/enroll"))).toBe("nihon-moment");
  });

  it("honours the LAN dev host", async () => {
    expect(slug(await devGet("http://192.168.50.3:3005/enroll"))).toBe("nihon-moment");
  });

  it("resolves tenant.localhost via the resolver, not the fallback", async () => {
    expect(slug(await devGet("http://acme.localhost:3005/enroll"))).toBe("acme");
  });

  // Preview deployments are 3-part vercel.app hosts and depend on the fallback;
  // staging CI targets one. NODE_ENV would be "production" here.
  it("honours NEXT_PUBLIC_DEV_TENANT on a preview deployment", async () => {
    process.env.VERCEL_ENV = "preview";
    process.env.NEXT_PUBLIC_DEV_TENANT = "nihon-moment";
    const res = await middleware(
      middlewareRequest("https://edu-enroll-xi-git-staging-abc.vercel.app/enroll"),
    );
    expect(slug(res)).toBe("nihon-moment");
  });
});

// Uses the middlewareRequest() factory and ENV_KEYS restoration above.
function get(url: string) {
  process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
  return middleware(middlewareRequest(url));
}

describe("middleware — custom domain tenant resolution", () => {
  it("resolves a custom domain, and www of it, to its tenant", async () => {
    for (const host of ["flashtic.com", "www.flashtic.com"]) {
      const res = await get(`https://${host}/enroll/spring`);
      expect(slug(res)).toBe("flashtic");
    }
  });

  // The security property this design leans on.
  it("ignores ?tenant= on a custom domain", async () => {
    expect(slug(await get("https://flashtic.com/enroll/spring?tenant=rival"))).toBe("flashtic");
  });

  it("leaves kuunyi subdomain routing unchanged", async () => {
    expect(slug(await get("https://nihon-moment.kuunyi.com/enroll/spring"))).toBe("nihon-moment");
  });
});

describe("middleware — custom domain surface split", () => {
  it("sends the custom domain root to the tenant's enroll index", async () => {
    const res = await get("https://flashtic.com/");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://flashtic.com/enroll");
  });

  it("redirects tenant staff pages to the tenant subdomain", async () => {
    for (const path of ["/admin/dashboard", "/login", "/onboarding"]) {
      const res = await get(`https://flashtic.com${path}`);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`https://flashtic.kuunyi.com${path}`);
    }
  });

  // Root-platform surfaces belong to the platform, not to a tenant.
  it("redirects platform pages to the platform root", async () => {
    for (const path of ["/register", "/superadmin"]) {
      const res = await get(`https://flashtic.com${path}`);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`https://kuunyi.com${path}`);
    }
  });

  it("preserves the query string when redirecting", async () => {
    const res = await get("https://flashtic.com/login?next=%2Fadmin");
    expect(res.headers.get("location")).toBe("https://flashtic.kuunyi.com/login?next=%2Fadmin");
  });

  // APIs 404 rather than redirect: a cross-origin redirect fails opaquely under
  // CORS for a fetch(), and an API client expects a status, not a host hop.
  it("404s platform APIs instead of redirecting them", async () => {
    for (const path of ["/api/admin/students", "/api/saas/tenants", "/api/superadmin/stats"]) {
      const res = await get(`https://flashtic.com${path}`);
      expect(res.status).toBe(404);
    }
  });

  it("still serves student pages, public APIs and webhooks on the custom domain", async () => {
    for (const path of [
      "/enroll/spring",
      "/status",
      "/api/public/form-fields",
      "/api/webhooks/hitpay",
    ]) {
      const res = await get(`https://flashtic.com${path}`);
      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(307);
    }
  });

  it("blocks nothing on the tenant's own kuunyi subdomain", async () => {
    const res = await get("https://flashtic.kuunyi.com/admin/dashboard");
    expect(res.headers.get("location")).not.toContain("flashtic.com/admin");
  });

  it("leaves the kuunyi root landing page alone", async () => {
    const res = await get("https://kuunyi.com/");
    expect(res.status).not.toBe(307);
  });
});

// TEMPORARY — pinned to Follow-up F2.
// requireAuth() (api.ts:60-66) requires an inbound x-tenant-slug for signed
// agent requests and grants role:"owner" on the named tenant. This plan
// deliberately does not sanitize that header, so this test pins the contract it
// leaves intact. When F2 lands host-derived tenant identity, this expectation
// FLIPS to null and this test should be deleted — a failure here after F2 is
// expected, not a regression.
describe("middleware — agent contract (temporary, see F2)", () => {
  it("preserves the root-host agent tenant header pending F2", async () => {
    process.env.VERCEL_ENV = "production";
    const res = await middleware(
      middlewareRequest("https://kuunyi.com/api/admin/payments/payment-id/verify", {
        headers: {
          "x-agent-signature": "test-signature",
          "x-chat-id": "123",
          "x-tenant-slug": "flashtic",
        },
      }),
    );
    expect(slug(res)).toBe("flashtic");
  });
});
