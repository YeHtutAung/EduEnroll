import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockAdminFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

const mockVerifyWebhook = vi.fn().mockReturnValue(true);
const mockParseWebhookPayload = vi.fn();
vi.mock("@/lib/hitpay", () => ({
  default: {
    verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
    parseWebhookPayload: (...args: unknown[]) => mockParseWebhookPayload(...args),
  },
}));

vi.mock("@/server/notifications/dispatchPaymentApproved", () => ({
  dispatchPaymentApproved: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/utils", () => ({
  resolveEmailFromFormData: vi.fn().mockReturnValue(null),
  resolvePhoneFromFormData: vi.fn().mockReturnValue(null),
}));

const { POST } = await import("@/app/api/webhooks/hitpay/route");

// ── Fixtures ──────────────────────────────────────────────────────────────

const COMPLETED_PAYLOAD = {
  id: "hp-req-1",
  status: "completed",
  payments: [{ payment_type: "paynow_online" }],
};

const FAILED_PAYLOAD = {
  id: "hp-req-1",
  status: "failed",
  payments: [],
};

const PAYMENT = { id: "payment-1", enrollment_id: "enroll-1", amount: 50, status: "awaiting_payment" };
const ENROLLMENT = {
  tenant_id: "tenant-1", telegram_chat_id: null, email: "s@t.com", phone: null,
  enrollment_ref: "NM-2026-0001", student_name_en: "Aung", class_id: "class-1",
  quantity: 1, form_data: null, messenger_psid: null,
};
const TENANT = { name: "School", org_type: "language_school", logo_url: null, currency: "SGD", sms_on_payment: false };
const CLASS = { level: "N5", fee_amount: 50 };

// ── Helper ────────────────────────────────────────────────────────────────

function makeRequest(body: object, signature = "valid-sig") {
  return new NextRequest("http://localhost/api/webhooks/hitpay", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "hitpay-signature": signature,
      host: "localhost:3005",
    },
  });
}

function setupMocks(opts?: { paymentStatus?: string; payload?: object }) {
  const payload = opts?.payload ?? COMPLETED_PAYLOAD;
  mockParseWebhookPayload.mockReturnValue(payload);

  mockAdminFrom.mockImplementation((table: string) => {
    const makeUpdateChain = () => ({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });

    const makeChain = (data: unknown) => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data, error: null }),
      update: vi.fn().mockReturnValue(makeUpdateChain()),
    });

    if (table === "payments") return makeChain({ ...PAYMENT, status: opts?.paymentStatus ?? "awaiting_payment" });
    if (table === "enrollments") return makeChain(ENROLLMENT);
    if (table === "tenants") return makeChain(TENANT);
    if (table === "classes") return makeChain(CLASS);
    if (table === "enrollment_items") return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    return makeChain(null);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/webhooks/hitpay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("returns 403 when Hitpay-Signature header is missing", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/hitpay", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 403 when signature is invalid", async () => {
    mockVerifyWebhook.mockReturnValueOnce(false);
    const res = await POST(makeRequest(COMPLETED_PAYLOAD));
    expect(res.status).toBe(403);
  });

  it("returns 200 for non-completed, non-failed status (idempotent)", async () => {
    setupMocks({ payload: { ...COMPLETED_PAYLOAD, status: "pending" } });
    const res = await POST(makeRequest({ ...COMPLETED_PAYLOAD, status: "pending" }));
    expect(res.status).toBe(200);
  });

  it("returns 200 and skips processing when payment already verified (replay guard)", async () => {
    setupMocks({ paymentStatus: "verified" });
    const res = await POST(makeRequest(COMPLETED_PAYLOAD));
    expect(res.status).toBe(200);
  });

  it("returns 200 and confirms enrollment on completed status", async () => {
    const res = await POST(makeRequest(COMPLETED_PAYLOAD));
    expect(res.status).toBe(200);
  });

  it("updates payment to rejected on failed status", async () => {
    setupMocks({ payload: FAILED_PAYLOAD });
    const res = await POST(makeRequest(FAILED_PAYLOAD));
    expect(res.status).toBe(200);
  });

  it("returns 200 (not 404) when payment not found — may belong to another system", async () => {
    mockAdminFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    }));
    const res = await POST(makeRequest(COMPLETED_PAYLOAD));
    expect(res.status).toBe(200);
  });
});
