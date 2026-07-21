import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Route fulfilment posture (mocked helper) ───────────────────────────────
//
// These prove WHEN the helper is invoked, whether notifications accompany it,
// and what each route does when issuance throws. They deliberately do NOT
// assert ticket rows — a mocked helper can only prove it was called. Real rows
// are asserted in the database suite.
//
// SIGNATURE VERIFICATION IS MOCKED. `Stripe.webhooks.constructEvent` and
// `hitpay.verifyWebhook` are stubbed, so these exercise the post-verification
// route boundary only. They generate no real HMAC and prove nothing about
// signature checking — that code is unchanged by this branch. The
// `stripe-signature` / `hitpay-signature` headers below are present because the
// routes read them, not because anything here validates them.
//
// The invocation assertion is the point. Before this change neither browser
// route called the helper at all, so "mock throws → response unchanged" passes
// with the mock never invoked, proving nothing.

const mockAdminFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockAdminFrom }) }));

const mockIssue = vi.fn();
vi.mock("@/server/tickets/issueTickets", () => ({
  issueTicketsForEnrollment: (...a: unknown[]) => mockIssue(...a),
  voidTicketsForEnrollment: vi.fn().mockResolvedValue(undefined),
}));

// Every external transport is mocked AND observable — "did a notification go
// out?" is an assertion here, not an assumption.
const mockDispatch = vi.fn();
vi.mock("@/server/notifications/dispatchPaymentApproved", () => ({
  dispatchPaymentApproved: (...a: unknown[]) => mockDispatch(...a),
}));
const mockSendEmail = vi.fn();
vi.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => mockSendEmail(...a),
  enrollmentApprovedEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
}));
const mockSendSms = vi.fn();
vi.mock("@/lib/sms", () => ({ sendSms: (...a: unknown[]) => mockSendSms(...a) }));
const mockTelegram = vi.fn();
vi.mock("@/lib/telegram/notify", () => ({
  sendTelegramStatusNotification: (...a: unknown[]) => mockTelegram(...a),
}));
const mockChannelInvite = vi.fn();
vi.mock("@/lib/telegram/channel-invite", () => ({
  sendChannelInviteIfEligible: (...a: unknown[]) => mockChannelInvite(...a),
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

// ── Supabase table stubs ────────────────────────────────────────────────────
// Table-specific, deliberately. A single stub that returned the payment row for
// every table left the enrollment without email/phone/telegram_chat_id, so
// EVERY notification branch was skipped — a "notifications still run" test then
// passed with no transport ever called.
let paymentRow: { id: string; enrollment_id: string; status: string } | null = null;

/** Carries every destination the Stripe webhook's notification block gates on. */
const NOTIFIABLE_ENROLLMENT = {
  id: "enr-1",
  tenant_id: "tenant-1",
  telegram_chat_id: "tg-123",
  email: "student@example.test",
  phone: "09000000000",
  enrollment_ref: "F-0001",
  student_name_en: "Test Student",
  class_id: "class-1",
  quantity: 1,
  form_data: null,
};

function stubFor(data: unknown) {
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.update = vi.fn(() => q);
  q.single = vi.fn(async () => ({ data, error: null }));
  q.maybeSingle = vi.fn(async () => ({ data, error: null }));
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIssue.mockResolvedValue(undefined);
  mockDispatch.mockResolvedValue(undefined);
  mockSendEmail.mockResolvedValue(undefined);
  mockSendSms.mockResolvedValue(undefined);
  mockTelegram.mockResolvedValue(undefined);
  mockChannelInvite.mockResolvedValue(undefined);
  mockVerifyWebhook.mockReturnValue(true);
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_only";
  process.env.HITPAY_SALT = "test_salt_only";
  paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "verified" };

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "payments") return stubFor(paymentRow);
    if (table === "enrollments") return stubFor(NOTIFIABLE_ENROLLMENT);
    if (table === "classes") return stubFor({ level: "VIP", fee_amount: 100 });
    if (table === "tenants")
      return stubFor({
        name: "Ev",
        org_type: "event",
        logo_url: null,
        currency: "SGD",
        sms_on_payment: true,
      });
    return stubFor(null);
  });
});

/** No transport fired. Used to prove a replay does not re-notify a customer. */
function expectNoNotifications() {
  expect(mockSendEmail).not.toHaveBeenCalled();
  expect(mockSendSms).not.toHaveBeenCalled();
  expect(mockTelegram).not.toHaveBeenCalled();
  expect(mockChannelInvite).not.toHaveBeenCalled();
  expect(mockDispatch).not.toHaveBeenCalled();
}

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
  it("F1a Stripe verified replay fulfils once and notifies nobody", async () => {
    stripeSessionEvent();
    paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "verified" };
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(stripeReq());

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue).toHaveBeenCalledWith("enr-1");
    expect(res.status).toBe(200);
    // A replay repairs tickets; it must not re-notify an already-notified customer.
    expectNoNotifications();
  });

  it("F1b Stripe new transition still notifies when fulfilment throws", async () => {
    // Regression guard: issuance must not be able to suppress notifications.
    // The fixture carries email, phone and telegram_chat_id, so every branch of
    // the notification block is reachable — without that this test passes
    // vacuously.
    stripeSessionEvent();
    paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "awaiting_payment" };
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(stripeReq());

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "student@example.test" }),
    );
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockTelegram).toHaveBeenCalledTimes(1);
    expect(mockChannelInvite).toHaveBeenCalledTimes(1);
  });

  it("F2a HitPay verified replay fulfils once and notifies nobody", async () => {
    mockParseWebhookPayload.mockReturnValue({ id: "hp-1", status: "completed" });
    paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "verified" };
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { POST } = await import("@/app/api/webhooks/hitpay/route");
    const res = await POST(hitpayReq());

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue).toHaveBeenCalledWith("enr-1");
    expect(res.status).toBe(200);
    expectNoNotifications();
  });

  it("F2b HitPay new transition still dispatches approval when fulfilment throws", async () => {
    // The transition regression guard: a thrown issuance must not swallow the
    // customer's approval notification.
    mockParseWebhookPayload.mockReturnValue({ id: "hp-1", status: "completed" });
    paymentRow = { id: "pay-1", enrollment_id: "enr-1", status: "awaiting_payment" };
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { POST } = await import("@/app/api/webhooks/hitpay/route");
    const res = await POST(hitpayReq());

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("F2c HitPay rejected replay never invokes the helper", async () => {
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
