// ─── Terms of Sale: what a buyer agrees to ──────────────────────────────────
//
// Client-safe (no Node APIs): imported by the order forms as well as the
// server. The fingerprint of the organiser's rules lives server-side in
// src/server/legal/organiserRules.ts because it needs node:crypto.

/**
 * Version of the KuuNyi Terms of Sale a buyer accepts.
 *
 * Bump it whenever the wording of /terms changes. (The Privacy Policy is
 * linked on the order forms as information, not accepted.) Orders placed
 * from a page loaded before the bump then come back 409 TERMS_CHANGED and the
 * buyer reloads, so nobody is recorded as accepting wording they never saw.
 */
export const TERMS_VERSION = "2026-09-21";

/** Longest organiser rules text an event may carry. Mirrored by a DB check. */
export const ORGANISER_TERMS_MAX = 5000;

/** Trimmed rules, or null when there is nothing to show. */
export function normaliseOrganiserTerms(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}
