import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Payment creation: never hand out credentials we could not record ───────
//
// All three creation routes inserted the local payment row without checking the
// error and returned payable credentials regardless. A silent insert failure
// therefore let a customer pay against a session with no local record.
//
// The PaymentIntent route is the worst: it resolves payments by
// stripe_payment_intent_id and has no payment_intent.succeeded handler (#186),
// so with no row neither the browser nor any webhook can find the payment.

let insertError: unknown = null;

const mockInsert = vi.fn(async () => ({ error: insertError }));
const mockAdminFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockAdminFrom }) }));

const mockSessionsCreate = vi.fn();
const mockSessionsExpire = vi.fn();
const mockSessionsRetrieve = vi.fn();
const mockPiCreate = vi.fn();
const mockPiCancel = vi.fn();
const mockPiRetrieve = vi.fn();
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: (...a: unknown[]) => mockSessionsCreate(...a),
        expire: (...a: unknown[]) => mockSessionsExpire(...a),
        retrieve: (...a: unknown[]) => mockSessionsRetrieve(...a),
      },
    },
    paymentIntents: {
      create: (...a: unknown[]) => mockPiCreate(...a),
      cancel: (...a: unknown[]) => mockPiCancel(...a),
      retrieve: (...a: unknown[]) => mockPiRetrieve(...a),
    },
  }),
}));

const mockCreatePaymentRequest = vi.fn();
vi.mock("@/lib/hitpay", () => ({
  default: { createPaymentRequest: (...a: unknown[]) => mockCreatePaymentRequest(...a) },
}));

vi.mock("@/lib/api", () => ({ resolveTenantId: async () => "tenant-1" }));
vi.mock("@/lib/origin", () => ({
  tenantOrigin: () => "https://t.example",
  platformOrigin: () => "https://example",
}));

const ENROLLMENT = {
  id: "enr-1",
  tenant_id: "tenant-1",
  enrollment_ref: "F-0001",
  status: "pending_payment",
  quantity: 1,
  student_name_en: "Test",
  email: "t@example.test",
  classes: { level: "VIP", fee_amount: 100, intakes: { id: "i1", name: "Ev", slug: "ev" } },
  enrollment_items: [],
};

function readStub(data: unknown) {
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.not = vi.fn(() => q);
  q.order = vi.fn(() => q);
  q.limit = vi.fn(() => q);
  q.single = vi.fn(async () => ({ data, error: null }));
  q.maybeSingle = vi.fn(async () => ({ data, error: null }));
  q.insert = mockInsert;
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertError = null;
  process.env.STRIPE_SECRET_KEY = "sk_test_only";
  process.env.HITPAY_API_KEY = "test_only";

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "enrollments") return readStub(ENROLLMENT);
    if (table === "payments") return readStub(null);
    if (table === "tenants") return readStub({ currency: "SGD", name: "Ev", org_type: "event" });
    return readStub(null);
  });

  mockSessionsCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/cs_1" });
  mockSessionsExpire.mockResolvedValue({});
  mockPiCreate.mockResolvedValue({ id: "pi_1", client_secret: "pi_1_secret" });
  mockPiCancel.mockResolvedValue({});
  mockCreatePaymentRequest.mockResolvedValue({
    id: "hp_1",
    url: "https://hitpay.test/hp_1",
    qr_code_data: { qr_code: "QRDATA" },
  });
});

const post = (url: string, body: unknown) =>
  new NextRequest(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** No response body may carry payable credentials or raw internal detail. */
function assertNoCredentialsLeaked(body: Record<string, unknown>) {
  const serialised = JSON.stringify(body);
  expect(serialised).not.toContain("cs_1");
  expect(serialised).not.toContain("pi_1_secret");
  expect(serialised).not.toContain("hitpay.test");
  expect(serialised).not.toContain("QRDATA");
  expect(serialised).not.toContain("stripe.test");
  // Raw database detail must not reach the public body.
  expect(serialised).not.toContain("insert failed");
  expect(body.detail).toBeUndefined();
}

describe("payment creation — insert failure withholds credentials", () => {
  it("C4 PaymentIntent: no client secret, local 500, cancel attempted", async () => {
    insertError = { message: "insert failed: connection reset" };

    const { POST } = await import("@/app/api/public/payments/stripe/intent/route");
    const res = await POST(post("https://t.kuunyi.com/api/public/payments/stripe/intent", {
      enrollmentRef: "F-0001",
    }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.clientSecret).toBeUndefined();
    expect(body.paymentIntentId).toBeUndefined();
    assertNoCredentialsLeaked(body);
    expect(mockPiCancel).toHaveBeenCalledWith("pi_1");
  });

  it("C5 PaymentIntent: cancel failure does not replace the original safe 500", async () => {
    insertError = { message: "insert failed" };
    mockPiCancel.mockRejectedValue(new Error("cancel boom"));

    const { POST } = await import("@/app/api/public/payments/stripe/intent/route");
    const res = await POST(post("https://t.kuunyi.com/api/public/payments/stripe/intent", {
      enrollmentRef: "F-0001",
    }));
    const body = await res.json();

    expect(res.status).toBe(500);
    assertNoCredentialsLeaked(body);
  });

  it("C6 PaymentIntent: success is unchanged and cancel is not called", async () => {
    const { POST } = await import("@/app/api/public/payments/stripe/intent/route");
    const res = await POST(post("https://t.kuunyi.com/api/public/payments/stripe/intent", {
      enrollmentRef: "F-0001",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.clientSecret).toBe("pi_1_secret");
    expect(mockPiCancel).not.toHaveBeenCalled();
  });
});
