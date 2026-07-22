import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from "vitest";
import { Pool } from "pg";
import { NextRequest } from "next/server";

// ─── Route fulfilment: REAL helper, REAL database ───────────────────────────
//
// The companion mocked suite proves *when* the helper is invoked. Only this one
// proves ticket rows actually exist — a mocked helper can only prove it was
// called.
//
// Provider APIs and every notification transport are mocked; nothing here
// touches a provider network. The database and the ticket helper are real.

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

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

type Tracked = { tenants: string[]; intakes: string[]; classes: string[]; enrollments: string[] };
let made: Tracked;
const fresh = (): Tracked => ({ tenants: [], intakes: [], classes: [], enrollments: [] });

let seq = 0;
const uniq = () => `fr${Date.now().toString(36)}${seq++}`;

/** A confirmed EVENT enrollment whose payment is already `verified` and which
 *  has ZERO tickets — the exact state the replay branch must repair. */
async function ticketlessConfirmedOrder(providerCol: "stripe_session_id" | "hitpay_payment_id",
                                        providerId: string) {
  const slug = uniq();
  const [t] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1,$2,'event') RETURNING id`,
    [`Route ${slug}`, slug],
  );
  made.tenants.push(t.id);
  const [i] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id,name,year) VALUES ($1,'Route intake',2026) RETURNING id`, [t.id]);
  made.intakes.push(i.id);
  const [c] = await sql<{ id: string }>(
    `INSERT INTO classes (tenant_id,intake_id,level,fee_amount,seat_total,seat_remaining,status,
                          max_tickets_per_person,event_date)
     VALUES ($1,$2,$3,100,100,90,'open',10, now() + interval '30 days') RETURNING id`,
    [t.id, i.id, `L${uniq()}`]);
  made.classes.push(c.id);
  const [e] = await sql<{ id: string }>(
    `INSERT INTO enrollments (enrollment_ref,tenant_id,student_name_en,phone,class_id,quantity,status)
     VALUES ('',$1,'Route Test','09000000000',$2,2,'confirmed') RETURNING id`, [t.id, c.id]);
  made.enrollments.push(e.id);
  // 20260722180000's row contracts: a Stripe row must carry attempt_seq +
  // integration_flow, and only Stripe rows may carry Stripe provider ids —
  // so the HitPay fixture now records its TRUE method (the old 'stripe' was
  // fixture sloppiness the constraints no longer tolerate).
  const [p] =
    providerCol === "stripe_session_id"
      ? await sql<{ id: string }>(
          `INSERT INTO payments (enrollment_id,tenant_id,amount,payment_method,status,
                                 stripe_session_id,attempt_seq,integration_flow)
           VALUES ($1,$2,100,'stripe','verified',$3,1,'hosted_checkout') RETURNING id`,
          [e.id, t.id, providerId])
      : await sql<{ id: string }>(
          `INSERT INTO payments (enrollment_id,tenant_id,amount,payment_method,status,hitpay_payment_id)
           VALUES ($1,$2,100,'hitpay','verified',$3) RETURNING id`,
          [e.id, t.id, providerId]);
  return { tenantId: t.id, classId: c.id, enrollmentId: e.id, paymentId: p.id };
}

const ticketCount = async (enrollmentId: string) =>
  Number((await sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM tickets WHERE enrollment_id = $1`, [enrollmentId]))[0].n);

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1");
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_only";
  process.env.HITPAY_SALT = "test_salt_only";
});

afterEach(async () => {
  const { tenants, intakes, classes, enrollments } = made;
  if (enrollments.length) {
    await sql(`DELETE FROM tickets WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM payments WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM enrollment_items WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM enrollments WHERE id = ANY($1::uuid[])`, [enrollments]);
  }
  if (classes.length) await sql(`DELETE FROM classes WHERE id = ANY($1::uuid[])`, [classes]);
  if (intakes.length) await sql(`DELETE FROM intakes WHERE id = ANY($1::uuid[])`, [intakes]);
  if (tenants.length) await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  made = fresh();
  vi.clearAllMocks();
  mockVerifyWebhook.mockReturnValue(true);
});

afterAll(async () => { await pool.end(); });

describe("route fulfilment — real tickets", () => {
  it("R1 Stripe verified replay creates the missing ticket rows", async () => {
    const o = await ticketlessConfirmedOrder("stripe_session_id", "cs_r1");
    expect(await ticketCount(o.enrollmentId)).toBe(0);

    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: { object: { id: "cs_r1", payment_status: "paid", payment_intent: "pi_r1" } },
    });

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(new NextRequest(new Request("https://kuunyi.com/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "sig_test" },
      body: JSON.stringify({ ok: true }),
    })));

    expect(res.status).toBe(200);
    expect(await ticketCount(o.enrollmentId)).toBe(2);
  });

  it("R2 HitPay verified replay creates the missing ticket rows", async () => {
    const o = await ticketlessConfirmedOrder("hitpay_payment_id", "hp_r2");
    expect(await ticketCount(o.enrollmentId)).toBe(0);

    mockParseWebhookPayload.mockReturnValue({ id: "hp_r2", status: "completed" });

    const { POST } = await import("@/app/api/webhooks/hitpay/route");
    const res = await POST(new NextRequest(new Request("https://kuunyi.com/api/webhooks/hitpay", {
      method: "POST",
      headers: { "hitpay-signature": "sig_test", "content-type": "application/json" },
      body: JSON.stringify({ id: "hp_r2", status: "completed" }),
    })));

    expect(res.status).toBe(200);
    expect(await ticketCount(o.enrollmentId)).toBe(2);
  });

  it("R3 intent/status on a succeeded PaymentIntent creates real ticket rows", async () => {
    const o = await ticketlessConfirmedOrder("stripe_session_id", "cs_r3");
    await sql(`UPDATE payments SET stripe_payment_intent_id = 'pi_r3' WHERE id = $1`, [o.paymentId]);
    expect(await ticketCount(o.enrollmentId)).toBe(0);

    mockPiRetrieve.mockResolvedValue({ status: "succeeded", payment_method: null });

    const { GET } = await import("@/app/api/public/payments/stripe/intent/status/route");
    const res = await GET(new NextRequest(new Request(
      "https://t.kuunyi.com/api/public/payments/stripe/intent/status?pi=pi_r3")));
    const body = await res.json();

    expect(body).toEqual({ status: "succeeded" }); // shape preserved
    expect(await ticketCount(o.enrollmentId)).toBe(2);
  });

  it("R4 stripe/verify on a paid session creates real ticket rows", async () => {
    const o = await ticketlessConfirmedOrder("stripe_session_id", "cs_r4");
    expect(await ticketCount(o.enrollmentId)).toBe(0);

    mockSessionRetrieve.mockResolvedValue({ payment_status: "paid", payment_intent: "pi_r4" });

    const { GET } = await import("@/app/api/public/payments/stripe/verify/route");
    const res = await GET(new NextRequest(new Request(
      "https://t.kuunyi.com/api/public/payments/stripe/verify?session_id=cs_r4")));
    const body = await res.json();

    // Enrollment status, not a Stripe status — the consumer maps this to a label.
    expect(body.status).toBe("confirmed");
    expect(await ticketCount(o.enrollmentId)).toBe(2);
  });
});
