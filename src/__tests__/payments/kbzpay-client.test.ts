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
  it("posts a signed PAY_BY_QRCODE order and returns the QR", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(
      ok({ result: "SUCCESS", code: "0", qrCode: "0002010102...", prepay_id: "KBZ00abc" }),
    );

    const res = await precreate({
      merchOrderId: "KBZ_1a2b3c4d_9f3c7b21d0e4a856",
      amount: 40000,
      title: "Payment for ENR-1",
      notifyUrl: "https://www.kuunyi.com/api/webhooks/kbzmmqr",
      timeoutMinutes: 120,
    });

    expect(res).toEqual({ ok: true, qrCode: "0002010102...", prepayId: "KBZ00abc" });

    // Plaintext in UAT, and not by choice — see the "endpoint scheme" suite.
    const url = fetchMock.mock.calls[0][0];
    expect(url).toBe("http://api-uat.kbzpay.com/payment/gateway/uat/precreate");

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

    await precreate({ merchOrderId: "KBZ_x_y", amount: 1, title: "t", notifyUrl: "https://x/y", timeoutMinutes: 120 });

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
      timeoutMinutes: 30,
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
      timeoutMinutes: 30,
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
      timeoutMinutes: 30,
    });
    expect(res.ok).toBe(false);
  });

  it("reports failure when the response body stalls past the timeout", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    // Headers arrive, then the body never completes: the abort signal is still
    // armed, so json() rejects after fetch() has already resolved.
    const stalled = new Error("The operation was aborted due to timeout");
    stalled.name = "TimeoutError";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw stalled;
      },
    });

    const res = await precreate({
      merchOrderId: "KBZ_x_y",
      amount: 1,
      title: "t",
      notifyUrl: "https://x/y",
      timeoutMinutes: 30,
    });
    expect(res).toEqual({ ok: false });
  });

  it("reports failure on a malformed response body rather than throwing", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    });

    const res = await precreate({
      merchOrderId: "KBZ_x_y",
      amount: 1,
      title: "t",
      notifyUrl: "https://x/y",
      timeoutMinutes: 30,
    });
    expect(res).toEqual({ ok: false });
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
      "http://api-uat.kbzpay.com/payment/gateway/uat/queryorder",
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
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api-uat.kbzpay.com/payment/gateway/uat/closeorder",
    );
    expect(requestBody().version).toBe("3.0");
    expect(requestBody().method).toBe("kbz.payment.closeorder");
  });
});

// KBZPay's UAT gateway is split by scheme, and not by any choice of ours.
// Probing all six host/scheme pairs on 2026-09-01 gave:
//
//   precreate    http 200 (gateway)   https 404 (bare nginx)
//   queryorder   http 200 (gateway)   https 404 (bare nginx)
//   closeorder   http 404             https 200 (gateway)
//
// which is exactly what the published docs print. Port 443 on
// api-uat.kbzpay.com exists but routes closeorder alone. Production
// (api.kbzpay.com) answered 200 over HTTPS on all three.
//
// So the plaintext hop is UAT-only and must stay that way: the production
// branch is taken first and unconditionally, and no per-endpoint rule can
// reach it. That is the property these tests exist to hold.
describe("endpoint scheme", () => {
  async function urlFor(fn: "precreate" | "queryOrder" | "closeOrder") {
    const mod = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(ok({ result: "SUCCESS", code: "0", qrCode: "q", prepay_id: "p" }));

    if (fn === "precreate") {
      await mod.precreate({
        merchOrderId: "KBZ_x_y",
        amount: 1,
        title: "t",
        notifyUrl: "https://x/y",
        timeoutMinutes: 120,
      });
    } else {
      await mod[fn]("KBZ_x");
    }

    return fetchMock.mock.calls[0][0] as string;
  }

  describe("UAT", () => {
    it.each([
      ["precreate", "http://api-uat.kbzpay.com/payment/gateway/uat/precreate"],
      ["queryOrder", "http://api-uat.kbzpay.com/payment/gateway/uat/queryorder"],
      ["closeOrder", "https://api-uat.kbzpay.com/payment/gateway/uat/closeorder"],
    ] as const)("%s uses the scheme KBZPay actually serves", async (fn, expected) => {
      process.env.KBZPAY_MODE = "uat";
      expect(await urlFor(fn)).toBe(expected);
    });
  });

  describe("production", () => {
    it.each([
      ["precreate", "https://api.kbzpay.com/payment/gateway/precreate"],
      ["queryOrder", "https://api.kbzpay.com/payment/gateway/queryorder"],
      ["closeOrder", "https://api.kbzpay.com/payment/gateway/closeorder"],
    ] as const)("%s is HTTPS — the UAT rule cannot reach it", async (fn, expected) => {
      process.env.KBZPAY_MODE = "production";
      expect(await urlFor(fn)).toBe(expected);
    });

    // The guard that matters: whatever the per-endpoint UAT table says, a
    // production build must never emit an http:// URL.
    it("never emits a plaintext URL for any endpoint", async () => {
      for (const fn of ["precreate", "queryOrder", "closeOrder"] as const) {
        process.env.KBZPAY_MODE = "production";
        fetchMock.mockClear();
        expect(await urlFor(fn)).toMatch(/^https:\/\//);
      }
    });
  });
});

describe("credential hygiene", () => {
  it("never puts the app key in the request body", async () => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(ok({ result: "SUCCESS", code: "0", qrCode: "q", prepay_id: "p" }));

    await precreate({ merchOrderId: "KBZ_x_y", amount: 1, title: "t", notifyUrl: "https://x/y", timeoutMinutes: 120 });

    expect(fetchMock.mock.calls[0][1].body).not.toContain(ENV.KBZPAY_APP_KEY);
  });
});

// The POLICY (match the tenant's auto-cancel window) lives in the creation
// route. This guard only ensures a missing or nonsensical value cannot reach
// KBZPay as a malformed string — `${undefined}m` is "undefinedm".
describe("timeout_express guard", () => {
  const sentTimeout = () => JSON.parse(fetchMock.mock.calls[0][1].body).Request.biz_content.timeout_express;

  const call = async (timeoutMinutes: unknown) => {
    const { precreate } = await import("@/lib/kbzpay");
    fetchMock.mockResolvedValue(ok({ result: "SUCCESS", code: "0", qrCode: "q", prepay_id: "p" }));
    await precreate({
      merchOrderId: "KBZ_x_y",
      amount: 1,
      title: "t",
      notifyUrl: "https://x/y",
      timeoutMinutes: timeoutMinutes as number,
    });
  };

  it("passes a valid window through unchanged", async () => {
    await call(15);
    expect(sentTimeout()).toBe("15m");
  });

  it.each([undefined, NaN, null])("never emits 'undefinedm' for %s", async (bad) => {
    await call(bad);
    expect(sentTimeout()).toBe("120m");
    expect(sentTimeout()).not.toContain("undefined");
    expect(sentTimeout()).not.toContain("NaN");
  });

  it.each([
    [0, "1m"],
    [-5, "1m"],
    [121, "120m"],
    [4320, "120m"],
    [15.9, "15m"],
  ])("clamps %s to %s", async (input, expected) => {
    await call(input);
    expect(sentTimeout()).toBe(expected);
  });

  it("always emits an integer minute value within KBZPay's range", async () => {
    for (const value of [undefined, NaN, -1, 0, 1, 15, 119, 120, 121, 9999, 15.9]) {
      fetchMock.mockClear();
      await call(value);
      const m = Number(String(sentTimeout()).replace("m", ""));
      expect(Number.isInteger(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(1);
      expect(m).toBeLessThanOrEqual(120);
    }
  });
});
