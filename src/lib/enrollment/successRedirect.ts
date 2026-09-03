// ─── Where a confirmed payment should land ──────────────────────────────────
//
// The HitPay poll built this URL as
//
//   `/enroll/${encodeURIComponent(intake_slug ?? "")}/checkout/success/?ref=...`
//
// and `intake_slug` is nullable — /api/public/status sets it to null when the
// enrollment has no intake. An empty segment collapses the path to
// `/enroll//checkout/success/`, which 404s. The person seeing that 404 has
// ALREADY PAID, which is the worst possible moment to lose them.
//
// Returning null instead of a broken URL lets the caller stay put. Since the
// payment page renders the e-ticket itself, staying is a complete outcome
// rather than a degraded one — which is what makes refusing to navigate safe.

/**
 * The success-page URL for a confirmed order, or null when there is no intake
 * slug to build one from and the caller should remain where it is.
 */
export function successRedirectUrl(
  intakeSlug: string | null | undefined,
  enrollmentRef: string,
): string | null {
  const slug = intakeSlug?.trim();
  if (!slug || !enrollmentRef) return null;

  return (
    `/enroll/${encodeURIComponent(slug)}/checkout/success/` +
    `?ref=${encodeURIComponent(enrollmentRef)}`
  );
}
