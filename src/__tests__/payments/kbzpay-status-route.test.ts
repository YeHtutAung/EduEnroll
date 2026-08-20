import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── GET /api/public/payments/kbzpay/status ─────────────────────────────────
// Spec §5.3. The poller is a genuine recovery path for a missed callback, not
// a read-only display: it settles on PAY_SUCCESS like the webhook does.
//
// The response shape is dictated by QRPaymentModal, which reads
// data.mmqr_status — see startPolling() in that component.

type Row = Record<string, unknown>;

let payment: Row | null;
let queryResult: Row;
let settleResult: Row;

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

const { GET } = await import("@/app/api/public/payments/kbzpay/status/route");

const REF = "KBZ_1a2b3c4d_9f3c7b21d0e4a856";

const req = (ref: string | null = REF) =>
  new NextRequest(
    `https://t.kuunyi.com/api/public/payments/kbzpay/status${ref ? `?ref=${ref}` : ""}`,
  );

const body = async (res: Response) => JSON.parse(await res.text());

beforeEach(() => {
  vi.clearAllMocks();
  payment = {
    id: "pay-1",
    enrollment_id: "enr-1",
    mmqr_status: "PENDING",
    status: "awaiting_payment",
  };
  queryResult = {
    ok: true,
    tradeStatus: "WAIT_PAY",
    totalAmount: "40000",
    transCurrency: "MMK",
  };
  settleResult = { kind: "settled", paymentId: "pay-1", enrollmentId: "enr-1" };

  mockQueryOrder.mockImplementation(async () => queryResult);
  mockSettle.mockImplementation(async () => settleResult);
  mockFrom.mockImplementation(() => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: payment, error: null }) }),
    }),
  }));
});

describe("request handling", () => {
  it("returns 400 without a ref", async () => {
    expect((await GET(req(null))).status).toBe(400);
  });

  it("reports PENDING for an unknown ref rather than erroring the modal", async () => {
    payment = null;
    expect(await body(await GET(req()))).toEqual({ mmqr_status: "PENDING" });
  });
});

describe("local short-circuit", () => {
  it("returns SUCCESS without calling KBZPay when already verified locally", async () => {
    payment = { ...payment, status: "verified", mmqr_status: "SUCCESS" };

    expect(await body(await GET(req()))).toEqual({ mmqr_status: "SUCCESS" });
    expect(mockQueryOrder).not.toHaveBeenCalled();
  });

  it("returns FAILED without calling KBZPay when already failed locally", async () => {
    payment = { ...payment, mmqr_status: "FAILED" };

    expect(await body(await GET(req()))).toEqual({ mmqr_status: "FAILED" });
    expect(mockQueryOrder).not.toHaveBeenCalled();
  });
});

describe("provider status mapping", () => {
  it.each([
    ["PAY_SUCCESS", "SUCCESS"],
    ["WAIT_PAY", "PENDING"],
    ["PAYING", "PENDING"],
    ["PAY_FAILED", "FAILED"],
    ["ORDER_EXPIRED", "EXPIRED"],
    ["ORDER_CLOSED", "EXPIRED"],
  ])("maps %s to %s", async (tradeStatus, expected) => {
    queryResult = { ...queryResult, tradeStatus };
    expect(await body(await GET(req()))).toEqual({ mmqr_status: expected });
  });

  it("reports PENDING when the provider is unreachable, so polling continues", async () => {
    queryResult = { ok: false };
    expect(await body(await GET(req()))).toEqual({ mmqr_status: "PENDING" });
  });

  it("reports PENDING when the provider has no such order yet", async () => {
    queryResult = { ok: true, tradeStatus: "ORDER_NOT_FOUND" };
    expect(await body(await GET(req()))).toEqual({ mmqr_status: "PENDING" });
  });
});

describe("missed-callback self-healing (§5.3)", () => {
  it("settles on PAY_SUCCESS", async () => {
    queryResult = { ...queryResult, tradeStatus: "PAY_SUCCESS" };

    await GET(req());

    expect(mockSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentRef: REF,
        observedAmount: 40000,
        observedCurrency: "MMK",
        source: "status",
      }),
    );
  });

  it.each(["WAIT_PAY", "PAYING", "PAY_FAILED", "ORDER_EXPIRED"])(
    "does not settle for %s",
    async (tradeStatus) => {
      queryResult = { ...queryResult, tradeStatus };
      await GET(req());
      expect(mockSettle).not.toHaveBeenCalled();
    },
  );

  // The money arrived but our own guards refused it. Reporting SUCCESS would
  // tell the student they are enrolled when an operator has to intervene.
  it.each(["amount_mismatch", "currency_mismatch"])(
    "does not report SUCCESS when settlement returns %s",
    async (kind) => {
      queryResult = { ...queryResult, tradeStatus: "PAY_SUCCESS" };
      settleResult = { kind };

      expect(await body(await GET(req()))).toEqual({ mmqr_status: "PENDING" });
    },
  );

  it("reports SUCCESS for already_settled", async () => {
    queryResult = { ...queryResult, tradeStatus: "PAY_SUCCESS" };
    settleResult = { kind: "already_settled", paymentId: "pay-1", enrollmentId: "enr-1" };

    expect(await body(await GET(req()))).toEqual({ mmqr_status: "SUCCESS" });
  });
});
