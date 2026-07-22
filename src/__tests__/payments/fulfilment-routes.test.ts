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
const mockAdminRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockAdminFrom, rpc: mockAdminRpc }),
}));

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
let paymentRow: {
  id: string;
  enrollment_id: string;
  tenant_id?: string;
  status: string;
  provider_amount_minor?: number | null;
  provider_currency?: string | null;
} | null = null;

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

function stubFor(data: unknown, updateResult: unknown[] = []) {
  const q: Record<string, unknown> = {};
  let updating = false;
  q.select = vi.fn(() =>
    updating ? Promise.resolve({ data: updateResult, error: null }) : q,
  );
  q.eq = vi.fn(() => q);
  q.in = vi.fn(() => q);
  q.update = vi.fn(() => {
    updating = true;
    return q;
  });
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
  paymentRow = {
    id: "pay-1", enrollment_id: "enr-1", tenant_id: "tenant-1", status: "verified",
    provider_amount_minor: 10000, provider_currency: "sgd",
  };
  mockAdminRpc.mockResolvedValue({ data: null, error: null });

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === "payments")
      return stubFor(
        paymentRow,
        // The conditional settlement UPDATE only matches active rows.
        paymentRow && ["awaiting_payment", "pending"].includes(paymentRow.status)
          ? [{ id: paymentRow.id }]
          : [],
      );
    // The settlement op re-reads the enrollment for classification; the
    // notification block reads the full notifiable shape. One stub serves
    // both — status 'confirmed' is the classify gate.
    if (table === "enrollments") return stubFor({ ...NOTIFIABLE_ENROLLMENT, status: "confirmed" });
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
    id: "evt_f",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_1", payment_status: "paid", payment_intent: "pi_1",
        amount_total: 10000, currency: "sgd",
      },
    },
  });
}

describe("webhook fulfilment posture", () => {
  it("F1a Stripe verified replay fulfils once and notifies nobody", async () => {
    stripeSessionEvent();
    paymentRow!.status = "verified";

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(stripeReq());

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue).toHaveBeenCalledWith("enr-1");
    expect(res.status).toBe(200);
    // A replay repairs tickets; it must not re-notify an already-notified customer.
    expectNoNotifications();
  });

  it("F1a-2 replay repair failure is RETRYABLE now — 500, Stripe redelivers (Plan v18 §5/§7)", async () => {
    // Pre-plan behaviour was log-and-200 because durable retry was out of
    // scope (#186). Plan v18 makes Stripe's schedule the retry mechanism, so
    // a failed repair returns 500 instead of being dropped.
    stripeSessionEvent();
    paymentRow!.status = "verified";
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(stripeReq());

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expectNoNotifications();
  });

  it("F1b fulfilment failure on a NEW transition suppresses notification and returns 500", async () => {
    // Plan v18 sec 6 inverts the old contract: the order is settle, fulfil,
    // notify. A fulfilment throw means notify never runs and the route
    // returns 500 — notifying before tickets exist would tell a customer
    // "confirmed" while retry-repair is still owed.
    stripeSessionEvent();
    paymentRow!.status = "awaiting_payment";
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(stripeReq());

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expectNoNotifications();
  });

  it("F1b-2 new transition with fulfilment success notifies every reachable branch", async () => {
    // The fixture carries email, phone and telegram_chat_id, so every branch
    // of the notification block is reachable — without that this passes
    // vacuously.
    stripeSessionEvent();
    paymentRow!.status = "awaiting_payment";

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

  it("F5 verify: settlement database failure → 500, never a false confirmed", async () => {
    // The old route ignored BOTH update errors and answered from the
    // enrollment read — a db failure looked like success. Now the shared
    // operation reports retryable and the adapter returns 500.
    mockSessionRetrieve.mockResolvedValue({
      id: "cs_1", payment_status: "paid", amount_total: 10000, currency: "sgd", payment_intent: "pi_1",
    });
    paymentRow!.status = "awaiting_payment";
    // First payments query (adapter pre-check) succeeds; the settlement
    // UPDATE chain fails at its resolving .select().
    let call = 0;
    mockAdminFrom.mockImplementation((table: string) => {
      if (table === "payments") {
        call += 1;
        if (call <= 2) return stubFor(paymentRow, []); // pre-check + locate
        const q = stubFor(paymentRow, []);
        (q as { select: unknown }).select = vi.fn(() =>
          Promise.resolve({ data: null, error: { message: "db down" } }));
        return q;
      }
      if (table === "enrollments") return stubFor({ ...NOTIFIABLE_ENROLLMENT, status: "confirmed" });
      return stubFor(null);
    });

    const { GET } = await import("@/app/api/public/payments/stripe/verify/route");
    const res = await GET(new NextRequest(new Request(
      "https://t.kuunyi.com/api/public/payments/stripe/verify?session_id=cs_1")));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBeUndefined(); // no enrollment status leaks as success
  });

  it("F3 intent/status settles via the shared op; fulfilment throw is now retryable (500)", async () => {
    // Pre-plan: inline settlement kept the Stripe-status shape when issuance
    // threw, because nothing else would retry. Plan v18: the webhook path and
    // the next poll tick both retry, so a failed settle/fulfil returns 500 —
    // "not resolved yet", never a false "succeeded".
    mockPiRetrieve.mockResolvedValue({ id: "pi_1", status: "succeeded", amount_received: 10000, currency: "sgd", payment_method: null });
    paymentRow!.status = "awaiting_payment";
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { GET } = await import("@/app/api/public/payments/stripe/intent/status/route");
    const res = await GET(new NextRequest(new Request(
      "https://t.kuunyi.com/api/public/payments/stripe/intent/status?pi=pi_1")));

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);

    // And when fulfilment succeeds, the poll shape is preserved:
    mockIssue.mockResolvedValue(undefined);
    paymentRow!.status = "awaiting_payment";
    const ok = await GET(new NextRequest(new Request(
      "https://t.kuunyi.com/api/public/payments/stripe/intent/status?pi=pi_1")));
    expect(await ok.json()).toEqual({ status: "succeeded" });
  });

    it("F4 stripe/verify repairs via the shared op; fulfilment throw is now retryable (500)", async () => {
    // Pre-plan this route masked a fulfilment throw behind the enrollment
    // status. Plan v18: the webhook and the client's re-verify both retry,
    // so a failed repair is 500 — never a success shape over missing tickets.
    mockSessionRetrieve.mockResolvedValue({
      id: "cs_1", payment_status: "paid", payment_intent: "pi_1",
      amount_total: 10000, currency: "sgd",
    });
    paymentRow!.status = "verified";
    mockIssue.mockRejectedValue(new Error("fulfilment boom"));

    const { GET } = await import("@/app/api/public/payments/stripe/verify/route");
    const res = await GET(verifyReq("cs_1"));

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue).toHaveBeenCalledWith("enr-1");
    expect(res.status).toBe(500);

    // Repair succeeds -> the enrollment-status shape is preserved (its
    // consumer maps it to a label; it must never become a Stripe status).
    mockIssue.mockResolvedValue(undefined);
    paymentRow!.status = "verified";
    const ok = await GET(verifyReq("cs_1"));
    const body = await ok.json();
    expect(ok.status).toBe(200);
    expect(body.status).toBe("confirmed");
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
