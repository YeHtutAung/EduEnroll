// Stripe currency contract (Plan v18 §2).
//
// The launch contract is WHOLE MAJOR UNITS: every fee column and
// payments.amount is integer (fee_mmk/amount_mmk at 000, renamed by 074), so a
// fractional price cannot be configured, cannot be stored, and every reader
// would display it wrong after silent rounding. toMinorUnits() is the primary
// gate — it throws before Stripe is ever called; the finalizer's ST001 check
// is the backstop for a caller that bypassed this helper, never the main gate.
//
// The exponent logic stays generic (zero-decimal 0, two-decimal 2) so widening
// the allow-list later is a data change plus a deliberate review of the
// whole-unit restriction — not a rewrite.

export const STRIPE_LAUNCH_CURRENCIES = ["sgd"] as const;

export type StripeLaunchCurrency = (typeof STRIPE_LAUNCH_CURRENCIES)[number];

// Stripe zero-decimal currencies (minor unit == major unit). Only entries
// relevant to plausible future widening are listed; anything not classified
// here is treated as two-decimal, which is Stripe's default.
const ZERO_DECIMAL = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

export function isStripeSupported(currency: string): boolean {
  return (STRIPE_LAUNCH_CURRENCIES as readonly string[]).includes(
    currency.toLowerCase(),
  );
}

/**
 * Convert a major-unit amount to Stripe minor units.
 *
 * Throws on: unsupported currency (outside the launch allow-list), zero,
 * negative, NaN, Infinity, and ANY fractional major amount — the whole-unit
 * launch contract. Output is always a safe integer.
 */
export function toMinorUnits(major: number, currency: string): number {
  const cur = currency.toLowerCase();
  if (!isStripeSupported(cur)) {
    throw new Error(`currency not supported for Stripe: ${currency}`);
  }
  if (typeof major !== "number" || Number.isNaN(major) || !Number.isFinite(major)) {
    throw new Error(`amount is not a finite number`);
  }
  if (major <= 0) {
    throw new Error(`amount must be positive, got ${major}`);
  }
  // Whole-unit launch contract: reject ANY fractional major amount rather
  // than rounding it into a value the data model cannot store.
  if (!Number.isInteger(major)) {
    throw new Error(
      `amount must be a whole major unit (launch contract), got ${major}`,
    );
  }
  const exponent = ZERO_DECIMAL.has(cur) ? 0 : 2;
  const minor = major * 10 ** exponent;
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`amount out of safe integer range: ${major}`);
  }
  return minor;
}

/**
 * Exponent-only conversion for tests and audits of NON-launch currencies
 * (e.g. proving JPY 5000 → 5000, not 500000). Deliberately not exported for
 * route use: routes must go through toMinorUnits and its allow-list.
 */
export function minorUnitsForExponentCheck(major: number, currency: string): number {
  const exponent = ZERO_DECIMAL.has(currency.toLowerCase()) ? 0 : 2;
  return major * 10 ** exponent;
}
