import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ─── POST /api/webhooks/kbzmmqr ─────────────────────────────────────────────
// Spec §5.2 and the §8 callback table.
//
// verifySign is deliberately NOT mocked — these prove the handler actually
// verifies, so a future change cannot bypass the verifier while the pure
// signature tests stay green. Only queryOrder and settlement are stubbed.

const APP_KEY = "testkey0123456789abcdef";
process.env.KBZPAY_BRAVE_APPID = "kptest0000000000000000000000000000";
process.env.KBZPAY_BRAVE_MERCH_CODE = "70000000001";
process.env.KBZPAY_BRAVE_APP_KEY = APP_KEY;
process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "https://brave.kuunyi.com";

// A second, fully configured merchant: its key is valid, just not for Brave's orders.
const SKYFEST_KEY = "skyfestkey0123456789abcd";
process.env.KBZPAY_SKYFEST_APPID = "kpsky00000000000000000000000000000";
process.env.KBZPAY_SKYFEST_MERCH_CODE = "70000000002";
process.env.KBZPAY_SKYFEST_APP_KEY = SKYFEST_KEY;
process.env.KBZPAY_SKYFEST_NOTIFY_ORIGIN = "https://skyfest.kuunyi.com";

type Row = Record<string, unknown>;

let payment: Row | null;
let lookupError: { message: string } | null;
let queryResult: Row;
let settleResult: Row;
let eqCalls: [string, unknown][];

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mockFrom }),
}));

const mockQueryOrder = vi.fn();
vi.mock("@/lib/kbzpay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kbzpay")>();
  return { ...actual, queryOrder: (...a: unknown[]) => mockQueryOrder(...a) };
});

const mockSettle = vi.fn();
vi.mock("@/server/payments/settleMmqrPayment", () => ({
  settleMmqrPayment: (...a: unknown[]) => mockSettle(...a),
}));

const { POST } = await import("@/app/api/webhooks/kbzmmqr/route");
const { sign } = await import("@/lib/kbzpay");

const REF = "KBZ_1a2b3c4d_9f3c7b21d0e4a856";

const callbackFields = {
  appid: "kptest0000000000000000000000000000",
  notify_time: "1747630008",
  merch_code: "70000000001",
  merch_order_id: REF,
  mm_order_id: "01003791060036848066",
  total_amount: "40000",
  trans_currency: "MMK",
  trade_status: "PAY_SUCCESS",
  trans_end_time: "1747630007",
  nonce_str: "Xi3G7YmxeTlkBgNkk4TM5ex0eM7VglNn",
  Wallet_identifier: "MCB",
  mmqr_ref: "17476300015769717452",
  sign_type: "SHA256",
};

function signedRequest(over: Record<string, unknown> = {}, key = APP_KEY) {
  const fields = { ...callbackFields, ...over };
  const payload = { Request: { ...fields, sign: sign(fields, key) } };
  return new NextRequest("https://www.kuunyi.com/api/webhooks/kbzmmqr", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  payment = { id: "pay-1", enrollment_id: "enr-1", status: "awaiting_payment", amount: 40000, kbzpay_merchant: "BRAVE" };
  queryResult = {
    ok: true,
    tradeStatus: "PAY_SUCCESS",
    totalAmount: "40000",
    transCurrency: "MMK",
    mmOrderId: "01003791060036848066",
    walletIdentifier: "MCB",
  };
  settleResult = { kind: "settled", paymentId: "pay-1", enrollmentId: "enr-1" };

  mockQueryOrder.mockImplementation(async () => queryResult);
  mockSettle.mockImplementation(async () => settleResult);
  eqCalls = [];
  lookupError = null;
  mockFrom.mockImplementation(() => ({
    select: () => ({
      eq: (c1: string, v1: unknown) => ({
        eq: (c2: string, v2: unknown) => {
          eqCalls.push([c1, v1], [c2, v2]);
          return { maybeSingle: async () => ({ data: payment, error: lookupError }) };
        },
      }),
    }),
  }));
});

describe("signature verification", () => {
  it("returns 403 and does not settle when the signature is invalid", async () => {
    const res = await POST(signedRequest({}, "wrongkey"));

    expect(res.status).toBe(403);
    expect(mockSettle).not.toHaveBeenCalled();
    expect(mockQueryOrder).not.toHaveBeenCalled();
  });

  it("returns 403 when the signature is absent", async () => {
    const req = new NextRequest("https://www.kuunyi.com/api/webhooks/kbzmmqr", {
      method: "POST",
      body: JSON.stringify({ Request: callbackFields }),
      headers: { "Content-Type": "application/json" },
    });

    expect((await POST(req)).status).toBe(403);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("returns 403 when the amount was tampered with after signing", async () => {
    const signed = { ...callbackFields, sign: sign(callbackFields, APP_KEY) };
    const req = new NextRequest("https://www.kuunyi.com/api/webhooks/kbzmmqr", {
      method: "POST",
      body: JSON.stringify({ Request: { ...signed, total_amount: "1" } }),
      headers: { "Content-Type": "application/json" },
    });

    expect((await POST(req)).status).toBe(403);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  // The docs warn that KBZPay may add fields; a hardcoded list would reject
  // every real callback the day they do.
  it("accepts a callback carrying an unknown extension field", async () => {
    const res = await POST(signedRequest({ some_future_field: "whatever" }));
    expect(res.status).toBe(200);
  });

  it("returns 400 for a malformed body", async () => {
    const req = new NextRequest("https://www.kuunyi.com/api/webhooks/kbzmmqr", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    expect((await POST(req)).status).toBe(400);
  });
});

// The budget is applied only where a function cap exists. VERCEL is set on
// every Vercel runtime and unset locally, which is the distinction that
// decides whether clamping helps or hurts.
describe("request budget is platform-aware", () => {
  const original = process.env.VERCEL;
  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = original;
  });

  it("bounds the gateway call when running on Vercel", async () => {
    process.env.VERCEL = "1";
    mockQueryOrder.mockClear();

    await POST(signedRequest());

    expect(mockQueryOrder.mock.calls[0][2]).toMatchObject({ deadlineMs: expect.any(Number) });
  });
});

describe("server-side confirmation (§7)", () => {
  // A valid signature says the message is authentic, not that money arrived.
  // Only KBZPay's own query response may decide settlement.
  it("confirms via queryOrder before settling", async () => {
    await POST(signedRequest());

    expect(mockQueryOrder.mock.calls[0][1]).toBe(REF);

    // No budget off-platform. The budget exists only to respect a serverless
    // function cap; applying it locally aborted a legitimate ~9.5s cold
    // connection and broke UAT until that was measured.
    expect(mockQueryOrder.mock.calls[0][2]).toBeUndefined();
    expect(mockQueryOrder.mock.invocationCallOrder[0]).toBeLessThan(
      mockSettle.mock.invocationCallOrder[0],
    );
  });

  it("settles from the QUERY values, not the callback body", async () => {
    // Callback claims 999999; the authoritative query says 40000.
    await POST(signedRequest({ total_amount: "999999" }));

    expect(mockSettle).toHaveBeenCalledWith(
      expect.objectContaining({ observedAmount: 40000, observedCurrency: "MMK" }),
    );
  });

  it("returns 500 when queryOrder is unreachable", async () => {
    queryResult = { ok: false };
    const res = await POST(signedRequest());

    expect(res.status).toBe(500);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it.each(["WAIT_PAY", "PAYING", "ORDER_EXPIRED", "PAY_FAILED"])(
    "returns 500 without settling when the query reports %s",
    async (tradeStatus) => {
      queryResult = { ok: true, tradeStatus };
      const res = await POST(signedRequest());

      expect(res.status).toBe(500);
      expect(mockSettle).not.toHaveBeenCalled();
    },
  );
});

describe("callback response contract", () => {
  it("returns the LITERAL body 'success' on settlement", async () => {
    const res = await POST(signedRequest());

    expect(res.status).toBe(200);
    // Not JSON. Anything other than this string makes KBZPay retry.
    expect(await res.text()).toBe("success");
  });

  it("returns 'success' on a duplicate callback without re-notifying", async () => {
    settleResult = { kind: "already_settled", paymentId: "pay-1", enrollmentId: "enr-1" };
    const res = await POST(signedRequest());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
  });

  it("returns 404 for an unknown payment_ref so KBZPay retries", async () => {
    payment = null;
    const res = await POST(signedRequest());

    expect(res.status).toBe(404);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  // Retrying sends the identical amount, so a retry can never reconcile it.
  it.each(["amount_mismatch", "currency_mismatch"])(
    "returns 200 'success' on %s, since a retry cannot fix it",
    async (kind) => {
      settleResult = { kind };
      const res = await POST(signedRequest());

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("success");
    },
  );

  it("returns 500 when fulfilment fails after settlement", async () => {
    settleResult = { kind: "retryable", reason: "ticket store down" };
    const res = await POST(signedRequest());

    expect(res.status).toBe(500);
  });

  it("returns 500 when settlement reports not_found", async () => {
    settleResult = { kind: "not_found" };
    expect((await POST(signedRequest())).status).toBe(500);
  });
});

describe("per-merchant verification", () => {
  it("rejects a callback validly signed with ANOTHER merchant's key", async () => {
    const res = await POST(signedRequest({}, SKYFEST_KEY));
    expect(res.status).toBe(403);
    expect(mockQueryOrder).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed callback whose merch_code is not the pinned merchant's", async () => {
    const res = await POST(signedRequest({ merch_code: "70000000002" }));
    expect(res.status).toBe(403);
    expect(mockQueryOrder).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  // Every field is coherent for SKYFEST (key, merch_code, appid), but the row
  // is pinned to BRAVE: a whole other merchant's identity must still be refused.
  it("rejects a fully coherent callback from ANOTHER merchant against a BRAVE-pinned row", async () => {
    const res = await POST(
      signedRequest(
        { merch_code: "70000000002", appid: "kpsky00000000000000000000000000000" },
        SKYFEST_KEY,
      ),
    );
    expect(res.status).toBe(403);
    expect(mockQueryOrder).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("verifies with the pinned merchant, not the tenant's current assignment", async () => {
    payment = { ...payment!, kbzpay_merchant: "SKYFEST" };
    const res = await POST(signedRequest({ merch_code: "70000000002" }, SKYFEST_KEY));
    expect(res.status).toBe(200);
    expect(mockQueryOrder.mock.calls[0][0]).toEqual(expect.objectContaining({ id: "SKYFEST" }));
  });

  it("looks up KBZPay rows only", async () => {
    await POST(signedRequest());
    expect(eqCalls).toContainEqual(["payment_method", "kbzpay_mmqr"]);
    expect(eqCalls).toContainEqual(["payment_ref", REF]);
  });

  it("returns 404 for an unknown ref, so KBZPay retries a creation race", async () => {
    payment = null;
    expect((await POST(signedRequest())).status).toBe(404);
  });

  it("returns 500, not 403, when the pinned merchant is misconfigured", async () => {
    payment = { ...payment!, kbzpay_merchant: "NOPE" };
    const res = await POST(signedRequest());
    expect(res.status).toBe(500);
    expect(mockSettle).not.toHaveBeenCalled();
  });
});

describe("callback ref and lookup failures", () => {
  // The lookup runs before authentication, so an unauthenticated caller
  // controls the ref: bound it before it reaches the DB or a log line.
  it.each([
    ["contains CR/LF", "KBZ_1a2b3c4d_9f3c\r\nforged log line"],
    ["is 65 characters long", "K".repeat(65)],
  ])("returns 400 without a DB call when the ref %s", async (_label, ref) => {
    const res = await POST(signedRequest({ merch_order_id: ref }));

    expect(res.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockQueryOrder).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  // A DB failure is not "no such payment": 404 would hide an outage as a race.
  it("returns 500 so KBZPay retries when the payment lookup fails", async () => {
    payment = null;
    lookupError = { message: "boom" };
    const res = await POST(signedRequest());

    expect(res.status).toBe(500);
    expect(mockQueryOrder).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });
});
