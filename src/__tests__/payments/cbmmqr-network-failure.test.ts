import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── What a buyer gets when CB cannot be reached ────────────────────────────
// The real route, client and resolver, pressed twice. Only CB's HTTP and the
// database are faked; the fake database holds the one rule that matters here:
// a live PENDING row blocks a new claim.

Object.assign(process.env, {
  CBMMQR_YOUNGMONEY_USER_ID: "u", CBMMQR_YOUNGMONEY_PASSWORD: "p", CBMMQR_YOUNGMONEY_SOURCE_ID: "s",
  CBMMQR_YOUNGMONEY_MERCHANT_ID: "M0001", CBMMQR_YOUNGMONEY_TERMINAL_ID: "T0001",
});

type Payment = {
  ref: string; status: string; qr: string | null; orderRef: string | null; createdAtMs: number; expiresAt: string;
};
let payments: Payment[];

vi.mock("@/lib/api", () => ({ resolveTenantId: async () => "ten-1" }));
vi.mock("@/server/payments/platformFee", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/payments/platformFee")>();
  return { ...actual, attachPackSizes: async (_s: unknown, items: unknown) => items };
});

const liveRow = () => payments.find((p) => p.status === "PENDING");

const rpc = async (name: string, a: Record<string, string>) => {
  if (name === "claim_cbmmqr_order_slot") {
    const live = liveRow();
    if (live) {
      const usable = live.qr && Date.parse(live.expiresAt) > Date.now();
      return {
        data: [{
          outcome: usable ? "reuse" : "unresolved", payment_id: "p", ref: live.ref, qr: live.qr, merchant: "YOUNGMONEY",
          expires_at: live.expiresAt, order_ref: live.orderRef, created_at: new Date(live.createdAtMs).toISOString(),
        }],
        error: null,
      };
    }
    payments.push({
      ref: a.p_payment_ref, status: "PENDING", qr: null, orderRef: null, createdAtMs: Date.now(), expiresAt: a.p_expires_at,
    });
    return {
      data: [{
        outcome: "created", payment_id: "p", ref: a.p_payment_ref, qr: null, merchant: "YOUNGMONEY",
        expires_at: a.p_expires_at, order_ref: null, created_at: new Date().toISOString(),
      }],
      error: null,
    };
  }
  if (name === "complete_cbmmqr_replace") {
    const old = payments.find((p) => p.ref === a.p_expected_old_ref)!;
    old.status = a.p_reason;
    payments.push({
      ref: a.p_new_ref, status: "PENDING", qr: null, orderRef: null, createdAtMs: Date.now(), expiresAt: a.p_expires_at,
    });
    return { data: [{ outcome: "replaced", payment_id: "p2", merchant: "YOUNGMONEY" }], error: null };
  }
  if (name === "store_cbmmqr_qr") {
    const row = payments.find((p) => p.ref === a.p_payment_ref)!;
    Object.assign(row, { qr: a.p_qr, orderRef: a.p_order_ref, expiresAt: a.p_expires_at });
    return { data: "stored", error: null };
  }
  throw new Error(`unexpected rpc ${name}`);
};

const from = (table: string) => {
  if (table === "enrollments") {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: "e-1", enrollment_ref: "ENR-1", tenant_id: "ten-1", class_id: "cls-1", quantity: 1,
                status: "pending_payment", enrolled_at: new Date().toISOString(),
                classes: { id: "cls-1", fee_amount: 20000, level: "N5" }, enrollment_items: null,
              },
              error: null,
            }),
          }),
        }),
      }),
    };
  }
  if (table === "tenants") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { auto_cancel_hours: 0, payment_mode: "mmqr", platform_fee_mode: "none", platform_fee_amount: 0 },
            error: null,
          }),
        }),
      }),
    };
  }
  if (table === "payments") {
    return {
      update: (payload: { mmqr_status: string }) => {
        let ref: unknown;
        const chain = {
          eq: (col: string, val: unknown) => { if (col === "payment_ref") ref = val; return chain; },
          then: (resolve: (v: unknown) => void) => {
            const row = payments.find((p) => p.ref === ref && p.status === "PENDING");
            if (row) row.status = payload.mmqr_status;
            resolve({ error: null });
          },
        };
        return chain;
      },
    };
  }
  throw new Error(`unexpected table ${table}`);
};
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from, rpc }) }));

const { POST } = await import("@/app/api/public/payments/cbmmqr/route");
const { __resetTokenCacheForTests } = await import("@/lib/cbmmqr");

const press = async () => {
  const res = await POST(new NextRequest("https://beatsrun.kuunyi.com/api/public/payments/cbmmqr", {
    method: "POST", body: JSON.stringify({ enrollmentRef: "ENR-1" }), headers: { "Content-Type": "application/json" },
  }));
  return { status: res.status, body: await res.json() };
};

const connectTimeout = () => Object.assign(new TypeError("fetch failed"), {
  cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
});
const tokenBody = { token: "TOKEN", returnCode: "0000" };
const qrBody = { returnCode: "0000", qrCodeInfo: "000201QR", qrReferenceNo: "QR-1", qrExpiredDateTime: "2099-01-01T00:00:00.0" };

let tokenAnswers: (object | Error)[];
let createAnswers: (object | Error)[];
let createCalls: string[];

beforeEach(() => {
  process.env.CBMMQR_BASE_URL = "https://cbgw.test/api";
  __resetTokenCacheForTests();
  payments = [];
  tokenAnswers = [];
  createAnswers = [];
  createCalls = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const isToken = url.endsWith("/auth/token");
    if (!isToken) createCalls.push(String(JSON.parse(String(init.body)).referenceNo));
    const answer = (isToken ? tokenAnswers : createAnswers).shift() ?? new Error("no canned answer");
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer), { status: 200 });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.CBMMQR_BASE_URL;
});

describe("the token request fails, so CB was never asked to create a QR", () => {
  it("frees the row and the very next press gets a QR", async () => {
    tokenAnswers = [connectTimeout(), tokenBody];
    createAnswers = [qrBody];

    const first = await press();
    expect(first.status).toBe(502);
    expect(first.body.message).toMatch(/could not reach CB Bank/);
    expect(first.body.message).toMatch(/try again/i);
    expect(createCalls).toHaveLength(0);
    expect(payments.map((p) => p.status)).toEqual(["FAILED"]);

    const second = await press();
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: "created", qr: "000201QR" });
    expect(createCalls).toEqual([second.body.orderId]);
    expect(payments.map((p) => p.status)).toEqual(["FAILED", "PENDING"]);
  });

  it("keeps working however many times the gateway is down", async () => {
    tokenAnswers = [connectTimeout(), connectTimeout(), connectTimeout(), tokenBody];
    createAnswers = [qrBody];
    for (let i = 0; i < 3; i++) expect((await press()).status).toBe(502);
    expect((await press()).status).toBe(200);
    expect(createCalls).toHaveLength(1);
  });
});

describe("the request to create a QR was sent and no answer came back", () => {
  beforeEach(() => {
    tokenAnswers = [tokenBody];
    createAnswers = [connectTimeout()];
  });

  it("keeps the row and sends no second create while CB may hold a QR", async () => {
    const first = await press();
    expect(first.status).toBe(502);
    expect(first.body.message).toMatch(/in about 22 minutes/);
    const ref = payments[0].ref;
    expect(payments.map((p) => p.status)).toEqual(["PENDING"]);

    createAnswers = [qrBody]; // CB is back. A create now could double charge, so none may go out.
    const second = await press();
    expect(second.status).toBe(409);
    expect(second.body.status).toBe("qr_active");
    expect(second.body.message).toMatch(/minutes/);
    expect(second.body.message).not.toMatch(/still active|Scan it/);
    expect(createCalls).toEqual([ref]);
    expect(payments.map((p) => p.status)).toEqual(["PENDING"]);
  });

  it("replaces the row under a new reference only once the window has passed", async () => {
    await press();
    const oldRef = payments[0].ref;
    payments[0].createdAtMs = Date.now() - 23 * 60_000;

    createAnswers = [qrBody];
    const later = await press();
    expect(later.status).toBe(200);
    expect(later.body.orderId).not.toBe(oldRef);
    expect(createCalls).toEqual([oldRef, later.body.orderId]);
    expect(payments.map((p) => p.status)).toEqual(["FAILED", "PENDING"]);
  });
});
