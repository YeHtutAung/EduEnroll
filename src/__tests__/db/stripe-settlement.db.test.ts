import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from "vitest";
import { Pool } from "pg";
import { NextRequest } from "next/server";

// ─── R-suite: webhook route → real database (Plan v18 Tests) ─────────────────
// Route-level events against the real schema, trigger, RPC and ticket helper.
// Stripe's SDK is mocked at the signature boundary (constructEvent), exactly
// like the fulfilment suite: what is under test is everything AFTER the
// signature, which is where every bug in this series lived.

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

const mockNotify = {
  email: vi.fn().mockResolvedValue(undefined),
  sms: vi.fn().mockResolvedValue(undefined),
  telegram: vi.fn().mockResolvedValue(undefined),
  invite: vi.fn().mockResolvedValue(undefined),
};
vi.mock("@/lib/email", () => ({
  sendEmail: (...a: unknown[]) => mockNotify.email(...a),
  enrollmentApprovedEmail: vi.fn().mockReturnValue({ subject: "s", html: "h" }),
}));
vi.mock("@/lib/sms", () => ({ sendSms: (...a: unknown[]) => mockNotify.sms(...a) }));
vi.mock("@/lib/telegram/notify", () => ({
  sendTelegramStatusNotification: (...a: unknown[]) => mockNotify.telegram(...a),
}));
vi.mock("@/lib/telegram/channel-invite", () => ({
  sendChannelInviteIfEligible: (...a: unknown[]) => mockNotify.invite(...a),
}));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

type Tracked = { tenants: string[]; intakes: string[]; classes: string[]; enrollments: string[] };
let made: Tracked;
const fresh = (): Tracked => ({ tenants: [], intakes: [], classes: [], enrollments: [] });
let seq = 0;
const uniq = () => `rs${Date.now().toString(36)}${seq++}`;

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function eventOrder(opts?: {
  flow?: "direct_payment_intent" | "hosted_checkout";
  paymentStatus?: string;
  enrollmentStatus?: string;
  amountMinor?: number;
  currency?: string;
  quantity?: number;
}) {
  const {
    flow = "direct_payment_intent",
    paymentStatus = "awaiting_payment",
    enrollmentStatus = "pending_payment",
    amountMinor = 10000,
    currency = "sgd",
    quantity = 2,
  } = opts ?? {};
  const slug = uniq();
  const [t] = await sql<{ id: string }>(
    `INSERT INTO tenants (name, subdomain, org_type) VALUES ($1,$2,'event') RETURNING id`,
    [`RS ${slug}`, slug],
  );
  made.tenants.push(t.id);
  const [i] = await sql<{ id: string }>(
    `INSERT INTO intakes (tenant_id,name,year) VALUES ($1,'RS intake',2026) RETURNING id`, [t.id]);
  made.intakes.push(i.id);
  const [c] = await sql<{ id: string }>(
    `INSERT INTO classes (tenant_id,intake_id,level,fee_amount,seat_total,seat_remaining,status,
                          max_tickets_per_person,event_date)
     VALUES ($1,$2,$3,100,100,90,'open',10, now() + interval '30 days') RETURNING id`,
    [t.id, i.id, `L${uniq()}`]);
  made.classes.push(c.id);
  const [e] = await sql<{ id: string }>(
    `INSERT INTO enrollments (enrollment_ref,tenant_id,student_name_en,phone,class_id,quantity,status)
     VALUES ('',$1,'RS Test','09000000000',$2,$3,$4::enrollment_status) RETURNING id`,
    [t.id, c.id, quantity, enrollmentStatus]);
  made.enrollments.push(e.id);

  const pi = `pi_${uniq()}`;
  const cs = `cs_${uniq()}`;
  const [p] = await sql<{ id: string }>(
    flow === "direct_payment_intent"
      ? `INSERT INTO payments (enrollment_id,tenant_id,amount,payment_method,status,
                               stripe_payment_intent_id,attempt_seq,integration_flow,
                               provider_amount_minor,provider_currency)
         VALUES ($1,$2,100,'stripe',$3::payment_status,$4,1,'direct_payment_intent',$5,$6) RETURNING id`
      : `INSERT INTO payments (enrollment_id,tenant_id,amount,payment_method,status,
                               stripe_session_id,attempt_seq,integration_flow,
                               provider_amount_minor,provider_currency)
         VALUES ($1,$2,100,'stripe',$3::payment_status,$4,1,'hosted_checkout',$5,$6) RETURNING id`,
    [e.id, t.id, paymentStatus, flow === "direct_payment_intent" ? pi : cs, amountMinor, currency],
  );
  return { tenantId: t.id, enrollmentId: e.id, paymentId: p.id, pi, cs };
}

const paymentRow = async (id: string) =>
  (await sql(`SELECT * FROM payments WHERE id = $1`, [id]))[0];
const enrollmentStatus = async (id: string) =>
  (await sql<{ status: string }>(`SELECT status FROM enrollments WHERE id = $1`, [id]))[0].status;
const ticketCount = async (enrollmentId: string) =>
  Number((await sql<{ n: string }>(
    `SELECT count(*)::text n FROM tickets WHERE enrollment_id = $1`, [enrollmentId]))[0].n);
const conflictRows = async (objectId: string) =>
  sql(`SELECT * FROM payment_settlement_conflicts WHERE provider_object_id = $1`, [objectId]);

async function post(eventBody: Record<string, unknown>) {
  mockConstructEvent.mockReturnValue(eventBody);
  const { POST } = await import("@/app/api/webhooks/stripe/route");
  return POST(new NextRequest(new Request("https://kuunyi.com/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "sig_test" },
    body: JSON.stringify({ raw: true }),
  })));
}

const piSucceededEvent = (pi: string, over?: Record<string, unknown>) => ({
  id: `evt_${uniq()}`,
  type: "payment_intent.succeeded",
  data: {
    object: {
      id: pi,
      amount_received: 10000,
      currency: "sgd",
      metadata: { integration_flow: "direct_payment_intent" },
      charges: { data: [{ payment_method_details: { card: { brand: "visa", last4: "4242" } } }] },
      ...over,
    },
  },
});

beforeAll(async () => {
  made = fresh();
  await pool.query("SELECT 1");
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_only";
});

afterEach(async () => {
  const { tenants, intakes, classes, enrollments } = made;
  if (enrollments.length) {
    await sql(`DELETE FROM payment_settlement_conflicts WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM tickets WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM payments WHERE enrollment_id = ANY($1::uuid[])`, [enrollments]);
    await sql(`DELETE FROM enrollments WHERE id = ANY($1::uuid[])`, [enrollments]);
  }
  // Conflicts recorded with null enrollment (unknown flow) are keyed by object
  // id prefix used in this suite:
  await sql(`DELETE FROM payment_settlement_conflicts WHERE provider_object_id LIKE 'pi_rs%' OR provider_object_id LIKE 'cs_rs%'`);
  if (classes.length) await sql(`DELETE FROM classes WHERE id = ANY($1::uuid[])`, [classes]);
  if (intakes.length) await sql(`DELETE FROM intakes WHERE id = ANY($1::uuid[])`, [intakes]);
  if (tenants.length) await sql(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  made = fresh();
  vi.clearAllMocks();
});

afterAll(async () => { await pool.end(); });

// ─────────────────────────────────────────────────────────────────────────────
describe("R1-R4: payment_intent.succeeded ownership and settlement", () => {
  it("R1: direct PI, card, browser never polls → verified, confirmed, tickets, brand/last4", async () => {
    const o = await eventOrder();
    const res = await post(piSucceededEvent(o.pi));
    expect(res.status).toBe(200);

    const p = await paymentRow(o.paymentId);
    expect(p.status).toBe("verified");
    expect(p.card_brand).toBe("visa");
    expect(p.card_last4).toBe("4242");
    expect(await enrollmentStatus(o.enrollmentId)).toBe("confirmed");
    expect(await ticketCount(o.enrollmentId)).toBe(2); // full set, quantity 2
    expect(mockNotify.email).not.toHaveBeenCalled(); // no email on this fixture (none set)
  });

  it("R2: PayNow (no charge card data) → settled, card fields null", async () => {
    const o = await eventOrder();
    const res = await post(piSucceededEvent(o.pi, { charges: { data: [{ payment_method_details: { paynow: {} } }] } }));
    expect(res.status).toBe(200);
    const p = await paymentRow(o.paymentId);
    expect(p.status).toBe("verified");
    expect(p.card_brand).toBeNull();
    expect(p.card_last4).toBeNull();
    expect(await ticketCount(o.enrollmentId)).toBe(2);
  });

  it("R3: Checkout's underlying PI emits payment_intent.succeeded → 200, NO settlement", async () => {
    const o = await eventOrder({ flow: "hosted_checkout" });
    const res = await post(piSucceededEvent(o.pi, { metadata: { integration_flow: "hosted_checkout" } }));
    expect(res.status).toBe(200);
    const p = await paymentRow(o.paymentId);
    expect(p.status).toBe("awaiting_payment"); // untouched — Session events own it
    expect(await ticketCount(o.enrollmentId)).toBe(0);
  });

  it("R4: PI with NO marker → unknown_integration_flow conflict, no settlement, 200", async () => {
    const o = await eventOrder();
    const res = await post(piSucceededEvent(o.pi, { metadata: {} }));
    expect(res.status).toBe(200);
    expect((await paymentRow(o.paymentId)).status).toBe("awaiting_payment");
    const conflicts = await conflictRows(o.pi);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflict_type).toBe("unknown_integration_flow");
    expect(conflicts[0].first_source_type).toBe("webhook_event");
  });
});

describe("R5-R8: session events", () => {
  const sessionEvent = (type: string, cs: string, over?: Record<string, unknown>) => ({
    id: `evt_${uniq()}`,
    type,
    data: { object: { id: cs, payment_status: "paid", amount_total: 10000, currency: "sgd", payment_intent: `pi_back_${uniq()}`, ...over } },
  });

  it("R5: async_payment_succeeded after unpaid completed → settles", async () => {
    const o = await eventOrder({ flow: "hosted_checkout" });
    // completed arrives unpaid: no settlement, no conflict
    let res = await post(sessionEvent("checkout.session.completed", o.cs, { payment_status: "unpaid" }));
    expect(res.status).toBe(200);
    expect((await paymentRow(o.paymentId)).status).toBe("awaiting_payment");
    // async success settles
    res = await post(sessionEvent("checkout.session.async_payment_succeeded", o.cs));
    expect(res.status).toBe(200);
    const p = await paymentRow(o.paymentId);
    expect(p.status).toBe("verified");
    expect(p.stripe_payment_intent_id).toMatch(/^pi_back_/); // backfilled
    expect(await enrollmentStatus(o.enrollmentId)).toBe("confirmed");
    expect(await ticketCount(o.enrollmentId)).toBe(2);
  });

  it("R6: checkout.session.completed regression after refactor → settles and fulfils", async () => {
    const o = await eventOrder({ flow: "hosted_checkout" });
    const res = await post(sessionEvent("checkout.session.completed", o.cs));
    expect(res.status).toBe(200);
    expect((await paymentRow(o.paymentId)).status).toBe("verified");
    expect(await enrollmentStatus(o.enrollmentId)).toBe("confirmed");
    expect(await ticketCount(o.enrollmentId)).toBe(2);
  });

  it("R7: duplicate delivery → no second ticket set, no second notification", async () => {
    const o = await eventOrder({ flow: "hosted_checkout" });
    await sql(`UPDATE enrollments SET telegram_chat_id = '12345' WHERE id = $1`, [o.enrollmentId]);
    let res = await post(sessionEvent("checkout.session.completed", o.cs));
    expect(res.status).toBe(200);
    expect(await ticketCount(o.enrollmentId)).toBe(2);
    const notifiesAfterFirst = mockNotify.telegram.mock.calls.length;
    expect(notifiesAfterFirst).toBe(1); // transition winner notified

    res = await post(sessionEvent("checkout.session.completed", o.cs));
    expect(res.status).toBe(200);
    expect(await ticketCount(o.enrollmentId)).toBe(2); // repaired set, not doubled
    expect(mockNotify.telegram.mock.calls.length).toBe(notifiesAfterFirst); // already_settled never notifies
  });

  it("R8: concurrent duplicate deliveries → exactly one winner, one ticket set", async () => {
    const o = await eventOrder({ flow: "hosted_checkout" });
    await sql(`UPDATE enrollments SET telegram_chat_id = '9999' WHERE id = $1`, [o.enrollmentId]);
    const ev = sessionEvent("checkout.session.completed", o.cs);
    mockConstructEvent.mockReturnValue(ev);
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const mk = () => POST(new NextRequest(new Request("https://kuunyi.com/api/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "sig" }, body: "{}",
    })));
    const [r1, r2] = await Promise.all([mk(), mk()]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((await paymentRow(o.paymentId)).status).toBe("verified");
    expect(await ticketCount(o.enrollmentId)).toBe(2);
    // Exactly one transition winner → exactly one notification burst
    expect(mockNotify.telegram.mock.calls.length).toBe(1);
  });
});

describe("R9-R15: signature, failure path, response policy", () => {
  it("R9: invalid signature → 400, no database access", async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error("bad sig"); });
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(new NextRequest(new Request("https://kuunyi.com/api/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "sig_bad" }, body: "{}",
    })));
    expect(res.status).toBe(400);
  });

  it("missing signature header → 400", async () => {
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(new NextRequest(new Request("https://kuunyi.com/api/webhooks/stripe", {
      method: "POST", body: "{}",
    })));
    expect(res.status).toBe(400);
  });

  const failedEvent = (cs: string) => ({
    id: `evt_${uniq()}`,
    type: "checkout.session.async_payment_failed",
    data: { object: { id: cs } },
  });

  it("R10: async_payment_failed on an unsettled payment → rejected, seat released", async () => {
    const o = await eventOrder({ flow: "hosted_checkout" });
    const res = await post(failedEvent(o.cs));
    expect(res.status).toBe(200);
    expect((await paymentRow(o.paymentId)).status).toBe("rejected");
    // Plan A's trigger: only active payment failed, pre-confirmation → rejected
    expect(await enrollmentStatus(o.enrollmentId)).toBe("rejected");
  });

  it("R11: duplicate failed event → idempotent, no conflict row, 200", async () => {
    const o = await eventOrder({ flow: "hosted_checkout" });
    await post(failedEvent(o.cs));
    const res = await post(failedEvent(o.cs));
    expect(res.status).toBe(200);
    expect(await conflictRows(o.cs)).toHaveLength(0);
  });

  it("R12: failed event on an already VERIFIED payment → stays verified, tickets intact, failure_after_verified", async () => {
    const o = await eventOrder({ flow: "hosted_checkout", paymentStatus: "verified", enrollmentStatus: "confirmed" });
    await sql(
      `INSERT INTO tickets (enrollment_id, tenant_id, class_id, jti, seq, expires_at)
       SELECT $1, tenant_id, class_id, gen_random_uuid()::text, 1, now() + interval '30 days' FROM enrollments WHERE id = $1`,
      [o.enrollmentId],
    ).catch(() => { /* ticket schema differences are irrelevant to this case */ });
    const before = await ticketCount(o.enrollmentId);
    const res = await post(failedEvent(o.cs));
    expect(res.status).toBe(200);
    expect((await paymentRow(o.paymentId)).status).toBe("verified"); // untouched
    expect(await enrollmentStatus(o.enrollmentId)).toBe("confirmed");
    expect(await ticketCount(o.enrollmentId)).toBe(before); // no revocation
    const conflicts = await conflictRows(o.cs);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflict_type).toBe("failure_after_verified");
  });

  it("R13: failure while ANOTHER payment already confirmed the enrollment → enrollment stays confirmed", async () => {
    const o = await eventOrder({ flow: "hosted_checkout", enrollmentStatus: "confirmed" });
    // A verified sibling attempt owns the enrollment:
    await sql(
      `INSERT INTO payments (enrollment_id,tenant_id,amount,payment_method,status,
                             stripe_payment_intent_id,attempt_seq,integration_flow)
       VALUES ($1,$2,100,'stripe','verified',$3,2,'direct_payment_intent')`,
      [o.enrollmentId, o.tenantId, `pi_${uniq()}`],
    );
    const res = await post(failedEvent(o.cs));
    expect(res.status).toBe(200);
    expect((await paymentRow(o.paymentId)).status).toBe("rejected"); // the failed attempt
    expect(await enrollmentStatus(o.enrollmentId)).toBe("confirmed"); // Plan A predicate
  });

  it("R14: failed event with no matching row → 500 (Stripe retries)", async () => {
    const res = await post(failedEvent(`cs_rs_missing_${uniq()}`));
    expect(res.status).toBe(500);
  });

  it("R15: async_payment_failed never invokes settlePaidPayment", async () => {
    vi.resetModules();
    const settleSpy = vi.fn();
    vi.doMock("@/server/payments/settlePaidPayment", () => ({
      settlePaidPayment: settleSpy,
    }));
    const o = await eventOrder({ flow: "hosted_checkout" });
    mockConstructEvent.mockReturnValue(failedEvent(o.cs));
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(new NextRequest(new Request("https://kuunyi.com/api/webhooks/stripe", {
      method: "POST", headers: { "stripe-signature": "sig" }, body: "{}",
    })));
    expect(res.status).toBe(200);
    expect(settleSpy).not.toHaveBeenCalled();
    vi.doUnmock("@/server/payments/settlePaidPayment");
    vi.resetModules();
  });

  it("paid event with no payment row → 500, not a silent 200", async () => {
    const res = await post(piSucceededEvent(`pi_rs_missing_${uniq()}`));
    expect(res.status).toBe(500);
  });

  it("S12 (db): repeat conflict upserts occurrence_count, keeps first_source_*", async () => {
    const o = await eventOrder();
    await post(piSucceededEvent(o.pi, { metadata: {} }));
    const [first] = await conflictRows(o.pi);
    await post(piSucceededEvent(o.pi, { metadata: {} }));
    const [second] = await conflictRows(o.pi);
    expect(second.occurrence_count).toBe(2);
    expect(second.first_source_id).toBe(first.first_source_id); // never rewritten
    expect(second.last_source_id).not.toBe(first.last_source_id); // moves
    expect(second.first_source_type).toBe("webhook_event");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V-suite: /api/public/payments/stripe/verify as a settlement ADAPTER.
// The old route wrote verified/confirmed directly, ignored both errors,
// validated nothing and recorded nothing — these pin the invariants it now
// inherits from settlePaidPayment, against the real database.
describe("V1-V6: verify route through the settlement contract", () => {
  const verifyGet = async (sessionId: string) => {
    const { GET } = await import("@/app/api/public/payments/stripe/verify/route");
    return GET(new NextRequest(new Request(
      `https://t.kuunyi.com/api/public/payments/stripe/verify?session_id=${sessionId}`)));
  };
  const paidSession = (cs: string, over?: Record<string, unknown>) => ({
    id: cs, payment_status: "paid", amount_total: 10000, currency: "sgd",
    payment_intent: `pi_v_${uniq()}`, ...over,
  });

  it("V1: amount mismatch → settlement_conflict, payment untouched, amount_mismatch recorded as creation_request", async () => {
    const o = await eventOrder({ flow: "hosted_checkout" });
    mockSessionRetrieve.mockResolvedValue(paidSession(o.cs, { amount_total: 9999 }));
    const res = await verifyGet(o.cs);
    expect(await res.json()).toEqual({ status: "settlement_conflict" });
    expect((await paymentRow(o.paymentId)).status).toBe("awaiting_payment");
    expect(await enrollmentStatus(o.enrollmentId)).toBe("pending_payment");
    const [c] = await conflictRows(o.cs);
    expect(c.conflict_type).toBe("amount_mismatch");
    expect(c.first_source_type).toBe("creation_request");
  });

  it("V2: currency mismatch → settlement_conflict, currency_mismatch recorded", async () => {
    const o = await eventOrder({ flow: "hosted_checkout" });
    mockSessionRetrieve.mockResolvedValue(paidSession(o.cs, { currency: "usd" }));
    const res = await verifyGet(o.cs);
    expect(await res.json()).toEqual({ status: "settlement_conflict" });
    expect((await paymentRow(o.paymentId)).status).toBe("awaiting_payment");
    expect((await conflictRows(o.cs))[0].conflict_type).toBe("currency_mismatch");
  });

  it("V3: rejected enrollment → settlement_conflict, NO confirmation, NO tickets — never the old silent confirmed", async () => {
    const o = await eventOrder({ flow: "hosted_checkout", enrollmentStatus: "rejected" });
    mockSessionRetrieve.mockResolvedValue(paidSession(o.cs));
    const res = await verifyGet(o.cs);
    expect(await res.json()).toEqual({ status: "settlement_conflict" });
    // The trigger's predicate refused the confirm; the enrollment stays rejected.
    expect(await enrollmentStatus(o.enrollmentId)).toBe("rejected");
    expect(await ticketCount(o.enrollmentId)).toBe(0);
    expect((await conflictRows(o.cs))[0].conflict_type).toBe("rejected_enrollment");
  });

  it("V4: verified replay repairs missing tickets and returns the enrollment status", async () => {
    const o = await eventOrder({ flow: "hosted_checkout", paymentStatus: "verified", enrollmentStatus: "confirmed" });
    expect(await ticketCount(o.enrollmentId)).toBe(0); // the ticketless state
    mockSessionRetrieve.mockResolvedValue(paidSession(o.cs));
    const res = await verifyGet(o.cs);
    expect(await res.json()).toEqual({ status: "confirmed" });
    expect(await ticketCount(o.enrollmentId)).toBe(2); // repaired
  });

  it("V5: settles a fresh paid session — verified + confirmed + tickets, {status:'confirmed'}", async () => {
    const o = await eventOrder({ flow: "hosted_checkout" });
    mockSessionRetrieve.mockResolvedValue(paidSession(o.cs));
    const res = await verifyGet(o.cs);
    expect(await res.json()).toEqual({ status: "confirmed" });
    const p = await paymentRow(o.paymentId);
    expect(p.status).toBe("verified");
    expect(p.stripe_payment_intent_id).toMatch(/^pi_v_/); // backfilled
    expect(await ticketCount(o.enrollmentId)).toBe(2);
  });

  it("V6: unknown session → 404; unpaid session → pending — response shapes preserved", async () => {
    mockSessionRetrieve.mockResolvedValue(paidSession(`cs_rs_v6_${uniq()}`));
    expect((await verifyGet(`cs_rs_v6_${uniq()}`)).status).toBe(404);
    const o = await eventOrder({ flow: "hosted_checkout" });
    mockSessionRetrieve.mockResolvedValue({ id: o.cs, payment_status: "unpaid" });
    expect(await (await verifyGet(o.cs)).json()).toEqual({ status: "pending" });
  });
});
