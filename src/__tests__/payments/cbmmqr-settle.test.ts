import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mockRpc }) }));
const mockSettle = vi.fn();
vi.mock("@/server/payments/settleMmqrPayment", () => ({
  settleMmqrPayment: (...a: unknown[]) => mockSettle(...a),
}));

const { settleCbmmqrPayment } = await import("@/server/payments/settleCbmmqrPayment");

const MERCHANT = {
  id: "YOUNGMONEY", userId: "u", password: "p", sourceId: "s", merchantId: "M0001",
  terminalId: "T0001", apiKey: "k"
};
const PAYMENT = { payment_ref: "CBAAAAAAAAAAAAAAAAAAAAAAA", payment_method: "cb_mmqr", cbmmqr_merchant: "YOUNGMONEY" };
const PAID = {
  kind: "answer" as const, code: "0000", referenceNo: PAYMENT.payment_ref, qrReferenceNo: "QR-1",
  transactionId: "TXN-1", currency: "MMK" as const, amount: 40000, merchantId: "M0001", institutionName: "Wave Money",
};
const run = (over: { status?: object; payment?: object } = {}) =>
  settleCbmmqrPayment({
    payment: { ...PAYMENT, ...(over.payment ?? {}) },
    merchant: MERCHANT,
    status: { ...PAID, ...(over.status ?? {}) } as never,
    source: "callback",
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc.mockResolvedValue({ data: "bound", error: null });
  mockSettle.mockResolvedValue({ kind: "settled", paymentId: "p", enrollmentId: "e" });
});

describe("settleCbmmqrPayment", () => {
  it("binds, then settles with the status response's values", async () => {
    expect(await run()).toEqual({ kind: "settled" });
    expect(mockRpc).toHaveBeenCalledWith("bind_cbmmqr_settlement", {
      p_payment_ref: PAYMENT.payment_ref, p_qr_reference_no: "QR-1", p_transaction_id: "TXN-1", p_merchant: "YOUNGMONEY",
    });
    expect(mockSettle).toHaveBeenCalledWith({
      paymentRef: PAYMENT.payment_ref, observedAmount: 40000, observedCurrency: "MMK",
      mmOrderId: "TXN-1", walletIdentifier: "Wave Money", source: "callback",
    });
  });

  it("passes already_settled through", async () => {
    mockSettle.mockResolvedValue({ kind: "already_settled", paymentId: "p", enrollmentId: "e" });
    expect(await run()).toEqual({ kind: "already_settled" });
  });

  it.each([
    ["not a CB payment", { payment: { payment_method: "kbzpay_mmqr" } }],
    ["a payment pinned to another merchant", { payment: { cbmmqr_merchant: "OTHER" } }],
    ["a pending code", { status: { code: "0006" } }],
    ["an unreachable status", { status: { kind: "unreachable" } }],
    ["another reference", { status: { referenceNo: "CBBBBBBBBBBBBBBBBBBBBBBBB" } }],
    ["a missing reference", { status: { referenceNo: undefined } }],
    ["another merchant id", { status: { merchantId: "M0002" } }],
    ["a currency other than 104", { status: { currency: null } }],
    ["a fractional amount", { status: { amount: 40000.5 } }],
    ["no amount", { status: { amount: null } }],
    ["no transaction id", { status: { transactionId: undefined } }],
    ["no QR reference", { status: { qrReferenceNo: undefined } }],
  ])("refuses %s without binding or settling", async (_n, over) => {
    expect((await run(over)).kind).toBe("refused");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it.each(["mismatch", "duplicate_transaction", "duplicate_order_ref", "not_found"])("refuses when the bind returns %s", async (r) => {
    mockRpc.mockResolvedValue({ data: r, error: null });
    expect(await run()).toEqual({ kind: "refused", reason: `bind ${r}` });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("is retryable when the bind RPC errors", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    expect((await run()).kind).toBe("retryable");
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it.each([
    ["amount_mismatch", "refused"], ["currency_mismatch", "refused"],
    ["not_found", "retryable"], ["retryable", "retryable"],
  ])("maps settleMmqrPayment's %s to %s", async (kind, expected) => {
    mockSettle.mockResolvedValue({ kind, reason: "x" });
    expect((await run()).kind).toBe(expected);
  });
});
