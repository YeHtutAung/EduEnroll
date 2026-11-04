import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Spec §5.3. The callback is a wake-up only: no callback field ever moves
// money. Settlement happens solely through our own status check.

Object.assign(process.env, {
  CBMMQR_YOUNGMONEY_USER_ID: "u", CBMMQR_YOUNGMONEY_PASSWORD: "p", CBMMQR_YOUNGMONEY_SOURCE_ID: "s",
  CBMMQR_YOUNGMONEY_MERCHANT_ID: "M0001", CBMMQR_YOUNGMONEY_TERMINAL_ID: "T0001",
  CBMMQR_YOUNGMONEY_API_KEY: "ym-api-key",
  CBMMQR_OTHER_USER_ID: "u2", CBMMQR_OTHER_PASSWORD: "p2", CBMMQR_OTHER_SOURCE_ID: "s2",
  CBMMQR_OTHER_MERCHANT_ID: "M0002", CBMMQR_OTHER_TERMINAL_ID: "T0002", CBMMQR_OTHER_API_KEY: "other-api-key",
  CBMMQR_NOKEY_USER_ID: "u3", CBMMQR_NOKEY_PASSWORD: "p3", CBMMQR_NOKEY_SOURCE_ID: "s3",
  CBMMQR_NOKEY_MERCHANT_ID: "M0003", CBMMQR_NOKEY_TERMINAL_ID: "T0003",
});

let payment: Record<string, unknown> | null;
let lookupError: { message: string } | null;
const mockFrom = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mockFrom }) }));
const mockStatus = vi.fn();
vi.mock("@/lib/cbmmqr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cbmmqr")>();
  return { ...actual, checkStatus: (...a: unknown[]) => mockStatus(...a) };
});
const mockSettle = vi.fn();
vi.mock("@/server/payments/settleCbmmqrPayment", () => ({
  settleCbmmqrPayment: (...a: unknown[]) => mockSettle(...a),
}));

const { POST } = await import("@/app/api/webhooks/cbmmqr/route");

const REF = "CBAAAAAAAAAAAAAAAAAAAAAAA";
const BODY = {
  apiKey: "ym-api-key", referenceNo: REF, transactionId: "TXN-1", transCurrency: "104", transAmount: 40000,
  transDateTime: "20261031 10:12:00", transStatusCode: "0000", transStatusDescription: "SUCCESS",
  qrReferenceNo: "QR-1", institutionId: "1111", institutionName: "Wave Money", merchantId: "M0001",
  remark: "", terminalId: "T0001",
};
const post = (body: unknown = BODY) =>
  POST(new NextRequest("https://beatsrun.kuunyi.com/api/webhooks/cbmmqr", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));
const PAID = { kind: "answer", code: "0000", referenceNo: REF, qrReferenceNo: "QR-1", currency: "MMK", amount: 40000 };

beforeEach(() => {
  vi.clearAllMocks();
  payment = {
    payment_ref: REF, payment_method: "cb_mmqr", cbmmqr_merchant: "YOUNGMONEY", status: "awaiting_payment",
    provider_order_ref: null,
  };
  lookupError = null;
  mockFrom.mockImplementation(() => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: payment, error: lookupError }) }) }) }),
  }));
  mockStatus.mockResolvedValue(PAID);
  mockSettle.mockResolvedValue({ kind: "settled" });
});

describe("POST /api/webhooks/cbmmqr", () => {
  it("settles via our status check and acknowledges with CB's reply shape", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ qrReferenceNo: "QR-1", returnCode: "0000", message: "Success" });
    expect(mockStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "YOUNGMONEY" }), "QR-1", undefined);
    expect(mockSettle).toHaveBeenCalledWith(expect.objectContaining({ status: PAID, source: "callback" }));
  });

  it("never passes a callback field to settlement — only the status response", async () => {
    await post({ ...BODY, transAmount: 1, transCurrency: "840" });
    expect(mockSettle.mock.calls[0][0].status).toBe(PAID);
  });

  it("passes settlement exactly the payment's identity fields", async () => {
    payment = { ...payment, provider_order_ref: "QR-1" };
    await post();
    expect(mockSettle.mock.calls[0][0].payment).toEqual({
      payment_ref: REF, payment_method: "cb_mmqr", cbmmqr_merchant: "YOUNGMONEY",
    });
  });

  it("accepts numeric transCurrency / transStatusCode and a string transAmount", async () => {
    const res = await post({ ...BODY, transCurrency: 104, transStatusCode: 0, transAmount: "40000" });
    expect(res.status).toBe(200);
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it("500 when the status check throws a configuration error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockStatus.mockRejectedValue(new Error("CBMMQR_MODE is set to an unrecognised value"));
    expect((await post()).status).toBe(500);
    expect(mockSettle).not.toHaveBeenCalled();
    expect(spy.mock.calls.some((c) => String(c[0]).includes(`[cbmmqr-webhook] config error for ${REF}`))).toBe(true);
    spy.mockRestore();
  });

  it("refuses (acknowledged, no settlement) when CB's answer names a different QR reference", async () => {
    mockStatus.mockResolvedValue({ ...PAID, qrReferenceNo: "QR-OTHER" });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ qrReferenceNo: "QR-1", returnCode: "0000", message: "Success" });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{nope"],
    ["a non-object", "[]"],
    ["a bad referenceNo", { ...BODY, referenceNo: "KBZ_x" }],
    ["an over-long qrReferenceNo", { ...BODY, qrReferenceNo: "Q".repeat(26) }],
    ["a missing transStatusDescription", { ...BODY, transStatusDescription: undefined }],
    ["a body over 8 KB", { ...BODY, remark: "x".repeat(9000) }],
  ])("400 for %s, before any lookup", async (_n, body) => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post(body)).status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // CB's real callback was refused on production: three POSTs per payment, all 400.
  // No field outside the three required ones is read, so none may refuse a callback.
  it.each([
    ["CB's long date format", { transDateTime: "2026-11-04T17:35:48.872855694" }],
    ["an over-long transactionId", { transactionId: "T".repeat(36) }],
    ["a non-string merchantId", { merchantId: { x: 1 } }],
    ["a numeric merchantId", { merchantId: 223780222946190 }],
    ["an over-long terminalId", { terminalId: "T".repeat(9) }],
    ["a non-numeric transAmount", { transAmount: "lots" }],
    ["a negative transAmount", { transAmount: -1 }],
    ["an over-long institutionName", { institutionName: "I".repeat(151) }],
    ["a field we have never seen", { somethingNew: [1, 2] }],
  ])("settles through the status check despite %s", async (_n, extra) => {
    const res = await post({ ...BODY, ...extra });
    expect(res.status).toBe(200);
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(mockSettle.mock.calls[0][0].status).toBe(PAID);
  });

  it("does not reject on the shape of apiKey: a configured key still gets 403", async () => {
    expect((await post({ ...BODY, apiKey: 123 })).status).toBe(403);
    expect((await post({ ...BODY, apiKey: "k".repeat(151) })).status).toBe(403);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  describe("logging a rejected callback", () => {
    const warned = async (body: unknown) => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect((await post(body)).status).toBe(400);
      const lines = spy.mock.calls.map((c) => c.join(" "));
      spy.mockRestore();
      return lines.join("\n");
    };

    it("names the field, its type and length, and the body's field names", async () => {
      const line = await warned({ ...BODY, referenceNo: "NOT-OUR-FORMAT" });
      expect(line).toContain("[cbmmqr-webhook] rejected");
      expect(line).toContain("field=referenceNo type=string length=14");
      expect(line).toContain("transStatusDescription");
    });

    it("reports a missing field as absent", async () => {
      expect(await warned({ ...BODY, qrReferenceNo: undefined })).toContain("field=qrReferenceNo type=undefined");
    });

    it("never logs a value", async () => {
      const line = await warned({
        ...BODY, referenceNo: "SECRET-REF-VALUE", apiKey: "SECRET-KEY-VALUE", remark: "SECRET-REMARK-VALUE",
      });
      expect(line).not.toContain("SECRET");
    });

    it("drops field names that are not plain identifiers, and caps the list", async () => {
      const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, 1]));
      const line = await warned({ referenceNo: "x", "bad name\nFAKE LOG LINE": 1, ...many });
      expect(line).not.toContain("FAKE LOG LINE");
      expect(line).not.toContain("f59");
    });

    it("says why when the body is not JSON or not an object", async () => {
      expect(await warned("{nope")).toContain("not JSON");
      expect(await warned("[]")).toContain("not an object");
    });

    it("says why when the body is too large", async () => {
      expect(await warned({ ...BODY, remark: "x".repeat(9000) })).toContain("too large");
    });
  });

  it("404 for an unknown reference; 500 when the lookup fails", async () => {
    payment = null;
    expect((await post()).status).toBe(404);
    lookupError = { message: "down" };
    expect((await post()).status).toBe(500);
  });

  it("403 for a wrong key — including another merchant's valid key", async () => {
    expect((await post({ ...BODY, apiKey: "wrong" })).status).toBe(403);
    expect((await post({ ...BODY, apiKey: "other-api-key" })).status).toBe(403);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["null", null],
    ["absent", undefined],
  ])("403 for an %s key when the merchant has a key configured", async (_n, apiKey) => {
    expect((await post({ ...BODY, apiKey })).status).toBe(403);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  // CB, 2026-11-03: the gateway does not use apiKey and it may be null or empty.
  describe("a merchant with no key configured", () => {
    beforeEach(() => {
      payment = { ...payment, cbmmqr_merchant: "NOKEY" };
    });

    it.each([
      ["empty", ""],
      ["null", null],
      ["absent", undefined],
      ["any string", "anything"],
    ])("accepts a callback whose key is %s, and still settles only through the status check", async (_n, apiKey) => {
      const res = await post({ ...BODY, apiKey });
      expect(res.status).toBe(200);
      expect(mockStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "NOKEY" }), "QR-1", undefined);
      expect(mockSettle).toHaveBeenCalledTimes(1);
    });

    it("does not settle when the status check says it is not paid", async () => {
      mockStatus.mockResolvedValue({ ...PAID, code: "0006" });
      expect((await post({ ...BODY, apiKey: "" })).status).toBe(500);
      expect(mockSettle).not.toHaveBeenCalled();
    });

    it("does not settle when the status check answers about another QR", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockStatus.mockResolvedValue({ ...PAID, qrReferenceNo: "QR-OTHER" });
      expect((await post({ ...BODY, apiKey: "" })).status).toBe(200);
      expect(mockSettle).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("still refuses a QR reference that is not the stored one, without calling CB", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      payment = { ...payment, provider_order_ref: "QR-STORED" };
      expect((await post({ ...BODY, apiKey: "" })).status).toBe(403);
      expect(mockStatus).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("still answers 404 for an unknown reference", async () => {
      payment = null;
      expect((await post({ ...BODY, apiKey: "" })).status).toBe(404);
      expect(mockStatus).not.toHaveBeenCalled();
    });

    it("still acknowledges FAIL without changing anything", async () => {
      expect((await post({ ...BODY, apiKey: "", transStatusDescription: "FAIL" })).status).toBe(200);
      expect(mockStatus).not.toHaveBeenCalled();
      expect(mockSettle).not.toHaveBeenCalled();
    });
  });

  it("403 without calling CB when the callback's QR reference is not the stored one", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    payment = { ...payment, provider_order_ref: "QR-STORED" };
    expect((await post()).status).toBe(403);
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("QR-STORED"));
    expect(line).toContain("YOUNGMONEY");
    expect(line).not.toContain("ym-api-key");
    spy.mockRestore();
  });

  it("403 for a different stored reference even when the description is FAIL", async () => {
    payment = { ...payment, provider_order_ref: "QR-STORED" };
    expect((await post({ ...BODY, transStatusDescription: "FAIL" })).status).toBe(403);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("queries CB with the stored QR reference when there is one", async () => {
    payment = { ...payment, provider_order_ref: "QR-1" };
    const res = await post();
    expect(res.status).toBe(200);
    expect(mockStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "YOUNGMONEY" }), "QR-1", undefined);
    expect(await res.json()).toEqual({ qrReferenceNo: "QR-1", returnCode: "0000", message: "Success" });
  });

  it("queries CB with the callback's QR reference only when none is stored", async () => {
    payment = { ...payment, provider_order_ref: null };
    await post({ ...BODY, qrReferenceNo: "QR-LOST" });
    expect(mockStatus).toHaveBeenCalledWith(expect.objectContaining({ id: "YOUNGMONEY" }), "QR-LOST", undefined);
  });

  it("500 when the pinned merchant has no config", async () => {
    payment = { ...payment, cbmmqr_merchant: "NOCONFIG" };
    expect((await post()).status).toBe(500);
  });

  it("FAIL is acknowledged and changes nothing", async () => {
    const res = await post({ ...BODY, transStatusDescription: "FAIL" });
    expect(res.status).toBe(200);
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("500 when the status check is unreachable or does not show success", async () => {
    mockStatus.mockResolvedValue({ kind: "unreachable" });
    expect((await post()).status).toBe(500);
    mockStatus.mockResolvedValue({ kind: "answer", code: "0006", currency: null, amount: null });
    expect((await post()).status).toBe(500);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it("refused settlement is acknowledged (retrying cannot change it); retryable is 500", async () => {
    mockSettle.mockResolvedValue({ kind: "refused", reason: "x" });
    expect((await post()).status).toBe(200);
    mockSettle.mockResolvedValue({ kind: "retryable", reason: "x" });
    expect((await post()).status).toBe(500);
  });
});
