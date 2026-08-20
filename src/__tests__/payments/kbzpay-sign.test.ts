import { describe, it, expect } from "vitest";
import { buildStringA } from "@/lib/kbzpay";

// ─── KBZPay signature: stringA construction ─────────────────────────────────
// The KBZPay PGW docs publish two worked examples that print the expected
// stringA verbatim. These are real vectors from the provider, not assertions
// invented alongside the implementation, which is what makes them worth having.
// Spec §3.3.

// Vector 1 — the precreate example.
const PRECREATE_REQUEST = {
  timestamp: 1536637503,
  notify_url: "http://test.com/payment/notify",
  nonce_str: "845255910308564481",
  sign_type: "SHA256",
  method: "kbz.payment.precreate",
  sign: "wait_to_generate",
  version: "1.0",
  biz_content: {
    merch_order_id: "201811212009001",
    merch_code: "100001",
    appid: "kp123456789987654321abcdefghijkl",
    trade_type: "APPH5",
    total_amount: "1000",
    trans_currency: "MMK",
  },
};

const PRECREATE_STRING_A =
  "appid=kp123456789987654321abcdefghijkl&merch_code=100001" +
  "&merch_order_id=201811212009001&method=kbz.payment.precreate" +
  "&nonce_str=845255910308564481&notify_url=http://test.com/payment/notify" +
  "&timestamp=1536637503&total_amount=1000&trade_type=APPH5" +
  "&trans_currency=MMK&version=1.0";

// Vector 2 — the orderinfo example from the same section. Flat, no biz_content.
const ORDERINFO = {
  prepay_id: "KBZ00c25d94271b4d950ec748fdaf20c81d2b154042384",
  merch_code: "200001",
  appid: "kp419a753459284f72aa76d2ae9d6057",
  timestamp: 1535165303,
  nonce_str: "5K8264ILTKCH16CQ2502SI8ZNMTM67VS",
};

const ORDERINFO_STRING_A =
  "appid=kp419a753459284f72aa76d2ae9d6057&merch_code=200001" +
  "&nonce_str=5K8264ILTKCH16CQ2502SI8ZNMTM67VS" +
  "&prepay_id=KBZ00c25d94271b4d950ec748fdaf20c81d2b154042384" +
  "&timestamp=1535165303";

describe("buildStringA", () => {
  it("matches the published precreate vector", () => {
    expect(buildStringA(PRECREATE_REQUEST)).toBe(PRECREATE_STRING_A);
  });

  it("matches the published orderinfo vector", () => {
    expect(buildStringA(ORDERINFO)).toBe(ORDERINFO_STRING_A);
  });

  it("excludes sign and sign_type", () => {
    expect(buildStringA({ b: "2", sign: "x", sign_type: "SHA256", a: "1" })).toBe("a=1&b=2");
  });

  it("excludes empty, null and undefined values", () => {
    expect(buildStringA({ a: "1", b: "", c: null, d: undefined, e: "2" })).toBe("a=1&e=2");
  });

  it("excludes array and object values (JSONArray fields like refund_info)", () => {
    expect(buildStringA({ a: "1", refund_info: [{ x: 1 }], nested: { y: 2 } })).toBe("a=1");
  });

  // The callback carries Wallet_identifier with a capital W, which sorts BEFORE
  // every lowercase key under ASCII. localeCompare would place it elsewhere and
  // silently break every real callback. Spec §3.3.
  it("sorts by ASCII, so capitalised keys come first", () => {
    expect(buildStringA({ appid: "x", Wallet_identifier: "MCB", merch_code: "1" })).toBe(
      "Wallet_identifier=MCB&appid=x&merch_code=1",
    );
  });
});
