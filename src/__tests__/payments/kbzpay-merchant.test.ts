import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── getKbzMerchant ─────────────────────────────────────────────────────────
// Spec §2 decision 5 and §5.1: one named credential set per merchant, and no
// fallback between merchants, ever. A silent fallback is exactly how one
// tenant's buyers would pay another tenant's account.

const BRAVE = {
  KBZPAY_BRAVE_APPID: "kptest0000000000000000000000000000",
  KBZPAY_BRAVE_MERCH_CODE: "70000000001",
  KBZPAY_BRAVE_APP_KEY: "testkey0123456789abcdef",
  KBZPAY_BRAVE_NOTIFY_ORIGIN: "https://brave.kuunyi.com",
};

const ALL_KEYS = [
  ...Object.keys(BRAVE),
  "KBZPAY_SKYFEST_APPID",
  "KBZPAY_SKYFEST_MERCH_CODE",
  "KBZPAY_SKYFEST_APP_KEY",
  "KBZPAY_SKYFEST_NOTIFY_ORIGIN",
  "KBZPAY_APPID",
  "KBZPAY_MERCH_CODE",
  "KBZPAY_APP_KEY",
];

beforeEach(() => {
  for (const k of ALL_KEYS) delete process.env[k];
  Object.assign(process.env, BRAVE);
});

afterEach(() => {
  for (const k of ALL_KEYS) delete process.env[k];
});

const { getKbzMerchant } = await import("@/lib/kbzpay");

describe("getKbzMerchant", () => {
  it("returns the named merchant's credentials", () => {
    expect(getKbzMerchant("BRAVE")).toEqual({
      id: "BRAVE",
      appid: BRAVE.KBZPAY_BRAVE_APPID,
      merchCode: BRAVE.KBZPAY_BRAVE_MERCH_CODE,
      appKey: BRAVE.KBZPAY_BRAVE_APP_KEY,
      notifyOrigin: "https://brave.kuunyi.com",
    });
  });

  it.each([null, undefined, "", "brave", "1BRAVE", "B", "BRAVE-X", "A".repeat(33)])(
    "throws on a missing or malformed id (%s)",
    (id) => {
      expect(() => getKbzMerchant(id as string | null | undefined)).toThrow(/merchant id/);
    },
  );

  it.each(["APPID", "MERCH_CODE", "APP_KEY", "NOTIFY_ORIGIN"])(
    "throws, naming the variable, when %s is missing",
    (suffix) => {
      delete process.env[`KBZPAY_BRAVE_${suffix}`];
      expect(() => getKbzMerchant("BRAVE")).toThrow(`KBZPAY_BRAVE_${suffix} is not set`);
    },
  );

  it("treats a whitespace-only value as missing", () => {
    process.env.KBZPAY_BRAVE_APP_KEY = "   ";
    expect(() => getKbzMerchant("BRAVE")).toThrow("KBZPAY_BRAVE_APP_KEY is not set");
  });

  it("never falls back to another merchant or to the retired global vars", () => {
    process.env.KBZPAY_APPID = "global";
    process.env.KBZPAY_MERCH_CODE = "global";
    process.env.KBZPAY_APP_KEY = "global";
    expect(() => getKbzMerchant("SKYFEST")).toThrow("KBZPAY_SKYFEST_APPID is not set");
  });

  it("rejects a non-https notify origin", () => {
    process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "http://brave.kuunyi.com";
    expect(() => getKbzMerchant("BRAVE")).toThrow("KBZPAY_BRAVE_NOTIFY_ORIGIN must use https");
  });

  it("rejects a malformed notify origin", () => {
    process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "not a url";
    expect(() => getKbzMerchant("BRAVE")).toThrow("KBZPAY_BRAVE_NOTIFY_ORIGIN is not a valid URL");
  });

  it("normalises the notify origin, dropping any path or query", () => {
    // KBZPay rejects a notify_url carrying query parameters.
    process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "https://brave.kuunyi.com/some/path?x=1";
    expect(getKbzMerchant("BRAVE").notifyOrigin).toBe("https://brave.kuunyi.com");
  });

  it("never puts a secret value in an error message", () => {
    process.env.KBZPAY_BRAVE_NOTIFY_ORIGIN = "http://brave.kuunyi.com";
    try {
      getKbzMerchant("BRAVE");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(BRAVE.KBZPAY_BRAVE_APP_KEY);
      expect((err as Error).message).not.toContain(BRAVE.KBZPAY_BRAVE_APPID);
    }
  });
});
