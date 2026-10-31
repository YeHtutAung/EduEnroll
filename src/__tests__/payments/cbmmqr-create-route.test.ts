import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── POST /api/public/payments/cbmmqr ───────────────────────────────────────
// Spec §5.1, §5.2, §8. Ordering and translation:
//   - the payment row exists BEFORE any CB call (R2)
//   - an ambiguous CB answer never marks the row terminal (R13)
//   - a QR that would outlive the enrollment is never returned (§5.1 step 7)
//   - a live QR is never replaced unless resolveCbmmqrOrder says retire

Object.assign(process.env, {
  CBMMQR_YOUNGMONEY_USER_ID: "u", CBMMQR_YOUNGMONEY_PASSWORD: "p", CBMMQR_YOUNGMONEY_SOURCE_ID: "s",
  CBMMQR_YOUNGMONEY_MERCHANT_ID: "M0001", CBMMQR_YOUNGMONEY_TERMINAL_ID: "T0001", CBMMQR_YOUNGMONEY_API_KEY: "k",
  CBMMQR_OTHER_USER_ID: "u2", CBMMQR_OTHER_PASSWORD: "p2", CBMMQR_OTHER_SOURCE_ID: "s2",
  CBMMQR_OTHER_MERCHANT_ID: "M0002", CBMMQR_OTHER_TERMINAL_ID: "T0002", CBMMQR_OTHER_API_KEY: "k2",
});

type Row = Record<string, unknown>;
let enrollment: Row | null;
let tenant: Row | null;
let rpcResults: Record<string, { data: unknown; error: { message: string } | null }>;
let rpcCalls: { name: string; args: Row }[];
let paymentUpdates: { payload: Row; filters: [string, unknown][] }[];
let events: string[];
let latestPayment: Row | null;
let claimErrorsLeft: number;

vi.mock("@/lib/api", () => ({ resolveTenantId: async () => "ten-1" }));

const mockFrom = vi.fn();
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom, rpc: mockRpc }) }));

const mockCreate = vi.fn();
vi.mock("@/lib/cbmmqr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cbmmqr")>();
  return { ...actual, createDynamicQr: (...a: unknown[]) => { events.push("cb:create"); return mockCreate(...a); } };
});

const mockResolve = vi.fn();
vi.mock("@/server/payments/resolveCbmmqrOrder", () => ({
  resolveCbmmqrOrder: (...a: unknown[]) => mockResolve(...a),
}));

vi.mock("@/server/payments/platformFee", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/payments/platformFee")>();
  return { ...actual, attachPackSizes: async (_s: unknown, items: unknown) => items };
});

const { POST } = await import("@/app/api/public/payments/cbmmqr/route");

const MIN = 60_000;
const ENROLLMENT = {
  id: "e-1", enrollment_ref: "ENR-1", tenant_id: "ten-1", class_id: "cls-1", quantity: 2,
  status: "pending_payment", enrolled_at: new Date().toISOString(), student_name_en: "Test",
  classes: { id: "cls-1", fee_amount: 20000, level: "N5" }, enrollment_items: null,
};
const CB_EXPIRY = () => Date.now() + 3 * MIN;

const req = (body: unknown = { enrollmentRef: "ENR-1" }) =>
  new NextRequest("https://beatsrun.kuunyi.com/api/public/payments/cbmmqr", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

const claimRow = (over: Row = {}) => ({
  outcome: "created", payment_id: "pay-1", ref: null, qr: null, merchant: "YOUNGMONEY",
  expires_at: new Date(Date.now() + 5 * MIN).toISOString(), order_ref: null,
  created_at: new Date().toISOString(), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  enrollment = { ...ENROLLMENT };
  tenant = { auto_cancel_hours: 0, payment_mode: "mmqr", platform_fee_mode: "none", platform_fee_amount: 0 };
  rpcCalls = [];
  paymentUpdates = [];
  events = [];
  latestPayment = null;
  claimErrorsLeft = 0;
  rpcResults = {
    claim_cbmmqr_order_slot: { data: [claimRow()], error: null },
    store_cbmmqr_qr: { data: "stored", error: null },
    complete_cbmmqr_replace: { data: [{ outcome: "replaced", payment_id: "pay-2", merchant: "YOUNGMONEY" }], error: null },
  };
  mockCreate.mockResolvedValue({ kind: "created", qr: "000201QR", qrReferenceNo: "QR-1", expiresAtMs: CB_EXPIRY() });

  mockRpc.mockImplementation(async (name: string, args: Row) => {
    events.push(`rpc:${name}`);
    rpcCalls.push({ name, args });
    if (name === "claim_cbmmqr_order_slot" && claimErrorsLeft > 0) {
      claimErrorsLeft--;
      return { data: null, error: { message: "duplicate key value violates unique constraint" } };
    }
    const result = rpcResults[name];
    // As the SQL: a 'created' claim returns the p_payment_ref it inserted.
    if (name === "claim_cbmmqr_order_slot" && Array.isArray(result.data)) {
      const rows = result.data as Row[];
      if (rows[0]?.outcome === "created" && rows[0].ref === null) {
        return { ...result, data: [{ ...rows[0], ref: args.p_payment_ref }] };
      }
    }
    return result;
  });

  mockFrom.mockImplementation((table: string) => {
    if (table === "enrollments") {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: enrollment, error: enrollment ? null : { message: "none" } }) }) }) }) };
    }
    if (table === "tenants") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: tenant, error: null }) }) }) };
    }
    if (table === "payments") {
      return {
        select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ single: async () => ({ data: latestPayment, error: latestPayment ? null : { message: "none" } }) }) }) }) }),
        update: (payload: Row) => {
          const entry = { payload, filters: [] as [string, unknown][] };
          paymentUpdates.push(entry);
          const chain = {
            eq: (col: string, val: unknown) => { entry.filters.push([col, val]); return chain; },
            then: (resolve: (v: unknown) => void) => resolve({ error: null }),
          };
          return chain;
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
});

const called = (name: string) => rpcCalls.filter((c) => c.name === name);

describe("validation and guards", () => {
  it("400 on bad JSON or a missing enrollmentRef", async () => {
    expect((await POST(req("{nope"))).status).toBe(400);
    expect((await POST(req({}))).status).toBe(400);
  });

  it("404 for an unknown enrollment; 409 when it is not awaiting payment", async () => {
    enrollment = null;
    expect((await POST(req())).status).toBe(404);
    enrollment = { ...ENROLLMENT, status: "confirmed" };
    expect((await POST(req())).status).toBe(409);
  });

  it("422 below 1,000 MMK, before any claim or CB call", async () => {
    enrollment = { ...ENROLLMENT, quantity: 1, classes: { id: "cls-1", fee_amount: 999, level: "N5" } };
    const res = await POST(req());
    expect(res.status).toBe(422);
    expect((await res.json()).message).toMatch(/1,000 MMK/);
    expect(rpcCalls).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("409 deadline when auto-cancel leaves no room for a full QR lifetime", async () => {
    tenant = { ...tenant, auto_cancel_hours: 15 };
    enrollment = { ...ENROLLMENT, enrolled_at: new Date(Date.now() - 11 * MIN).toISOString() };
    expect((await POST(req())).status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });

  it("502 and no claim when the tenant row cannot be read", async () => {
    tenant = null;
    expect((await POST(req())).status).toBe(502);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("created", () => {
  it("claims, then calls CB, then stores; returns qr, orderId, amount and expiresAt", async () => {
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(events).toEqual(["rpc:claim_cbmmqr_order_slot", "cb:create", "rpc:store_cbmmqr_qr"]);
    const ref = called("claim_cbmmqr_order_slot")[0].args.p_payment_ref as string;
    expect(ref).toMatch(/^CB[A-Z2-7]{23}$/);
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ referenceNo: ref, amount: 40000 });
    expect(called("store_cbmmqr_qr")[0].args).toMatchObject({ p_payment_ref: ref, p_qr: "000201QR", p_order_ref: "QR-1" });
    expect(body).toMatchObject({ status: "created", qr: "000201QR", orderId: ref, amount: 40000 });
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    // The modal counts down against the server's clock, not the phone's.
    expect(Math.abs(Date.parse(body.serverNow) - Date.now())).toBeLessThan(5000);
  });

  it("uses the merchant pinned by the claim", async () => {
    await POST(req());
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ id: "YOUNGMONEY", merchantId: "M0001" });
  });

  it("broken merchant config right after a created claim: marks the new row FAILED, 503", async () => {
    rpcResults.claim_cbmmqr_order_slot = { data: [claimRow({ merchant: "NOCONFIG" })], error: null };
    expect((await POST(req())).status).toBe(503);
    const ref = called("claim_cbmmqr_order_slot")[0].args.p_payment_ref;
    expect(paymentUpdates).toHaveLength(1);
    expect(paymentUpdates[0].payload).toEqual({ mmqr_status: "FAILED" });
    expect(paymentUpdates[0].filters).toEqual(expect.arrayContaining([
      ["payment_ref", ref], ["payment_method", "cb_mmqr"], ["mmqr_status", "PENDING"],
    ]));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("reuse with a pinned merchant lacking config: 503, row untouched, QR not returned", async () => {
    rpcResults.claim_cbmmqr_order_slot = {
      data: [claimRow({ outcome: "reuse", ref: "CBOLD", qr: "000201OLD", merchant: "NOCONFIG" })], error: null,
    };
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("000201OLD");
    expect(paymentUpdates).toHaveLength(0);
  });

  it("retries the claim once on a unique violation, with a fresh reference", async () => {
    claimErrorsLeft = 1;
    expect((await POST(req())).status).toBe(200);
    const refs = called("claim_cbmmqr_order_slot").map((c) => c.args.p_payment_ref);
    expect(refs).toHaveLength(2);
    expect(refs[0]).not.toBe(refs[1]);
    expect(mockCreate.mock.calls[0][1].referenceNo).toBe(refs[1]);
  });

  it("partial_payment: charges the remainder and records no platform fee", async () => {
    enrollment = { ...ENROLLMENT, status: "partial_payment" };
    latestPayment = { received_amount: 15000 };
    const body = await (await POST(req())).json();
    expect(called("claim_cbmmqr_order_slot")[0].args).toMatchObject({ p_amount: 25000, p_platform_fee: 0 });
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ amount: 25000 });
    expect(body).toMatchObject({ status: "created", amount: 25000 });
  });

  it("reuse: returns the stored QR without calling CB", async () => {
    rpcResults.claim_cbmmqr_order_slot = { data: [claimRow({ outcome: "reuse", ref: "CBOLD", qr: "000201OLD" })], error: null };
    const body = await (await POST(req())).json();
    expect(body).toMatchObject({ status: "created", qr: "000201OLD", orderId: "CBOLD" });
    expect(Math.abs(Date.parse(body.serverNow) - Date.now())).toBeLessThan(5000);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("409 when the claim says invalid_enrollment", async () => {
    rpcResults.claim_cbmmqr_order_slot = { data: [claimRow({ outcome: "invalid_enrollment" })], error: null };
    expect((await POST(req())).status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("503 on no_merchant or a pinned merchant with no config; CB never called", async () => {
    rpcResults.claim_cbmmqr_order_slot = { data: [claimRow({ outcome: "no_merchant", merchant: null })], error: null };
    expect((await POST(req())).status).toBe(503);
    rpcResults.claim_cbmmqr_order_slot = { data: [claimRow({ merchant: "NOCONFIG" })], error: null };
    expect((await POST(req())).status).toBe(503);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("CB's answer", () => {
  it("ambiguous: 502, row left PENDING (no update), nothing stored", async () => {
    mockCreate.mockResolvedValue({ kind: "ambiguous", code: null });
    expect((await POST(req())).status).toBe(502);
    expect(paymentUpdates).toHaveLength(0);
    expect(called("store_cbmmqr_qr")).toHaveLength(0);
  });

  it.each([
    ["below_minimum", 422], ["above_maximum", 422], ["config", 503],
  ])("rejected (%s): marks the row FAILED and answers %i", async (reason, status) => {
    mockCreate.mockResolvedValue({ kind: "rejected", reason, code: "0051" });
    expect((await POST(req())).status).toBe(status);
    expect(paymentUpdates).toHaveLength(1);
    expect(paymentUpdates[0].payload).toEqual({ mmqr_status: "FAILED" });
    const ref = called("claim_cbmmqr_order_slot")[0].args.p_payment_ref;
    expect(paymentUpdates[0].filters).toEqual(expect.arrayContaining([
      ["payment_ref", ref], ["payment_method", "cb_mmqr"], ["mmqr_status", "PENDING"],
    ]));
  });

  it("post-check too late: stores CB's reference WITHOUT the QR and answers 409", async () => {
    tenant = { ...tenant, auto_cancel_hours: 15 };
    mockCreate.mockResolvedValue({ kind: "created", qr: "000201QR", qrReferenceNo: "QR-1", expiresAtMs: Date.now() + 60 * MIN });
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(called("store_cbmmqr_qr")[0].args).toMatchObject({ p_qr: null, p_order_ref: "QR-1" });
    expect(JSON.stringify(await res.json())).not.toContain("000201QR");
  });

  it("post-check: an unreadable CB expiry is never displayed", async () => {
    mockCreate.mockResolvedValue({ kind: "created", qr: "000201QR", qrReferenceNo: "QR-1", expiresAtMs: null });
    expect((await POST(req())).status).toBe(409);
    expect(called("store_cbmmqr_qr")[0].args).toMatchObject({ p_qr: null });
  });

  it("logs an unreadable expiry and an expiry past the deadline as different causes", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logged = () => spy.mock.calls.map((c) => String(c[0])).join("\n");
    mockCreate.mockResolvedValue({ kind: "created", qr: "000201QR", qrReferenceNo: "QR-1", expiresAtMs: null });
    await POST(req());
    const unreadable = logged();
    spy.mockClear();
    tenant = { ...tenant, auto_cancel_hours: 15 };
    mockCreate.mockResolvedValue({ kind: "created", qr: "000201QR", qrReferenceNo: "QR-1", expiresAtMs: Date.now() + 60 * MIN });
    await POST(req());
    const late = logged();
    spy.mockRestore();
    expect(unreadable).toMatch(/expiry unreadable/);
    expect(unreadable).not.toMatch(/outlive/);
    expect(late).toMatch(/outlive/);
    expect(late).not.toMatch(/expiry unreadable/);
  });

  it("409 when the enrollment stopped being payable before the QR was stored", async () => {
    rpcResults.store_cbmmqr_qr = { data: "not_payable", error: null };
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain("000201QR");
  });

  it.each(["not_live", "ref_conflict", "not_found"])("502 when the store returns %s", async (r) => {
    rpcResults.store_cbmmqr_qr = { data: r, error: null };
    expect((await POST(req())).status).toBe(502);
  });

  it("502 when the store errors", async () => {
    rpcResults.store_cbmmqr_qr = { data: null, error: { message: "boom" } };
    expect((await POST(req())).status).toBe(502);
  });
});

describe("unresolved", () => {
  beforeEach(() => {
    rpcResults.claim_cbmmqr_order_slot = {
      data: [claimRow({ outcome: "unresolved", ref: "CBOLD", order_ref: "QR-OLD" })], error: null,
    };
  });

  it("active: 409 qr_active with retryAt; no replacement, no CB create", async () => {
    const retryAtMs = Date.now() + 4 * MIN;
    mockResolve.mockResolvedValue({ kind: "active", retryAtMs });
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ status: "qr_active", retryAt: new Date(retryAtMs).toISOString() });
    expect(body.message).toMatch(/previous QR is still active/);
    expect(called("complete_cbmmqr_replace")).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("passes the old row and its pinned merchant to the resolver", async () => {
    mockResolve.mockResolvedValue({ kind: "active", retryAtMs: Date.now() + MIN });
    await POST(req());
    expect(mockResolve.mock.calls[0][0]).toMatchObject({
      row: { ref: "CBOLD", orderRef: "QR-OLD" }, merchant: { id: "YOUNGMONEY" }, source: "create",
    });
  });

  it("passes createdAtMs, expiresAtMs and displayed from the claim row", async () => {
    const createdAt = new Date(Date.now() - 7 * MIN).toISOString();
    const expiresAt = new Date(Date.now() - 2 * MIN).toISOString();
    mockResolve.mockResolvedValue({ kind: "active", retryAtMs: Date.now() + MIN });
    const unresolved = (qr: string | null) => ({
      data: [claimRow({ outcome: "unresolved", ref: "CBOLD", order_ref: "QR-OLD", qr, created_at: createdAt, expires_at: expiresAt })],
      error: null,
    });

    rpcResults.claim_cbmmqr_order_slot = unresolved("000201OLD");
    const res = await POST(req());
    expect(mockResolve.mock.calls[0][0].row).toEqual({
      ref: "CBOLD", orderRef: "QR-OLD", createdAtMs: Date.parse(createdAt), expiresAtMs: Date.parse(expiresAt), displayed: true,
    });
    expect(JSON.stringify(await res.json())).not.toContain("000201OLD");

    rpcResults.claim_cbmmqr_order_slot = unresolved(null);
    await POST(req());
    expect(mockResolve.mock.calls[1][0].row).toMatchObject({ displayed: false });
  });

  it("replacement row with a merchant lacking config: marks the NEW row FAILED, 503, no CB call", async () => {
    mockResolve.mockResolvedValue({ kind: "retire", reason: "FAILED" });
    rpcResults.complete_cbmmqr_replace = { data: [{ outcome: "replaced", payment_id: "pay-2", merchant: "NOCONFIG" }], error: null };
    expect((await POST(req())).status).toBe(503);
    const newRef = called("complete_cbmmqr_replace")[0].args.p_new_ref;
    expect(newRef).not.toBe("CBOLD");
    expect(paymentUpdates).toHaveLength(1);
    expect(paymentUpdates[0].payload).toEqual({ mmqr_status: "FAILED" });
    expect(paymentUpdates[0].filters).toEqual(expect.arrayContaining([
      ["payment_ref", newRef], ["payment_method", "cb_mmqr"], ["mmqr_status", "PENDING"],
    ]));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("uses the merchant the replace pinned on the new row", async () => {
    mockResolve.mockResolvedValue({ kind: "retire", reason: "FAILED" });
    rpcResults.complete_cbmmqr_replace = { data: [{ outcome: "replaced", payment_id: "pay-2", merchant: "OTHER" }], error: null };
    expect((await POST(req())).status).toBe(200);
    expect(mockResolve.mock.calls[0][0].merchant).toMatchObject({ id: "YOUNGMONEY" });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ id: "OTHER", merchantId: "M0002" });
  });

  it("already_paid → { status: 'already_paid' }", async () => {
    mockResolve.mockResolvedValue({ kind: "already_paid" });
    expect(await (await POST(req())).json()).toEqual({ status: "already_paid" });
  });

  it("settlement_conflict → 409; blocked → 502", async () => {
    mockResolve.mockResolvedValue({ kind: "settlement_conflict", reason: "x" });
    expect((await POST(req())).status).toBe(409);
    mockResolve.mockResolvedValue({ kind: "blocked", reason: "x" });
    expect((await POST(req())).status).toBe(502);
  });

  it("retire: replaces with the tenant id and reason, then creates under the new reference", async () => {
    mockResolve.mockResolvedValue({ kind: "retire", reason: "EXPIRED" });
    const body = await (await POST(req())).json();
    const args = called("complete_cbmmqr_replace")[0].args;
    expect(args).toMatchObject({ p_enrollment_id: "e-1", p_tenant_id: "ten-1", p_expected_old_ref: "CBOLD", p_reason: "EXPIRED" });
    expect(mockCreate.mock.calls[0][1].referenceNo).toBe(args.p_new_ref);
    expect(body.orderId).toBe(args.p_new_ref);
  });

  it.each([
    ["already_settled", 200], ["settling", 409], ["not_payable", 409], ["invalid_enrollment", 409],
    ["no_merchant", 503], ["not_live", 502], ["not_found", 502],
  ])("replace outcome %s → %i", async (outcome, status) => {
    mockResolve.mockResolvedValue({ kind: "retire", reason: "EXPIRED" });
    rpcResults.complete_cbmmqr_replace = { data: [{ outcome, payment_id: null, merchant: null }], error: null };
    const res = await POST(req());
    expect(res.status).toBe(status);
    if (outcome === "already_settled") expect(await res.json()).toEqual({ status: "already_paid" });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
