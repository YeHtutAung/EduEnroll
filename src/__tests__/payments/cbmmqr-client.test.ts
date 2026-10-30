import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  buildReferenceNo, REFERENCE_PATTERN, parseCbTimestamp, normaliseCode,
  apiKeyMatches, currencyFromCb, isPendingCode,
} = await import("@/lib/cbmmqr");

describe("buildReferenceNo", () => {
  it("is CB + 23 base32 characters, 25 in all (CB's referenceNo limit)", () => {
    const ref = buildReferenceNo();
    expect(ref).toHaveLength(25);
    expect(ref).toMatch(REFERENCE_PATTERN);
  });

  it("does not repeat across 10,000 draws", () => {
    const seen = new Set(Array.from({ length: 10_000 }, buildReferenceNo));
    expect(seen.size).toBe(10_000);
  });

  it("cannot collide with another provider's format", () => {
    expect(buildReferenceNo().startsWith("KBZ_")).toBe(false);
  });
});

describe("parseCbTimestamp", () => {
  afterEach(() => { delete process.env.CBMMQR_UTC_OFFSET; });

  it("reads CB's format in Myanmar time (+06:30) by default", () => {
    expect(parseCbTimestamp("20261031 10:14:14")).toBe(Date.parse("2026-10-31T10:14:14+06:30"));
  });

  it("uses CBMMQR_UTC_OFFSET when set", () => {
    process.env.CBMMQR_UTC_OFFSET = "+00:00";
    expect(parseCbTimestamp("20261031 10:14:14")).toBe(Date.parse("2026-10-31T10:14:14Z"));
  });

  it("throws on a malformed offset rather than guessing", () => {
    process.env.CBMMQR_UTC_OFFSET = "Asia/Yangon";
    expect(() => parseCbTimestamp("20261031 10:14:14")).toThrow(/CBMMQR_UTC_OFFSET/);
  });

  it.each([undefined, null, "", "2026-10-31 10:14:14", "20261331 10:14:14", 20261031])(
    "returns null for %s", (v) => { expect(parseCbTimestamp(v)).toBeNull(); },
  );
});

describe("normaliseCode", () => {
  it.each([[0, "0000"], [6, "0006"], ["0006", "0006"], [" 52 ", "0052"], ["0000", "0000"]])(
    "%s → %s", (v, out) => { expect(normaliseCode(v)).toBe(out); },
  );
  it.each([undefined, null, "", "abc", "00001", 1.5])("%s → null", (v) => {
    expect(normaliseCode(v)).toBeNull();
  });
});

describe("isPendingCode", () => {
  it("0006 and 0008 are pending; nothing else is", () => {
    expect(isPendingCode("0006")).toBe(true);
    expect(isPendingCode("0008")).toBe(true);
    for (const c of ["0000", "0007", "0009", "0026", null]) expect(isPendingCode(c)).toBe(false);
  });
});

describe("apiKeyMatches", () => {
  it("matches only the exact key", () => {
    expect(apiKeyMatches("secret-key", "secret-key")).toBe(true);
    expect(apiKeyMatches("secret-kez", "secret-key")).toBe(false);
    expect(apiKeyMatches("secret", "secret-key")).toBe(false);
    expect(apiKeyMatches(undefined, "secret-key")).toBe(false);
    expect(apiKeyMatches(123, "secret-key")).toBe(false);
  });
});

describe("currencyFromCb", () => {
  it("104 is MMK; anything else is null", () => {
    expect(currencyFromCb("104")).toBe("MMK");
    expect(currencyFromCb(104)).toBe("MMK");
    for (const v of ["MMK", "840", "", null, undefined]) expect(currencyFromCb(v)).toBeNull();
  });
});
