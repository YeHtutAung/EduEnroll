// Plan v18 §2 / Tests "Currency": the whole-unit SGD launch contract,
// enforced at the first layer. SGD 12 → 1200; SGD 12.34 → thrown, before
// Stripe is ever involved; JPY exponent logic proven but JPY refused by the
// allow-list; output always an integer.
import { describe, expect, it } from "vitest";
import {
  STRIPE_LAUNCH_CURRENCIES,
  isStripeSupported,
  minorUnitsForExponentCheck,
  toMinorUnits,
} from "@/lib/payments/currency";

describe("STRIPE_LAUNCH_CURRENCIES", () => {
  it("is SGD only for launch", () => {
    expect(STRIPE_LAUNCH_CURRENCIES).toEqual(["sgd"]);
  });
});

describe("isStripeSupported", () => {
  it("accepts sgd in any case", () => {
    expect(isStripeSupported("sgd")).toBe(true);
    expect(isStripeSupported("SGD")).toBe(true);
  });

  it("refuses mmk, jpy, usd and empty", () => {
    for (const c of ["mmk", "MMK", "jpy", "usd", ""]) {
      expect(isStripeSupported(c)).toBe(false);
    }
  });
});

describe("toMinorUnits — whole-unit SGD contract", () => {
  it("SGD 12 → 1200", () => {
    expect(toMinorUnits(12, "sgd")).toBe(1200);
  });

  it("SGD 12 → 1200 with uppercase currency", () => {
    expect(toMinorUnits(12, "SGD")).toBe(1200);
  });

  it("SGD 12.34 → thrown (whole-unit launch contract), not 1234", () => {
    expect(() => toMinorUnits(12.34, "sgd")).toThrow(/whole major unit/);
  });

  it("rejects every fractional value, including ones exactly representable in binary", () => {
    for (const v of [0.5, 1.25, 99.99, 100.5]) {
      expect(() => toMinorUnits(v, "sgd")).toThrow(/whole major unit/);
    }
  });

  it("rejects zero and negatives", () => {
    expect(() => toMinorUnits(0, "sgd")).toThrow(/positive/);
    expect(() => toMinorUnits(-5, "sgd")).toThrow(/positive/);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => toMinorUnits(Number.NaN, "sgd")).toThrow(/finite/);
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY, "sgd")).toThrow(/finite/);
    expect(() => toMinorUnits(Number.NEGATIVE_INFINITY, "sgd")).toThrow(/finite/);
  });

  it("rejects currencies outside the allow-list — including JPY and MMK", () => {
    expect(() => toMinorUnits(5000, "jpy")).toThrow(/not supported/);
    expect(() => toMinorUnits(50000, "mmk")).toThrow(/not supported/);
    expect(() => toMinorUnits(10, "usd")).toThrow(/not supported/);
  });

  it("rejects amounts whose minor units exceed the safe integer range", () => {
    expect(() => toMinorUnits(Number.MAX_SAFE_INTEGER, "sgd")).toThrow(/safe integer/);
  });

  it("output is always a safe integer", () => {
    for (const v of [1, 7, 12, 100, 99999]) {
      const minor = toMinorUnits(v, "sgd");
      expect(Number.isSafeInteger(minor)).toBe(true);
      expect(minor).toBe(v * 100);
    }
  });
});

describe("exponent logic (generic, for future widening — not a route path)", () => {
  it("JPY 5000 → 5000, not 500000 (zero-decimal)", () => {
    expect(minorUnitsForExponentCheck(5000, "jpy")).toBe(5000);
  });

  it("two-decimal default: SGD 12 → 1200", () => {
    expect(minorUnitsForExponentCheck(12, "sgd")).toBe(1200);
  });
});
