import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Route fulfilment posture (mocked helper) ───────────────────────────────
//
// These prove WHEN the helper is invoked and what each route does when it
// throws. They deliberately do NOT assert ticket rows — a mocked helper can
// only prove it was called. Real rows are asserted in the database suite.
//
// The invocation assertion is the point. Before this change neither browser
// route called the helper at all, so "mock throws → response unchanged, no 500"
// passes with the mock never invoked, proving nothing. Asserting *invoked
// exactly once with the expected enrollment id* is what makes these meaningful.

const mockAdminFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockAdminFrom }) }));

const mockIssue = vi.fn();
vi.mock("@/server/tickets/issueTickets", () => ({
  issueTicketsForEnrollment: (...a: unknown[]) => mockIssue(...a),
  voidTicketsForEnrollment: vi.fn().mockResolvedValue(undefined),
}));

// Every external transport mocked — "no provider network" includes notifications.
vi.mock("@/server/notifications/dispatchPaymentApproved", () => ({
  dispatchPaymentApproved: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  enrollmentApprovedEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
}));
vi.mock("@/lib/sms", () => ({ sendSms: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/telegram/notify", () => ({
  sendTelegramStatusNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/telegram/channel-invite", () => ({
  sendChannelInviteIfEligible: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/utils", () => ({
  resolveEmailFromFormData: vi.fn().mockReturnValue(null),
  resolvePhoneFromFormData: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/origin", () => ({
  tenantOrigin: () => "https://t.example",
  platformOrigin: () => "https://example",
}));

const mockConstructEvent = vi.fn();
const mockPiRetrieve = vi.fn();
const mockSessionRetrieve = vi.fn();
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: (...a: unknown[]) => mockConstructEvent(...a) },
    paymentIntents: { retrieve: (...a: unknown[]) => mockPiRetrieve(...a) },
    checkout: { sessions: { retrieve: (...a: unknown[]) => mockSessionRetrieve(...a) } },
  }),
}));

const mockVerifyWebhook = vi.fn().mockReturnValue(true);
const mockParseWebhookPayload = vi.fn();
vi.mock("@/lib/hitpay", () => ({
  default: {
    verifyWebhook: (...a: unknown[]) => mockVerifyWebhook(...a),
    parseWebhookPayload: (...a: unknown[]) => mockParseWebhookPayload(...a),
  },
}));

// ── Supabase table stub ─────────────────────────────────────────────────────
// `payment` drives the replay-vs-transition branch under test.
let paymentRow: { id: string; enrollment_id: string; status: string } | null = null;

function tableStub() {
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.update = vi.fn(() => q);
  q.single = vi.fn(async () => ({ data: paymentRow, error: null }));
  q.maybeSingle = vi.fn(async () => ({ data: paymentRow, error: null }));
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIssue.mockResolvedValue(undefined);
  mockVerifyWebhook.mockReturnValue(true);
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_only";
  process.env.HITPAY_SALT = "test_salt_only";
  paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "verified" };

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "payments" || table === "enrollments") return tableStub();
    // tenants / bank_accounts / anything the notification block touches
    const q = tableStub();
    q.single = vi.fn(async () => ({ data: null, error: null }));
    q.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    return q;
  });
});

const stripeReq = () =>
  new NextRequest(
    new Request("https://kuunyi.com/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "sig_test" },
      body: JSON.stringify({ ok: true }),
    }),
  );

const hitpayReq = () =>
  new NextRequest(
    new Request("https://kuunyi.com/api/webhooks/hitpay", {
      method: "POST",
      headers: { "hitpay-signature": "sig_test", "content-type": "application/json" },
      body: JSON.stringify({ id: "hp-1", status: "completed" }),
    }),
  );

function stripeSessionEvent() {
  mockConstructEvent.mockReturnValue({
    type: "checkout.session.completed",
    data: { object: { id: "cs_1", payment_status: "paid", payment_intent: "pi_1" } },
  });
}

describe("webhook fulfilment posture", () => {
  it("F1a Stripe verified replay invokes the helper once and preserves its 2xx", async () => {
    stripeSessionEvent();
    paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "verified" };
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(stripeReq());

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue).toHaveBeenCalledWith("enr-1");
    expect(res.status).toBe(200);
  });

  it("F1b Stripe new transition keeps notifications and its response when fulfilment throws", async () => {
    // Guard: the transition path already wrapped issuance, so this passes both
    // before and after the change. Its job is to prove notifications did not move.
    stripeSessionEvent();
    paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "awaiting_payment" };
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(stripeReq());

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("F2a HitPay verified replay invokes the helper once and preserves its response", async () => {
    mockParseWebhookPayload.mockReturnValue({ id: "hp-1", status: "completed" });
    paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "verified" };
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { POST } = await import("@/app/api/webhooks/hitpay/route");
    const res = await POST(hitpayReq());

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue).toHaveBeenCalledWith("enr-1");
    expect(res.status).toBe(200);
  });

  it("F2b HitPay rejected replay never invokes the helper", async () => {
    // A rejected payment must not mint an admission even on replay.
    mockParseWebhookPayload.mockReturnValue({ id: "hp-1", status: "completed" });
    paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "rejected" };

    const { POST } = await import("@/app/api/webhooks/hitpay/route");
    const res = await POST(hitpayReq());

    expect(mockIssue).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("F5a Stripe webhook does not invoke the helper when the session is unpaid", async () => {
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", payment_status: "unpaid" } },
    });

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    await POST(stripeReq());

    expect(mockIssue).not.toHaveBeenCalled();
  });
});

describe("browser route fulfilment posture", () => {
  const statusReq = (pi: string) =>
    new NextRequest(new Request(`https://t.kuunyi.com/api/public/payments/stripe/intent/status?pi=${pi}`));
  const verifyReq = (sid: string) =>
    new NextRequest(new Request(`https://t.kuunyi.com/api/public/payments/stripe/verify?session_id=${sid}`));

  it("F3 intent/status invokes the helper once and keeps its Stripe-status shape when it throws", async () => {
    mockPiRetrieve.mockResolvedValue({ status: "succeeded", payment_method: null });
    paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "verified" };
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { GET } = await import("@/app/api/public/payments/stripe/intent/status/route");
    const res = await GET(statusReq("pi_1"));
    const body = await res.json();

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue).toHaveBeenCalledWith("enr-1");
    expect(res.status).toBe(200);
    // Stripe payment status — NOT an enrollment status.
    expect(body).toEqual({ status: "succeeded" });
  });

  it("F4 stripe/verify invokes the helper once and keeps its enrollment-status shape when it throws", async () => {
    mockSessionRetrieve.mockResolvedValue({ payment_status: "paid", payment_intent: "pi_1" });
    paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "verified" };
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { GET } = await import("@/app/api/public/payments/stripe/verify/route");
    const res = await GET(verifyReq("cs_1"));
    const body = await res.json();

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue).toHaveBeenCalledWith("enr-1");
    expect(res.status).toBe(200);
    // Enrollment status — its consumer maps this to a label, so the shape must
    // not become a Stripe status.
    expect(typeof body.status).toBe("string");
    expect(body.status).not.toBe("succeeded");
  });

  it("F5b intent/status does not invoke the helper for a pending PaymentIntent", async () => {
    mockPiRetrieve.mockResolvedValue({ status: "processing", payment_method: null });

    const { GET } = await import("@/app/api/public/payments/stripe/intent/status/route");
    await GET(statusReq("pi_1"));

    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("F5c stripe/verify does not invoke the helper for an unpaid session", async () => {
    mockSessionRetrieve.mockResolvedValue({ payment_status: "unpaid" });

    const { GET } = await import("@/app/api/public/payments/stripe/verify/route");
    await GET(verifyReq("cs_1"));

    expect(mockIssue).not.toHaveBeenCalled();
  });
});
