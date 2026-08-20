import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── KBZPay transport: precreate / queryOrder / closeOrder ──────────────────
// Spec §3.1, §3.5. No real credentials are needed or used — gate G1 is about
// live verification, not about being able to build and test this.

const ENV = {
  KBZPAY_APPID: "kptest0000000000000000000000000000",
  KBZPAY_MERCH_CODE: "70000000001",
  KBZPAY_APP_KEY: "testkey0123456789abcdef",
  KBZPAY_MODE: "uat",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(process.env, ENV);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => ({ Response: body }) };
}

function requestBody(callIndex = 0) {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body).Request;
}

describe("precreate", () => {
  it("posts a signed PAY_BY_QRCODE order over HTTPS and returns the QR", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(
      ok({ result: "SUCCESS", code: "0", qrCode: "0002010102...", prepay_id: "KBZ00abc" }),
    );

    const res = await precreate({
      merchOrderId: "KBZ_1a2b3c4d_9f3c7b21d0e4a856",
      amount: 40000,
      title: "Payment for ENR-1",
      notifyUrl: "https://www.kuunyi.com/api/webhooks/kbzmmqr",
    });

    expect(res).toEqual({ ok: true, qrCode: "0002010102...", prepayId: "KBZ00abc" });

    // Never plaintext, even though the UAT docs print http:// for this
    // endpoint — merchant credentials must not cross the wire in the clear.
    // Spec §3.1, gate G2.
    const url = fetchMock.mock.calls[0][0];
    expect(url).toBe("https://api-uat.kbzpay.com/payment/gateway/uat/precreate");

    const body = requestBody();
    expect(body.method).toBe("kbz.payment.precreate");
    expect(body.version).toBe("1.0");
    expect(body.notify_url).toBe("https://www.kuunyi.com/api/webhooks/kbzmmqr");
    expect(body.biz_content.trade_type).toBe("PAY_BY_QRCODE");
    expect(body.biz_content.trans_currency).toBe("MMK");
    expect(body.biz_content.timeout_express).toBe("120m");
    expect(body.biz_content.total_amount).toBe("40000");
    expect(body.sign).toMatch(/^[0-9A-F]{64}$/);
    expect(body.nonce_str).toMatch(/^[A-Za-z0-9]{1,32}$/);
  });

  it("uses the production host when KBZPAY_MODE is production", async () => {
    process.env.KBZPAY_MODE = "production";
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(ok({ result: "SUCCESS", code: "0", qrCode: "q", prepay_id: "p" }));

    await precreate({ merchOrderId: "KBZ_x_y", amount: 1, title: "t", notifyUrl: "https://x/y" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.kbzpay.com/payment/gateway/precreate");
  });

  it("reports failure without throwing when result is FAIL", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(
      ok({ result: "FAIL", code: "ATHENTICATION_FAIL", msg: "merchant authentication fail." }),
    );

    const res = await precreate({
      merchOrderId: "KBZ_x_y",
      amount: 1,
      title: "t",
      notifyUrl: "https://x/y",
    });
    expect(res.ok).toBe(false);
  });

  it("reports failure on a non-2xx response", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => "bad gateway" });

    const res = await precreate({
      merchOrderId: "KBZ_x_y",
      amount: 1,
      title: "t",
      notifyUrl: "https://x/y",
    });
    expect(res.ok).toBe(false);
  });

  it("reports failure on a transport error rather than throwing", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    const res = await precreate({
      merchOrderId: "KBZ_x_y",
      amount: 1,
      title: "t",
      notifyUrl: "https://x/y",
    });
    expect(res.ok).toBe(false);
  });
});

describe("queryOrder", () => {
  it("uses version 3.0 and maps the business fields", async () => {
    const { queryOrder } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(
      ok({
        result: "SUCCESS",
        code: "0",
        trade_status: "PAY_SUCCESS",
        total_amount: "40000",
        trans_currency: "MMK",
        mm_order_id: "01003791060036848066",
        Wallet_identifier: "MCB",
      }),
    );

    const res = await queryOrder("KBZ_1a2b3c4d_9f3c7b21d0e4a856");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api-uat.kbzpay.com/payment/gateway/uat/queryorder",
    );
    expect(requestBody().version).toBe("3.0");
    expect(requestBody().method).toBe("kbz.payment.queryorder");
    expect(res).toMatchObject({
      ok: true,
      tradeStatus: "PAY_SUCCESS",
      totalAmount: "40000",
      transCurrency: "MMK",
      mmOrderId: "01003791060036848066",
      walletIdentifier: "MCB",
    });
  });

  // "The order does not exist" is an ANSWER, not a failure: it is the only
  // thing that proves KBZPay holds no order under a reference, which is what
  // lets a row become FAILED. Spec R13.
  it("reports ORDER_NOT_FOUND distinctly from a transport failure", async () => {
    const { queryOrder } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(
      ok({ result: "FAIL", code: "QUERYORDER_FAIL", msg: "The order does not exist." }),
    );

    expect(await queryOrder("KBZ_missing")).toMatchObject({
      ok: true,
      tradeStatus: "ORDER_NOT_FOUND",
    });
  });

  it("reports ok:false for a genuine failure, which is NOT an answer", async () => {
    const { queryOrder } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(ok({ result: "FAIL", code: "SYSTEM_ERROR", msg: "x" }));

    expect(await queryOrder("KBZ_x")).toEqual({ ok: false });
  });

  // The docs' own success example prints " PAY_SUCCESS" with a leading space.
  it("tolerates the leading whitespace the docs' own example contains", async () => {
    const { queryOrder } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(
      ok({ result: "SUCCESS", code: "0", trade_status: " PAY_SUCCESS" }),
    );

    expect(await queryOrder("KBZ_x")).toMatchObject({ tradeStatus: "PAY_SUCCESS" });
  });
});

describe("closeOrder", () => {
  // ok:true means only "the call did not error". It is NEVER proof the order
  // went unpaid — the caller must re-query. Spec R12.
  it("treats ORDER_ALREADY_CLOSED and QUERYORDER_FAIL as non-erroring", async () => {
    const { closeOrder } = await import("@/lib/kbzpay");
    for (const code of ["ORDER_ALREADY_CLOSED", "QUERYORDER_FAIL"]) {
      fetchMock.mockResolvedValue(ok({ result: "FAIL", code, msg: "x" }));
      expect((await closeOrder("KBZ_x")).ok).toBe(true);
    }
  });

  it("treats AOP03028, SYSTEM_ERROR and FLOW_CONTROL as genuine failures", async () => {
    const { closeOrder } = await import("@/lib/kbzpay");
    for (const code of ["AOP03028", "SYSTEM_ERROR", "FLOW_CONTROL"]) {
      fetchMock.mockResolvedValue(ok({ result: "FAIL", code, msg: "x" }));
      expect((await closeOrder("KBZ_x")).ok).toBe(false);
    }
  });

  it("succeeds on a clean close and uses version 3.0", async () => {
    const { closeOrder } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(ok({ result: "SUCCESS", code: "0", msg: "success" }));

    expect((await closeOrder("KBZ_x")).ok).toBe(true);
    expect(requestBody().version).toBe("3.0");
    expect(requestBody().method).toBe("kbz.payment.closeorder");
  });
});

describe("credential hygiene", () => {
  it("never puts the app key in the request body", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(ok({ result: "SUCCESS", code: "0", qrCode: "q", prepay_id: "p" }));

    await precreate({ merchOrderId: "KBZ_x_y", amount: 1, title: "t", notifyUrl: "https://x/y" });

    expect(fetchMock.mock.calls[0][1].body).not.toContain(ENV.KBZPAY_APP_KEY);
  });
});
