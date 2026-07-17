import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Route-level wiring. redirect-allowlist.test.ts covers the decision as a pure
// function; these prove the HANDLER consults it — that a future change cannot
// bypass validation, or rebuild the fallback from the Host header, while every
// pure test stays green.

const mockAdminFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

// The route calls resolveTenantId() FIRST, before reading the body. Unmocked it
// reaches next/headers() outside a request context and throws before any
// assertion here could run.
vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-1"),
}));

const mockCreatePaymentRequest = vi.fn();
vi.mock("@/lib/hitpay", () => ({
  default: {
    createPaymentRequest: (...args: unknown[]) => mockCreatePaymentRequest(...args),
  },
}));

const { POST } = await import("@/app/api/public/payments/hitpay/route");

// ── Env ───────────────────────────────────────────────────────────────────

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

// ── Fixtures ──────────────────────────────────────────────────────────────

const ENROLLMENT = {
  id: "enroll-1",
  tenant_id: "tenant-1",
  enrollment_ref: "NM-2026-0001",
  status: "pending_payment",
  student_name_en: "Aung Aung",
  email: "student@test.com",
  class_id: "class-1",
  quantity: 1,
  enrollment_items: null,
  classes: { id: "class-1", fee_amount: 50, level: "N5" },
  tenants: { subdomain: "nihon-moment" },
};

function setupMocks(enrollment: object | null = ENROLLMENT) {
  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "enrollments") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: enrollment, error: null }),
      };
    }
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    };
  });
  mockCreatePaymentRequest.mockResolvedValue({
    id: "hp-req-1",
    url: "https://checkout.hitpay.com/pay",
    qr_code_data: { qr_code: "QR_STRING" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
  process.env.VERCEL_ENV = "production";
  // Reset, not just restore. afterEach puts back the ORIGINAL value, which may
  // itself be set on a dev machine or in CI — ambient config must not reach the
  // allowlist. Custom-domain tests set their own map after this.
  delete process.env.TENANT_CUSTOM_DOMAINS;
  setupMocks();
});

// Build the request ON a given origin — the route reads nextUrl.origin.
function post(body: object, origin = "https://nihon-moment.kuunyi.com") {
  return new NextRequest(`${origin}/api/public/payments/hitpay`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", host: new URL(origin).host },
  });
}

const card = (redirectUrl?: string) =>
  post(
    redirectUrl === undefined
      ? { enrollmentRef: "NM-2026-0001", method: "card" }
      : { enrollmentRef: "NM-2026-0001", method: "card", redirectUrl },
  );

const sentRedirect = () => mockCreatePaymentRequest.mock.calls[0]?.[0]?.redirectUrl;

// ── Supplied redirect ─────────────────────────────────────────────────────

describe("HitPay card redirect — supplied value", () => {
  it("rejects an attacker origin and creates no payment", async () => {
    const res = await POST(card("https://evil.com/phish"));
    expect(res.status).toBe(400);
    expect(mockCreatePaymentRequest).not.toHaveBeenCalled();
  });

  it("rejects another tenant's origin", async () => {
    const res = await POST(card("https://rival.kuunyi.com/enroll/x"));
    expect(res.status).toBe(400);
    expect(mockCreatePaymentRequest).not.toHaveBeenCalled();
  });

  it("rejects a lookalike suffix host", async () => {
    const res = await POST(card("https://nihon-moment.kuunyi.com.evil.com/x"));
    expect(res.status).toBe(400);
  });

  it("accepts the tenant's own origin and forwards it verbatim", async () => {
    const url = "https://nihon-moment.kuunyi.com/enroll/x?hitpay=success";
    const res = await POST(card(url));
    expect(res.status).not.toBe(400);
    expect(sentRedirect()).toBe(url);
  });
});

// ── Fallback (no supplied value) ──────────────────────────────────────────

describe("HitPay card redirect — fallback", () => {
  it("uses the tenant's canonical origin when the client sends nothing", async () => {
    const res = await POST(card(undefined));
    expect(res.status).not.toBe(400);
    expect(sentRedirect()).toContain("https://nihon-moment.kuunyi.com/enroll/payment/");
  });

  // The second untrusted path: the fallback must not follow the Host header.
  it("ignores a spoofed Host when building the fallback", async () => {
    const res = await POST(
      post({ enrollmentRef: "NM-2026-0001", method: "card" }, "https://evil.com"),
    );
    expect(res.status).not.toBe(400);
    expect(sentRedirect()).not.toContain("evil.com");
    expect(sentRedirect()).toContain("nihon-moment.kuunyi.com");
  });

  it("builds the fallback from the database enrollment_ref, not the client's raw value", async () => {
    const res = await POST(
      post({ enrollmentRef: "  NM-2026-0001  ", method: "card" }),
    );
    expect(res.status).not.toBe(400);
    expect(sentRedirect()).toContain("NM-2026-0001?hitpay=success");
    expect(sentRedirect()).not.toContain("%20");
  });
});

// ── PayNow ────────────────────────────────────────────────────────────────

describe("HitPay PayNow", () => {
  // PayNow never receives a redirectUrl, so a rogue value must not even be
  // validated — it must be ignored. A 400 here means the card gate is misplaced.
  it("ignores redirectUrl entirely", async () => {
    const res = await POST(
      post({
        enrollmentRef: "NM-2026-0001",
        method: "paynow_online",
        redirectUrl: "https://evil.com/phish",
      }),
    );
    expect(res.status).not.toBe(400);
    expect(sentRedirect()).toBeUndefined();
  });

  // PayNow must not depend on ANY redirect machinery — including the tenant
  // subdomain the allowlist needs. A data anomaly that only affects card
  // returns must not take PayNow down with it.
  it("still works when the tenant join is missing", async () => {
    setupMocks({ ...ENROLLMENT, tenants: null });
    const res = await POST(post({ enrollmentRef: "NM-2026-0001", method: "paynow_online" }));
    expect(res.status).not.toBe(500);
    expect(mockCreatePaymentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: undefined }),
    );
  });
});

// ── Fail closed ───────────────────────────────────────────────────────────

describe("HitPay card redirect — missing tenant subdomain", () => {
  // `?? ""` would fail OPEN: tenantOrigin() returns the PLATFORM ROOT for a
  // falsy subdomain, silently allowlisting the one origin this design excludes.
  it("creates no payment when the joined subdomain is missing", async () => {
    setupMocks({ ...ENROLLMENT, tenants: null });
    const res = await POST(card("https://nihon-moment.kuunyi.com/enroll/x"));
    expect(res.status).toBe(500);
    expect(mockCreatePaymentRequest).not.toHaveBeenCalled();
  });
});

// ── Development origins ───────────────────────────────────────────────────

describe("HitPay card redirect — development origins", () => {
  // The helper claims to allow these; only route tests prove the wiring hands
  // it the right origin. The old host.startsWith("localhost") rule broke both
  // of the first two by labelling them https.
  it("accepts dev origins off production", async () => {
    process.env.VERCEL_ENV = "preview";
    for (const origin of [
      "http://tenant.localhost:3005",
      "http://192.168.50.3:3005",
      "https://edu-enroll-git-abc.vercel.app",
    ]) {
      vi.clearAllMocks();
      setupMocks();
      const url = `${origin}/enroll/x?hitpay=success`;
      const res = await POST(
        post({ enrollmentRef: "NM-2026-0001", method: "card", redirectUrl: url }, origin),
      );
      expect(res.status, `${origin} should be accepted`).not.toBe(400);
      expect(sentRedirect()).toBe(url);
    }
  });

  it("still rejects an attacker origin on a preview deployment", async () => {
    process.env.VERCEL_ENV = "preview";
    const res = await POST(
      post(
        { enrollmentRef: "NM-2026-0001", method: "card", redirectUrl: "https://evil.com/phish" },
        "https://edu-enroll-git-abc.vercel.app",
      ),
    );
    expect(res.status).toBe(400);
  });
});

// ── Tenant custom domain (P3) ─────────────────────────────────────────────

describe("HitPay card redirect — tenant custom domain", () => {
  // The fixture's tenant is nihon-moment; map the domain to it.
  it("accepts a return to the tenant's custom domain", async () => {
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"nihon-moment"}';
    const url = "https://flashtic.com/enroll/x?hitpay=success";
    const res = await POST(card(url));
    expect(res.status).not.toBe(400);
    expect(sentRedirect()).toBe(url);
  });

  it("rejects a custom domain mapped to a different tenant", async () => {
    process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"some-other-tenant"}';
    const res = await POST(card("https://flashtic.com/enroll/x"));
    expect(res.status).toBe(400);
  });
});
