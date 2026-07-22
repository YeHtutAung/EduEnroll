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
//
// C1-C3 cover each route's insert-failure branch, C7-C9 pin the success shapes
// so the guard cannot regress into breaking the happy path, and C10 covers the
// provider-failure branch, which leaked the raw upstream body.

let insertError: unknown = null; // HitPay routes still insert directly

// Stripe routes now record rows through finalize_stripe_payment_attempt();
// rpcError simulates its failure (ambiguous, non-ST-coded).
let rpcError: { message: string; code?: string } | null = null;

const mockInsert = vi.fn(async () => ({ error: insertError }));
const mockAdminFrom = vi.fn();
const mockAdminRpc = vi.fn(async (name: string) => {
  if (name === "finalize_stripe_payment_attempt" && rpcError) {
    return { data: null, error: rpcError };
  }
  return { data: { id: "pay-new" }, error: null };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom, rpc: mockAdminRpc }),
}));

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
  // Joined, not a separate query. The HitPay card path fails closed without it,
  // because tenantOrigin() returns the platform root for a falsy subdomain.
  tenants: { subdomain: "ev" },
};

function readStub(data: unknown) {
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.not = vi.fn(() => q);
  q.order = vi.fn(() => q);
  q.limit = vi.fn(() => q);
  q.or = vi.fn(() => q);
  q.single = vi.fn(async () => ({ data, error: null }));
  q.maybeSingle = vi.fn(async () => ({ data, error: null }));
  // selectAttemptContext awaits the chain itself (terminal .order): thenable.
  q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve({ data, error: null }).then(resolve, reject);
  q.insert = mockInsert;
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertError = null;
  rpcError = null;
  process.env.STRIPE_SECRET_KEY = "sk_test_only";
  process.env.HITPAY_API_KEY = "test_only";
  process.env.STRIPE_SALES_OPEN = "true"; // launch gate open for these suites

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "enrollments") return readStub(ENROLLMENT);
    // Attempt-context query resolves to an empty LIST (no prior attempts).
    if (table === "payments") return readStub([]);
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

const checkout = () =>
  import("@/app/api/public/payments/stripe/route").then(({ POST }) =>
    POST(post("https://t.kuunyi.com/api/public/payments/stripe", { enrollmentRef: "F-0001" })),
  );

const intent = () =>
  import("@/app/api/public/payments/stripe/intent/route").then(({ POST }) =>
    POST(post("https://t.kuunyi.com/api/public/payments/stripe/intent", { enrollmentRef: "F-0001" })),
  );

const hitpay = (method: "paynow_online" | "card") =>
  import("@/app/api/public/payments/hitpay/route").then(({ POST }) =>
    POST(post("https://t.kuunyi.com/api/public/payments/hitpay", {
      enrollmentRef: "F-0001",
      method,
    })),
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

describe("payment creation — record failure withholds credentials", () => {
  // Plan v18 L9 INVERTS the old cleanup decision: with Stripe idempotency in
  // play, a generic database error is ambiguous — the object MAY be owned by
  // a row this request cannot see, so it is left alone (the retry converges
  // on the same object via the same idempotency key). Only typed no-owner
  // failures cancel, and that path is pinned in stripeCreation.test.ts.
  it("C1 Checkout: record fails → no URL, 500, session NOT expired (ambiguity = may be owned)", async () => {
    rpcError = { message: "insert failed: connection reset" };

    const res = await checkout();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.url).toBeUndefined();
    assertNoCredentialsLeaked(body);
    expect(mockSessionsExpire).not.toHaveBeenCalled();
  });

  it("C3 HitPay: no QR and no URL when the insert fails", async () => {
    insertError = { message: "insert failed: connection reset" };

    const res = await hitpay("paynow_online");
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.qrCode).toBeUndefined();
    expect(body.url).toBeUndefined();
    assertNoCredentialsLeaked(body);
  });

  it("C4 PaymentIntent: record fails → no client secret, 500, object NOT cancelled", async () => {
    rpcError = { message: "insert failed: connection reset" };

    const res = await intent();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.clientSecret).toBeUndefined();
    expect(body.paymentIntentId).toBeUndefined();
    assertNoCredentialsLeaked(body);
    expect(mockPiCancel).not.toHaveBeenCalled();
  });
});

describe("payment creation — success paths are unchanged", () => {
  it("C6 PaymentIntent returns its client secret (discriminated) and does not cancel", async () => {
    const res = await intent();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.kind).toBe("requires_payment");
    expect(body.clientSecret).toBe("pi_1_secret");
    expect(mockPiCancel).not.toHaveBeenCalled();
  });

  it("C7 Checkout returns its URL (discriminated) and does not expire the session", async () => {
    const res = await checkout();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.kind).toBe("redirect");
    expect(body.url).toBe("https://stripe.test/cs_1");
    expect(mockSessionsExpire).not.toHaveBeenCalled();
  });

  it("C8 HitPay PayNow returns its QR payload", async () => {
    const res = await hitpay("paynow_online");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.qrCode).toBe("QRDATA");
    expect(body.paymentRequestId).toBe("hp_1");
  });

  it("C9 HitPay card returns its redirect URL", async () => {
    const res = await hitpay("card");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe("https://hitpay.test/hp_1");
    expect(body.paymentRequestId).toBe("hp_1");
  });
});

describe("payment creation — provider failures stay internal", () => {
  it("C10 HitPay provider rejection leaks the upstream body to neither the response nor the logs", async () => {
    // Persistent logs are an exfiltration surface too. Truncating the provider
    // body is not sanitizing it, so the route must never log the message at
    // all — this asserts against a hostile message that still carries a token.
    const UPSTREAM = 'HitPay 422: {"errors":{"amount":"internal-token-abc123"}}';
    const hostile = new Error(UPSTREAM) as Error & { status: number };
    hostile.status = 422;
    mockCreatePaymentRequest.mockRejectedValue(hostile);

    // Collected as they happen: mockRestore() also resets the recorded calls,
    // so reading them afterwards yields nothing.
    const logLines: string[] = [];
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a) => String(a)).join(" "));
      });
    let res: Response;
    try {
      res = await hitpay("paynow_online");
    } finally {
      errSpy.mockRestore();
    }
    const body = await res!.json();

    expect(res!.status).toBe(502);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("internal-token-abc123");
    expect(serialised).not.toContain("HitPay 422");
    expect(body.detail).toBeUndefined();
    // A generic, actionable message is still returned.
    expect(body.error).toBe("Payment Gateway Error");

    // Nothing logged may carry the body either.
    const logged = logLines.join("\n");
    expect(logged).not.toBe(""); // the route must actually log, or this is vacuous
    expect(logged).not.toContain("internal-token-abc123");
    expect(logged).not.toContain("HitPay 422");
    expect(logged).not.toContain(UPSTREAM);
    // The safe structured status is still recorded, so failures stay diagnosable.
    expect(logged).toContain("HTTP 422");
  });
});
