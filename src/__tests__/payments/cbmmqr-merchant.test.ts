import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── getCbMerchant ──────────────────────────────────────────────────────────
// Spec §2 and §6: one named credential set per merchant, no fallback between
// merchants, ever. A fallback is how one tenant's buyers would pay another's
// account.

const YM = {
  CBMMQR_YOUNGMONEY_USER_ID: "ym-user",
  CBMMQR_YOUNGMONEY_PASSWORD: "ym-password",
  CBMMQR_YOUNGMONEY_SOURCE_ID: "ym-source",
  CBMMQR_YOUNGMONEY_MERCHANT_ID: "M0001",
  CBMMQR_YOUNGMONEY_TERMINAL_ID: "T0001",
  CBMMQR_YOUNGMONEY_API_KEY: "ym-api-key",
};

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("CBMMQR_")) delete process.env[k];
  Object.assign(process.env, YM);
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("CBMMQR_")) delete process.env[k];
});

const { getCbMerchant } = await import("@/lib/cbmmqr");

describe("getCbMerchant", () => {
  it("returns the named merchant", () => {
    expect(getCbMerchant("YOUNGMONEY")).toEqual({
      id: "YOUNGMONEY",
      userId: "ym-user",
      password: "ym-password",
      sourceId: "ym-source",
      merchantId: "M0001",
      terminalId: "T0001",
      apiKey: "ym-api-key",
    });
  });

  it.each([null, undefined, "", "youngmoney", "1BAD", "A"])("refuses the id %s", (id) => {
    expect(() => getCbMerchant(id as string)).toThrow(/missing or malformed/);
  });

  it.each(Object.keys(YM))("fails closed when %s is missing, naming it and not its value", (name) => {
    delete process.env[name];
    let message = "";
    try { getCbMerchant("YOUNGMONEY"); } catch (e) { message = (e as Error).message; }
    expect(message).toContain(name);
    for (const v of Object.values(YM)) expect(message).not.toContain(v);
  });

  it("never falls back to another merchant's variables", () => {
    process.env.CBMMQR_OTHER_USER_ID = "other";
    expect(() => getCbMerchant("OTHER")).toThrow(/CBMMQR_OTHER_PASSWORD/);
  });
});
