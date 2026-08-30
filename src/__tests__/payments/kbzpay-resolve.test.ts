import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── resolveKbzpayOrder ─────────────────────────────────────────────────────
// Spec §5.1 step 7. Every one of the design's wrong-statement findings lived in
// this procedure, so it is tested exhaustively as a function rather than
// through a route handler.
//
// The governing invariant: no terminal transition and no order-slot release
// without a queryorder ANSWER. Not a local clock (R8), not a cached QR (R9),
// not a closeorder return code (R12), not a failed outbound request (R13).

const mockQueryOrder = vi.fn();
const mockCloseOrder = vi.fn();
vi.mock("@/lib/kbzpay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kbzpay")>();
  return {
    ...actual,
    queryOrder: (...a: unknown[]) => mockQueryOrder(...a),
    closeOrder: (...a: unknown[]) => mockCloseOrder(...a),
  };
});

const mockSettle = vi.fn();
vi.mock("@/server/payments/settleMmqrPayment", () => ({
  settleMmqrPayment: (...a: unknown[]) => mockSettle(...a),
}));

const { resolveKbzpayOrder } = await import("@/server/payments/resolveKbzpayOrder");

const OLD_REF = "KBZ_1a2b3c4d_9f3c7b21d0e4a856";

const paid = {
  ok: true,
  tradeStatus: "PAY_SUCCESS",
  totalAmount: "40000",
  transCurrency: "MMK",
  mmOrderId: "01003791060036848066",
  walletIdentifier: "MCB",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSettle.mockResolvedValue({ kind: "settled", paymentId: "p1", enrollmentId: "e1" });
});

const resolve = () => resolveKbzpayOrder({ oldRef: OLD_REF, source: "create" });

describe("first query says the order is paid", () => {
  it("settles and reports already_paid, without closing anything", async () => {
    mockQueryOrder.mockResolvedValue(paid);

    const r = await resolve();

    expect(r).toEqual({ kind: "already_paid" });
    expect(mockCloseOrder).not.toHaveBeenCalled();
    expect(mockSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentRef: OLD_REF,
        observedAmount: 40000,
        observedCurrency: "MMK",
        mmOrderId: "01003791060036848066",
        walletIdentifier: "MCB",
      }),
    );
  });

  it("reports already_paid when settlement says already_settled too", async () => {
    mockQueryOrder.mockResolvedValue(paid);
    mockSettle.mockResolvedValue({ kind: "already_settled", paymentId: "p1", enrollmentId: "e1" });

    expect(await resolve()).toEqual({ kind: "already_paid" });
  });

  it("surfaces a settlement conflict rather than issuing a replacement", async () => {
    mockQueryOrder.mockResolvedValue(paid);
    mockSettle.mockResolvedValue({ kind: "amount_mismatch" });

    expect(await resolve()).toEqual({ kind: "settlement_conflict", reason: "amount_mismatch" });
    expect(mockCloseOrder).not.toHaveBeenCalled();
  });
});

describe("provider-confirmed dead orders", () => {
  // R13: 'the order does not exist' is the ONLY answer that may mark a row
  // FAILED. A failed precreate call proves nothing about KBZPay's state.
  it("reports reason FAILED when the provider has no such order", async () => {
    mockQueryOrder.mockResolvedValue({ ok: true, tradeStatus: "ORDER_NOT_FOUND" });

    expect(await resolve()).toEqual({ kind: "retire", reason: "FAILED" });
    expect(mockCloseOrder).not.toHaveBeenCalled();
  });

  it.each(["ORDER_EXPIRED", "ORDER_CLOSED", "PAY_FAILED"])(
    "reports reason EXPIRED for terminal unpaid status %s",
    async (tradeStatus) => {
      mockQueryOrder.mockResolvedValue({ ok: true, tradeStatus });

      expect(await resolve()).toEqual({ kind: "retire", reason: "EXPIRED" });
      expect(mockCloseOrder).not.toHaveBeenCalled();
    },
  );
});

describe("still payable → close, then re-query (R12)", () => {
  it.each(["WAIT_PAY", "PAYING"])("closes and RE-QUERIES when status is %s", async (tradeStatus) => {
    mockQueryOrder
      .mockResolvedValueOnce({ ok: true, tradeStatus })
      .mockResolvedValueOnce({ ok: true, tradeStatus: "ORDER_CLOSED" });
    mockCloseOrder.mockResolvedValue({ ok: true });

    expect(await resolve()).toEqual({ kind: "retire", reason: "SUPERSEDED" });

    expect(mockCloseOrder).toHaveBeenCalledWith(OLD_REF);
    // The re-query is the whole point: the close return code is not evidence.
    expect(mockQueryOrder).toHaveBeenCalledTimes(2);
  });

  // The race R12 exists for: the payer completes payment between our status
  // query and our close call. Superseding here re-opens R5's over-collection.
  it("settles instead of superseding when the re-query says PAY_SUCCESS", async () => {
    mockQueryOrder
      .mockResolvedValueOnce({ ok: true, tradeStatus: "WAIT_PAY" })
      .mockResolvedValueOnce(paid);
    mockCloseOrder.mockResolvedValue({ ok: true });

    expect(await resolve()).toEqual({ kind: "already_paid" });
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the re-query still reports the order payable", async () => {
    mockQueryOrder
      .mockResolvedValueOnce({ ok: true, tradeStatus: "WAIT_PAY" })
      .mockResolvedValueOnce({ ok: true, tradeStatus: "WAIT_PAY" });
    mockCloseOrder.mockResolvedValue({ ok: true });

    const r = await resolve();
    expect(r.kind).toBe("blocked");
    expect(mockSettle).not.toHaveBeenCalled();
  });

  // closeOrder returning ok:true means only that the call did not error.
  it("never treats a closeOrder return code as proof of retirement", async () => {
    mockQueryOrder
      .mockResolvedValueOnce({ ok: true, tradeStatus: "WAIT_PAY" })
      .mockResolvedValueOnce({ ok: true, tradeStatus: "PAYING" });
    mockCloseOrder.mockResolvedValue({ ok: true });

    // Close said "fine". The provider says it is still payable. Provider wins.
    expect((await resolve()).kind).toBe("blocked");
  });

  it("fails closed and does not re-query when closeOrder genuinely errors", async () => {
    mockQueryOrder.mockResolvedValueOnce({ ok: true, tradeStatus: "WAIT_PAY" });
    mockCloseOrder.mockResolvedValue({ ok: false });

    expect((await resolve()).kind).toBe("blocked");
    expect(mockQueryOrder).toHaveBeenCalledTimes(1);
  });
});

describe("unusable provider answers", () => {
  it("fails closed when the first query is unreachable", async () => {
    mockQueryOrder.mockResolvedValue({ ok: false });

    expect((await resolve()).kind).toBe("blocked");
    expect(mockCloseOrder).not.toHaveBeenCalled();
  });

  it("fails closed when the re-query is unreachable", async () => {
    mockQueryOrder
      .mockResolvedValueOnce({ ok: true, tradeStatus: "WAIT_PAY" })
      .mockResolvedValueOnce({ ok: false });
    mockCloseOrder.mockResolvedValue({ ok: true });

    expect((await resolve()).kind).toBe("blocked");
  });

  // No local value may ever stand in for a provider answer.
  it("never returns retire without a provider answer saying so", async () => {
    mockQueryOrder.mockResolvedValue({ ok: false });
    const r = await resolve();
    expect(r.kind).not.toBe("retire");
  });
});

describe("retire reason depends on the stage", () => {
  // Before any close, an absent order means precreate never landed.
  it("uses FAILED for not-found on the initial query", async () => {
    mockQueryOrder.mockResolvedValue({ ok: true, tradeStatus: "ORDER_NOT_FOUND" });
    expect(await resolve()).toEqual({ kind: "retire", reason: "FAILED" });
  });

  // After a close WE performed, an absent order means we retired it.
  it("uses SUPERSEDED for not-found on the re-query", async () => {
    mockQueryOrder
      .mockResolvedValueOnce({ ok: true, tradeStatus: "WAIT_PAY" })
      .mockResolvedValueOnce({ ok: true, tradeStatus: "ORDER_NOT_FOUND" });
    mockCloseOrder.mockResolvedValue({ ok: true });

    expect(await resolve()).toEqual({ kind: "retire", reason: "SUPERSEDED" });
  });
});
