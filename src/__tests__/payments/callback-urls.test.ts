import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Machine callbacks must never follow the inbound Host. On a tenant custom
// domain that would aim settlement at a domain the client controls and could
// remove, stranding in-flight payments — and would need every custom domain
// added to each provider's callback allowlist.
//
// Customer RETURN urls are the opposite problem and stay branded; those live in
// the HitPay/PayPay/Stripe routes and are not touched here.

const mockAdminFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

// Both routes call resolveTenantId() FIRST, before reading the body. Unmocked it
// reaches next/headers() outside a request context and throws before any
// assertion here could run.
vi.mock("@/lib/api", () => ({
  resolveTenantId: vi.fn().mockResolvedValue("tenant-1"),
}));

const mockCreateOrder = vi.fn();
vi.mock("@/lib/abank", () => ({
  default: { createOrder: (...a: unknown[]) => mockCreateOrder(...a) },
}));

const mockSandboxPay = vi.fn();
const mockPay = vi.fn();
vi.mock("@/lib/mmpay", () => ({
  default: {
    sandboxPay: (...a: unknown[]) => mockSandboxPay(...a),
    pay: (...a: unknown[]) => mockPay(...a),
  },
}));

const { POST: POST_abank } = await import("@/app/api/public/payments/abank/route");
const { POST: POST_mmpay } = await import("@/app/api/public/payments/mmpay/route");

// ── Env ───────────────────────────────────────────────────────────────────

const ENV_KEYS = ["NEXT_PUBLIC_APP_URL", "TENANT_CUSTOM_DOMAINS", "MMPAY_MODE"] as const;
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
  classes: { id: "class-1", fee_amount: 50000, level: "N5" },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = "https://kuunyi.com";
  process.env.TENANT_CUSTOM_DOMAINS = '{"flashtic.com":"flashtic"}';
  delete process.env.MMPAY_MODE; // force the sandbox branch; don't inherit prod

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "enrollments") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: ENROLLMENT, error: null }),
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

  mockCreateOrder.mockResolvedValue({ data: { qr: "QR" }, respondCode: 0, respondMessage: "ok" });
  mockSandboxPay.mockResolvedValue({ data: { qrString: "QR" }, code: "000" });
  mockPay.mockResolvedValue({ data: { qrString: "QR" }, code: "000" });
});

// Build the request ON a given origin, as a browser would send it.
function postTo(origin: string, path: string) {
  return new NextRequest(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: new URL(origin).host },
    body: JSON.stringify({ enrollmentRef: "NM-2026-0001" }),
  });
}

// ── ABank ─────────────────────────────────────────────────────────────────

describe("ABank callback URL", () => {
  it("uses the platform origin even when the request arrives on a custom domain", async () => {
    await POST_abank(postTo("https://flashtic.com", "/api/public/payments/abank"));
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({ callbackUrl: "https://kuunyi.com/api/webhooks/abank" }),
    );
  });

  it("ignores a spoofed Host header", async () => {
    await POST_abank(postTo("https://evil.com", "/api/public/payments/abank"));
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({ callbackUrl: "https://kuunyi.com/api/webhooks/abank" }),
    );
  });

  // Note this DOES change the stored callback string for existing tenants:
  // previously nihon-moment.kuunyi.com/api/webhooks/abank, now the platform
  // root. Same deployment either way, and the handler looks payments up by
  // payment_ref rather than host, so the destination is unaffected.
  it("sends a subdomain tenant's callback to the platform root", async () => {
    await POST_abank(postTo("https://nihon-moment.kuunyi.com", "/api/public/payments/abank"));
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({ callbackUrl: "https://kuunyi.com/api/webhooks/abank" }),
    );
  });
});

// ── MMQR ──────────────────────────────────────────────────────────────────

describe("MMQR callback URL", () => {
  it("uses the platform origin even when the request arrives on a custom domain", async () => {
    await POST_mmpay(postTo("https://flashtic.com", "/api/public/payments/mmpay"));
    expect(mockSandboxPay).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: "https://kuunyi.com/api/sandbox/payments/webhook",
      }),
    );
  });

  it("ignores a spoofed Host header", async () => {
    await POST_mmpay(postTo("https://evil.com", "/api/public/payments/mmpay"));
    expect(mockSandboxPay).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: "https://kuunyi.com/api/sandbox/payments/webhook",
      }),
    );
  });

  it("uses the production callback path when MMPAY_MODE=production", async () => {
    process.env.MMPAY_MODE = "production";
    await POST_mmpay(postTo("https://flashtic.com", "/api/public/payments/mmpay"));
    expect(mockPay).toHaveBeenCalledWith(
      expect.objectContaining({ callbackUrl: "https://kuunyi.com/api/payments/webhook" }),
    );
  });
});
