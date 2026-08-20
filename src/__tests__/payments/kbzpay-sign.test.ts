import { describe, it, expect } from "vitest";
import { buildStringA, buildMerchOrderId, sign, verifySign } from "@/lib/kbzpay";

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

// ─── sign() and verifySign() ────────────────────────────────────────────────

const KEY = "testkey0123456789abcdef";

// Fixed vector. The docs mask the real app key, so their published `sign`
// values cannot be reproduced; this pins the hash step against a value computed
// once out-of-band rather than by re-running the implementation's own logic.
const EXPECTED_SIGN = "BB6E194654BF884102D53336C0586BA01F05A0BF774CB3266010756C54BDAD24";

describe("sign", () => {
  it("appends &key= and returns uppercase hex SHA256", () => {
    expect(sign({ a: "1", b: "2" }, KEY)).toBe(EXPECTED_SIGN);
  });

  it("always returns 64 uppercase hex characters", () => {
    expect(sign({ z: "9" }, KEY)).toMatch(/^[0-9A-F]{64}$/);
  });
});

describe("verifySign", () => {
  const payload = {
    merch_order_id: "KBZ_1a2b3c4d_9f3c7b21d0e4a856",
    total_amount: "40000",
    trans_currency: "MMK",
    trade_status: "PAY_SUCCESS",
    Wallet_identifier: "MCB",
    sign_type: "SHA256",
  };

  it("accepts a correctly signed payload", () => {
    expect(verifySign({ ...payload, sign: sign(payload, KEY) }, KEY)).toBe(true);
  });

  // The docs state KBZPay may add fields and that extension fields must be
  // supported when verifying. A hardcoded field list would break every callback
  // the day they add one. Spec §3.3.
  it("accepts a payload carrying an unknown extension field", () => {
    const extended = { ...payload, some_future_field: "whatever" };
    expect(verifySign({ ...extended, sign: sign(extended, KEY) }, KEY)).toBe(true);
  });

  it("rejects a payload whose amount was tampered with", () => {
    const signed = { ...payload, sign: sign(payload, KEY) };
    expect(verifySign({ ...signed, total_amount: "1" }, KEY)).toBe(false);
  });

  it("rejects a wrong key", () => {
    const signed = { ...payload, sign: sign(payload, KEY) };
    expect(verifySign(signed, "someotherkey")).toBe(false);
  });

  it("rejects a missing or malformed signature without throwing", () => {
    expect(verifySign({ ...payload }, KEY)).toBe(false);
    expect(verifySign({ ...payload, sign: "short" }, KEY)).toBe(false);
    expect(verifySign({ ...payload, sign: 12345 }, KEY)).toBe(false);
  });

  it("accepts a lowercase signature, since only the hex casing differs", () => {
    const signed = { ...payload, sign: sign(payload, KEY).toLowerCase() };
    expect(verifySign(signed, KEY)).toBe(true);
  });
});

// ─── buildMerchOrderId() ────────────────────────────────────────────────────
// KBZPay allows only letters, digits and underscores, max 40. A timestamp
// suffix is not collision-safe, and a duplicate payment_ref breaks settlement
// for BOTH payments because the webhooks resolve it with .single(). Spec R1.

describe("buildMerchOrderId", () => {
  const ENROLLMENT = "1a2b3c4d-5e6f-7788-99aa-bbccddeeff00";

  it("matches KBZPay's charset and length limit", () => {
    expect(buildMerchOrderId(ENROLLMENT)).toMatch(/^[A-Za-z0-9_]{1,40}$/);
  });

  it("keeps a recognisable enrollment prefix for support triage", () => {
    expect(buildMerchOrderId(ENROLLMENT)).toMatch(/^KBZ_1a2b3c4d_/);
  });

  it("never collides across repeated calls for the SAME enrollment", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(buildMerchOrderId(ENROLLMENT));
    expect(seen.size).toBe(10_000);
  });
});
