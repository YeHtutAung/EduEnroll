// Stripe launch gate (Plan v18 deployment step 14) — the ACTUAL control that
// keeps sales closed. `payment_mode` and intake closure do not close the
// payment endpoints (verified in Phase 0), and an unpublished payment page is
// obscurity, not a control. Flipping STRIPE_SALES_OPEN=true after the
// four-zero audit is THE reopening action.

/**
 * Open iff the RAW value is exactly the lowercase string "true" — no
 * trimming, no normalisation. Absent, empty, "TRUE", "1", "yes", " true ",
 * "true\n" (the `echo` failure mode) are all CLOSED: raw equality means a
 * value malformed by a bad set procedure fails closed instead of being
 * rescued into an open gate.
 */
export function stripeSalesOpen(): boolean {
  return process.env.STRIPE_SALES_OPEN === "true";
}

/**
 * Smoke-test exception: STRIPE_SMOKE_REFS is comma-split, each entry trimmed
 * of ASCII whitespace; a ref passes iff it equals an entry EXACTLY —
 * case-sensitive, full-string, no prefix/substring/glob matching. Unset or
 * empty means no smoke path at all.
 */
export function isSmokeRef(enrollmentRef: string): boolean {
  const raw = process.env.STRIPE_SMOKE_REFS;
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .some((entry) => entry === enrollmentRef);
}

/** The gate both creation routes check BEFORE any Stripe call. */
export function stripeCreationAllowed(enrollmentRef: string): boolean {
  return stripeSalesOpen() || isSmokeRef(enrollmentRef);
}
