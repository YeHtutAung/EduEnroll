// Creation-route suite (Plan v18 §3, launch gate, §3b-2 eligibility, §3a
// cleanup ordering). Every "refused" case asserts on the STRIPE MOCK, not
// only the status code — a 409 returned after minting a PaymentIntent would
// still leave a payable object behind.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn(async () => "tenant-1") }));

const mockFrom = vi.fn();
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom, rpc: mockRpc }),
}));

const calls: string[] = []; // cross-mock invocation order
const stripeMock = {
  piCreate: vi.fn(),
  piRetrieve: vi.fn(),
  piCancel: vi.fn(),
  csCreate: vi.fn(),
  csRetrieve: vi.fn(),
  csExpire: vi.fn(),
};
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    paymentIntents: {
      create: (...a: unknown[]) => { calls.push("pi.create"); return stripeMock.piCreate(...a); },
      retrieve: (...a: unknown[]) => { calls.push("pi.retrieve"); return stripeMock.piRetrieve(...a); },
      cancel: (...a: unknown[]) => { calls.push("pi.cancel"); return stripeMock.piCancel(...a); },
    },
    checkout: {
      sessions: {
        create: (...a: unknown[]) => { calls.push("cs.create"); return stripeMock.csCreate(...a); },
        retrieve: (...a: unknown[]) => { calls.push("cs.retrieve"); return stripeMock.csRetrieve(...a); },
        expire: (...a: unknown[]) => { calls.push("cs.expire"); return stripeMock.csExpire(...a); },
      },
    },
  }),
}));

const mockSettle = vi.fn();
vi.mock("@/server/payments/settlePaidPayment", () => ({
  settlePaidPayment: (...a: unknown[]) => mockSettle(...a),
}));

// ── Thenable chain: resolves the next queued response whenever awaited ──────
type Resp = { data: unknown; error: { message: string; code?: string } | null };
let queues: Record<string, Resp[]>;
const queue = (table: string, resp: Resp) => { (queues[table] ??= []).push(resp); };

function chainFor(table: string) {
  const next = (): Resp => {
    const q = queues[table];
    if (!q || q.length === 0) throw new Error(`no queued response for ${table}`);
    return q.shift()!;
  };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "update", "eq", "in", "or", "not", "order", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => next());
  chain.single = vi.fn(async () => next());
  chain.then = (resolve: (v: Resp) => unknown, reject?: (e: unknown) => unknown) => {
    try {
      return Promise.resolve(next()).then(resolve, reject);
    } catch (e) {
      return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
    }
  };
  return chain;
}

const ENROLLMENT = {
  id: "enr-1",
  status: "pending_payment",
  tenant_id: "tenant-1",
  enrollment_ref: "NM-2026-0001",
  quantity: 1,
  class_id: "class-1",
  student_name_en: "S",
  enrollment_items: null,
  classes: { id: "class-1", fee_amount: 100, level: "GA", intakes: null },
};
const ACTIVE_ROW = {
  id: "pay-1", enrollment_id: "enr-1", tenant_id: "tenant-1", status: "awaiting_payment",
  attempt_seq: 1, integration_flow: "direct_payment_intent",
  stripe_payment_intent_id: "pi_active", stripe_session_id: null,
};

function queueHappyLookups(over?: { enrollment?: Record<string, unknown>; attempts?: unknown[] }) {
  queue("enrollments", { data: { ...ENROLLMENT, ...(over?.enrollment ?? {}) }, error: null });
  queue("tenants", { data: { currency: "SGD", name: "T" }, error: null });
  queue("payments", { data: over?.attempts ?? [], error: null }); // selectAttemptContext
}

const intentReq = (ref = "NM-2026-0001") =>
  new NextRequest(new Request("https://t.kuunyi.com/api/public/payments/stripe/intent", {
    method: "POST", body: JSON.stringify({ enrollmentRef: ref }),
  }));
const checkoutReq = (ref = "NM-2026-0001") =>
  new NextRequest(new Request("https://t.kuunyi.com/api/public/payments/stripe", {
    method: "POST", body: JSON.stringify({ enrollmentRef: ref }),
  }));

async function postIntent(ref?: string) {
  const { POST } = await import("@/app/api/public/payments/stripe/intent/route");
  return POST(intentReq(ref));
}
async function postCheckout(ref?: string) {
  const { POST } = await import("@/app/api/public/payments/stripe/route");
  return POST(checkoutReq(ref));
}

const expectStripeUntouched = () => {
  for (const fn of Object.values(stripeMock)) expect(fn).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  queues = {};
  mockFrom.mockImplementation((table: string) => chainFor(table));
  mockRpc.mockImplementation(async (name: string) => {
    calls.push(`rpc.${name}`);
    return { data: null, error: null };
  });
  stripeMock.piCreate.mockResolvedValue({ id: "pi_new", client_secret: "cs_secret", status: "requires_payment_method" });
  stripeMock.piCancel.mockResolvedValue({});
  stripeMock.csCreate.mockResolvedValue({ id: "cs_new", url: "https://stripe.test/pay" });
  stripeMock.csExpire.mockResolvedValue({});
  process.env.STRIPE_SALES_OPEN = "true";
  delete process.env.STRIPE_SMOKE_REFS;
});

// ─────────────────────────────────────────────────────────────────────────────
describe("launch gate — raw exact equality, checked before ANY lookup", () => {
  it.each(["", "TRUE", "1", "yes", " true ", "true\n"])(
    "STRIPE_SALES_OPEN=%j → 503, Stripe untouched, database untouched",
    async (value) => {
      process.env.STRIPE_SALES_OPEN = value;
      const res = await postIntent();
      expect(res.status).toBe(503);
      expectStripeUntouched();
      expect(mockFrom).not.toHaveBeenCalled();
    },
  );

  it("absent → closed (fail-closed default), both routes", async () => {
    delete process.env.STRIPE_SALES_OPEN;
    expect((await postIntent()).status).toBe(503);
    expect((await postCheckout()).status).toBe(503);
    expectStripeUntouched();
  });

  it("smoke ref passes on EXACT match while closed; prefix/substring/case variants 503", async () => {
    delete process.env.STRIPE_SALES_OPEN;
    process.env.STRIPE_SMOKE_REFS = " NM-2026-0001 , NM-9999 ";
    // exact (after entry trim) passes the gate and reaches the enrollment lookup
    queueHappyLookups();
    const ok = await postIntent("NM-2026-0001");
    expect(ok.status).not.toBe(503);
    // variants stay closed
    for (const bad of ["NM-2026-000", "NM-2026-00011", "nm-2026-0001"]) {
      expect((await postIntent(bad)).status).toBe(503);
    }
  });
});

describe("eligibility (§3b-2) — refused BEFORE Stripe", () => {
  it.each(["rejected", "confirmed", "cancelled", "expired"])(
    "intent: %s enrollment → 409 and Stripe never called",
    async (status) => {
      queue("enrollments", { data: { ...ENROLLMENT, status }, error: null });
      const res = await postIntent();
      expect(res.status).toBe(409);
      expectStripeUntouched();
    },
  );

  it("intent refuses partial_payment — no remaining-balance contract on this route", async () => {
    queue("enrollments", { data: { ...ENROLLMENT, status: "partial_payment" }, error: null });
    const res = await postIntent();
    expect(res.status).toBe(409);
    expectStripeUntouched();
  });

  it("checkout accepts partial_payment and charges the remaining balance", async () => {
    queue("enrollments", { data: { ...ENROLLMENT, status: "partial_payment" }, error: null });
    queue("tenants", { data: { currency: "SGD", name: "T" }, error: null });
    queue("payments", { data: { received_amount: 40 }, error: null }); // partial history
    queue("payments", { data: [], error: null }); // attempt context
    const res = await postCheckout();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "redirect", url: "https://stripe.test/pay" });
    const createArgs = stripeMock.csCreate.mock.calls[0][0] as {
      line_items: { price_data: { unit_amount: number } }[];
    };
    expect(createArgs.line_items[0].price_data.unit_amount).toBe(6000); // (100-40) SGD
  });

  it("enrollment lookup ERROR → 500, never treated as not-found, Stripe untouched", async () => {
    queue("enrollments", { data: null, error: { message: "db down" } });
    const res = await postIntent();
    expect(res.status).toBe(500);
    expectStripeUntouched();
  });

  it("non-allowlist currency → 400 before Stripe", async () => {
    queue("enrollments", { data: ENROLLMENT, error: null });
    queue("tenants", { data: { currency: "USD", name: "T" }, error: null });
    const res = await postIntent();
    expect(res.status).toBe(400);
    expectStripeUntouched();
  });

  it("fractional fee → 400 before Stripe (whole-unit contract, primary gate)", async () => {
    queue("enrollments", {
      data: { ...ENROLLMENT, classes: { ...ENROLLMENT.classes, fee_amount: 12.34 } },
      error: null,
    });
    queue("tenants", { data: { currency: "SGD", name: "T" }, error: null });
    const res = await postIntent();
    expect(res.status).toBe(400);
    expectStripeUntouched();
  });
});

describe("creation — predecessor-bound identity and the §4 metadata contract", () => {
  it("first attempt: :initial key, full six-field metadata, finalize called, requires_payment", async () => {
    queueHappyLookups();
    const res = await postIntent();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "requires_payment", clientSecret: "cs_secret" });

    const [params, opts] = stripeMock.piCreate.mock.calls[0] as [
      { amount: number; currency: string; metadata: Record<string, string> },
      { idempotencyKey: string },
    ];
    expect(opts.idempotencyKey).toBe("stripe:direct_payment_intent:enr-1:initial");
    expect(params.amount).toBe(10000); // SGD 100 → whole-unit conversion
    expect(params.metadata).toEqual({
      integration_namespace: "eduenroll",
      integration_version: "1",
      integration_flow: "direct_payment_intent",
      tenant_id: "tenant-1",
      enrollment_id: "enr-1",
      enrollment_ref: "NM-2026-0001",
    });
    expect(mockRpc).toHaveBeenCalledWith(
      "finalize_stripe_payment_attempt",
      expect.objectContaining({ p_attempt_seq: 1, p_predecessor_payment_id: null, p_currency: "sgd" }),
    );
  });

  it("checkout: the underlying PI carries the SAME contract via payment_intent_data", async () => {
    queueHappyLookups();
    const res = await postCheckout();
    expect(res.status).toBe(200);
    const [params, opts] = stripeMock.csCreate.mock.calls[0] as [
      { metadata: Record<string, string>; payment_intent_data: { metadata: Record<string, string> } },
      { idempotencyKey: string },
    ];
    expect(opts.idempotencyKey).toBe("stripe:hosted_checkout:enr-1:initial");
    expect(params.payment_intent_data.metadata).toEqual(params.metadata);
    expect(params.payment_intent_data.metadata.integration_flow).toBe("hosted_checkout");
    expect(params.payment_intent_data.metadata.integration_namespace).toBe("eduenroll");
  });

  it("rejected latest attempt anchors the next: after:{id} key, attempt+1, no LIMIT-1 shortcut", async () => {
    queueHappyLookups({
      attempts: [{ ...ACTIVE_ROW, status: "rejected", attempt_seq: 3, id: "pay-rejected" }],
    });
    await postIntent();
    const [, opts] = stripeMock.piCreate.mock.calls[0] as [unknown, { idempotencyKey: string }];
    expect(opts.idempotencyKey).toBe("stripe:direct_payment_intent:enr-1:after:pay-rejected");
    expect(mockRpc).toHaveBeenCalledWith(
      "finalize_stripe_payment_attempt",
      expect.objectContaining({ p_attempt_seq: 4, p_predecessor_payment_id: "pay-rejected" }),
    );
  });

  it("TWO active rows → 500 fail-closed, Stripe never called", async () => {
    queueHappyLookups({
      attempts: [
        { ...ACTIVE_ROW, attempt_seq: 2, id: "pay-2" },
        { ...ACTIVE_ROW, attempt_seq: 1, id: "pay-1" },
      ],
    });
    const res = await postIntent();
    expect(res.status).toBe(500);
    expectStripeUntouched();
  });
});

describe("active attempt — provider-state contract (§3c)", () => {
  const activeCtx = () => queueHappyLookups({ attempts: [ACTIVE_ROW] });

  it("requires_payment_method → reuse, create NOT called", async () => {
    activeCtx();
    stripeMock.piRetrieve.mockResolvedValue({ id: "pi_active", status: "requires_payment_method", client_secret: "cs_a" });
    const res = await postIntent();
    expect(await res.json()).toMatchObject({ kind: "requires_payment", clientSecret: "cs_a" });
    expect(stripeMock.piCreate).not.toHaveBeenCalled();
  });

  it("processing → {kind:'processing'}, NO client secret in the response", async () => {
    activeCtx();
    stripeMock.piRetrieve.mockResolvedValue({ id: "pi_active", status: "processing", client_secret: "cs_a" });
    const body = await (await postIntent()).json();
    expect(body).toEqual({ kind: "processing", paymentIntentId: "pi_active" });
    expect(JSON.stringify(body)).not.toContain("cs_a");
  });

  it("succeeded → settles synchronously; settled → {kind:'succeeded'}", async () => {
    activeCtx();
    stripeMock.piRetrieve.mockResolvedValue({ id: "pi_active", status: "succeeded", amount_received: 10000, currency: "sgd" });
    mockSettle.mockResolvedValue({ kind: "settled", paymentId: "pay-1", enrollmentId: "enr-1" });
    const body = await (await postIntent()).json();
    expect(body).toEqual({ kind: "succeeded", paymentIntentId: "pi_active" });
    expect(mockSettle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ paymentIntentId: "pi_active" }),
    );
  });

  it("succeeded + terminal settlement conflict → settlement_conflict, client stops polling", async () => {
    activeCtx();
    stripeMock.piRetrieve.mockResolvedValue({ id: "pi_active", status: "succeeded", amount_received: 10000, currency: "sgd" });
    mockSettle.mockResolvedValue({ kind: "conflict", conflictType: "rejected_enrollment" });
    const body = await (await postIntent()).json();
    expect(body).toMatchObject({ kind: "settlement_conflict", reference: "NM-2026-0001" });
  });

  it("canceled → replacement keyed after the retired row", async () => {
    activeCtx();
    stripeMock.piRetrieve.mockResolvedValue({ id: "pi_active", status: "canceled" });
    const res = await postIntent();
    expect(res.status).toBe(200);
    const [, opts] = stripeMock.piCreate.mock.calls[0] as [unknown, { idempotencyKey: string }];
    expect(opts.idempotencyKey).toBe("stripe:direct_payment_intent:enr-1:after:pay-1");
    expect(mockRpc).toHaveBeenCalledWith(
      "finalize_stripe_payment_attempt",
      expect.objectContaining({ p_attempt_seq: 2, p_predecessor_payment_id: "pay-1" }),
    );
  });

  it("retrieval failure (not resource_missing) → 502, create nothing", async () => {
    activeCtx();
    stripeMock.piRetrieve.mockRejectedValue(Object.assign(new Error("rate limited"), { code: "rate_limit" }));
    const res = await postIntent();
    expect(res.status).toBe(502);
    expect(stripeMock.piCreate).not.toHaveBeenCalled();
  });

  it("resource_missing → definitively terminal, replacement allowed", async () => {
    activeCtx();
    stripeMock.piRetrieve.mockRejectedValue(Object.assign(new Error("gone"), { code: "resource_missing" }));
    const res = await postIntent();
    expect(res.status).toBe(200);
    expect(stripeMock.piCreate).toHaveBeenCalledTimes(1);
  });

  it("active attempt from the OTHER flow → 409, its provider state is not judged here", async () => {
    queueHappyLookups({
      attempts: [{ ...ACTIVE_ROW, integration_flow: "hosted_checkout", stripe_payment_intent_id: null, stripe_session_id: "cs_x" }],
    });
    const res = await postIntent();
    expect(res.status).toBe(409);
    expectStripeUntouched();
  });
});

describe("typed finalize failures — §3a cleanup ordering", () => {
  const rpcFail = (code: string) => {
    mockRpc.mockImplementation(async (name: string) => {
      calls.push(`rpc.${name}`);
      if (name === "finalize_stripe_payment_attempt") {
        return { data: null, error: { message: "typed", code } };
      }
      if (name === "complete_stripe_cleanup") return { data: true, error: null };
      return { data: null, error: null };
    });
  };

  it("ST004 → conflict recorded (shape i), cancel NEVER called", async () => {
    queueHappyLookups();
    rpcFail("ST004");
    const res = await postIntent();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "settlement_conflict" });
    expect(stripeMock.piCancel).not.toHaveBeenCalled();
    expect(calls).toContain("rpc.record_stripe_conflict");
    expect(calls).not.toContain("rpc.record_stripe_cleanup_conflict");
  });

  it("ST002, unowned → record 'pending' BEFORE cancel, then done, then the conflict response", async () => {
    queueHappyLookups();
    queue("payments", { data: null, error: null }); // ownership lookup: no owner
    rpcFail("ST002");
    const res = await postIntent();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "settlement_conflict" });
    const record = calls.indexOf("rpc.record_stripe_cleanup_conflict");
    const cancel = calls.indexOf("pi.cancel");
    const done = calls.indexOf("rpc.complete_stripe_cleanup");
    expect(record).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(record); // recording PRECEDES cleanup
    expect(done).toBeGreaterThan(cancel);
  });

  it("ST003, owner exists → leave the object (no cancel), record, conflict", async () => {
    queueHappyLookups();
    queue("payments", { data: { id: "pay-owner" }, error: null }); // owned
    rpcFail("ST003");
    const res = await postIntent();
    expect(res.status).toBe(200);
    expect(stripeMock.piCancel).not.toHaveBeenCalled();
    expect(calls).toContain("rpc.record_stripe_conflict");
  });

  it("ST002, pending write FAILS → EMERGENCY cancel still called, 500", async () => {
    queueHappyLookups();
    queue("payments", { data: null, error: null }); // no owner
    mockRpc.mockImplementation(async (name: string) => {
      calls.push(`rpc.${name}`);
      if (name === "finalize_stripe_payment_attempt")
        return { data: null, error: { message: "typed", code: "ST002" } };
      if (name === "record_stripe_cleanup_conflict")
        return { data: null, error: { message: "conflict table down" } };
      return { data: null, error: null };
    });
    const res = await postIntent();
    expect(res.status).toBe(500);
    // The write failing is not permission for the object to stay payable:
    expect(stripeMock.piCancel).toHaveBeenCalledTimes(1);
  });

  it("ST002, cancel fails → 500, row stays pending (no completion attempted)", async () => {
    queueHappyLookups();
    queue("payments", { data: null, error: null });
    rpcFail("ST002");
    stripeMock.piCancel.mockRejectedValue(new Error("stripe down"));
    const res = await postIntent();
    expect(res.status).toBe(500);
    expect(calls).not.toContain("rpc.complete_stripe_cleanup");
  });

  it("ST001 → 500, caller bug: no conflict recorded, no cancel", async () => {
    queueHappyLookups();
    rpcFail("ST001");
    const res = await postIntent();
    expect(res.status).toBe(500);
    expect(stripeMock.piCancel).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.startsWith("rpc.record"))).toHaveLength(0);
  });

  it("no `!== \"mmk\"` remains in either creation route", async () => {
    const fs = await import("node:fs");
    for (const p of [
      "src/app/api/public/payments/stripe/intent/route.ts",
      "src/app/api/public/payments/stripe/route.ts",
    ]) {
      expect(fs.readFileSync(p, "utf8")).not.toMatch(/!==\s*["']mmk["']/);
    }
  });
});
