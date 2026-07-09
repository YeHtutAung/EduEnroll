import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockAdminFrom = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

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
};

// ── Helper ────────────────────────────────────────────────────────────────

function makeRequest(body: object) {
  return new NextRequest("http://localhost/api/public/payments/hitpay", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", host: "localhost:3005" },
  });
}

function setupMocks(opts?: {
  enrollment?: object | null;
  existingPayment?: object | null;
  hitpayResult?: object;
}) {
  const enrollment = opts?.enrollment !== undefined ? opts.enrollment : ENROLLMENT;
  const hitpayResult = opts?.hitpayResult ?? {
    id: "hp-req-1",
    url: "https://checkout.hitpay.com/pay",
    qr_code_data: { qr_code: "QR_STRING" },
  };

  const existingPayment = opts?.existingPayment !== undefined ? opts.existingPayment : null;

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "enrollments") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: enrollment, error: null }),
      };
    }
    if (table === "payments") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: existingPayment, error: null }),
        insert: vi.fn().mockResolvedValue({ error: null }),
      };
    }
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
  });

  mockCreatePaymentRequest.mockResolvedValue(hitpayResult);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/public/payments/hitpay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("returns 400 when enrollmentRef is missing", async () => {
    const res = await POST(makeRequest({ method: "paynow_online" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when method is invalid", async () => {
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "invalid" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when enrollment not found", async () => {
    setupMocks({ enrollment: null });
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "paynow_online" }));
    expect(res.status).toBe(404);
  });

  it("returns 409 when enrollment status is confirmed", async () => {
    setupMocks({ enrollment: { ...ENROLLMENT, status: "confirmed" } });
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "paynow_online" }));
    expect(res.status).toBe(409);
  });

  it("returns 200 with qrCode for paynow_online", async () => {
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "paynow_online" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.qrCode).toBe("QR_STRING");
    expect(body.paymentRequestId).toBe("hp-req-1");
  });

  it("returns 200 with url for card", async () => {
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "card" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe("https://checkout.hitpay.com/pay");
    expect(body.paymentRequestId).toBe("hp-req-1");
  });

  it("returns existing paymentRequestId without calling HitPay when duplicate guard triggers", async () => {
    setupMocks({
      existingPayment: { hitpay_payment_id: "hp-existing", status: "awaiting_payment" },
    });
    const res = await POST(makeRequest({ enrollmentRef: "NM-2026-0001", method: "paynow_online" }));
    expect(res.status).toBe(200);
    expect(mockCreatePaymentRequest).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.paymentRequestId).toBe("hp-existing");
  });
});
