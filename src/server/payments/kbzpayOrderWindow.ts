// ─── KBZPay order window ────────────────────────────────────────────────────
// Pure derivation of how long a KBZPay QR may stay payable, kept out of the
// route because Next.js route files may only export HTTP handlers — and
// because this is the invariant most worth testing directly.

/** KBZPay accepts a timeout_express of 1–120 minutes. */
const KBZ_MIN_WINDOW_MINUTES = 1;
const KBZ_MAX_WINDOW_MINUTES = 120;

/**
 * How long the QR should stay payable, derived from the tenant's own
 * auto-cancel window.
 *
 * The QR must not outlive the enrollment. `check_expired_enrollments()` rejects
 * an unpaid enrollment after the tenant's window, and it does NOT touch the
 * payment row — so a QR that is still payable afterwards lets a student pay for
 * an enrollment that no longer exists. The money settles (the payment row
 * transitions normally), but `fn_block_reconfirm_rejected` and the sync
 * trigger's status predicate both refuse to re-confirm a rejected enrollment,
 * so no ticket is issued and the seat is already gone. That needs a manual
 * refund or reinstatement every time.
 *
 * NOTE the column name: `tenants.auto_cancel_hours` holds **minutes**, not
 * hours, since migration 058 renamed the semantics but not the column.
 *
 * 0 disables auto-cancel entirely, in which case KBZPay's maximum is correct —
 * there is no enrollment deadline to outlive.
 */
type OrderWindow =
  | { kind: "ok"; timeoutMinutes: number; expiresAt: Date }
  /** Under a minute left before the enrollment's own deadline. */
  | { kind: "expired" }
  /** The deadline cannot be computed — never guess it. */
  | { kind: "unknown" };

export function orderWindow(
  autoCancelMinutes: number | null | undefined,
  enrolledAt: string | null | undefined,
  now: number,
): OrderWindow {
  // Auto-cancel disabled: there is no enrollment deadline to outlive, so
  // KBZPay's maximum is correct.
  if (!autoCancelMinutes || autoCancelMinutes <= 0) {
    return {
      kind: "ok",
      timeoutMinutes: KBZ_MAX_WINDOW_MINUTES,
      expiresAt: new Date(now + KBZ_MAX_WINDOW_MINUTES * 60_000),
    };
  }

  const enrolled = enrolledAt ? Date.parse(enrolledAt) : NaN;
  if (!Number.isFinite(enrolled)) return { kind: "unknown" };

  // check_expired_enrollments(): enrolled_at < now() - auto_cancel_hours * '1 minute'
  const deadline = enrolled + Math.floor(autoCancelMinutes) * 60_000;

  // The REMAINING time, not the configured duration. Sending the full duration
  // for an enrollment created 14 minutes into a 15-minute window would leave
  // the QR payable for ~14 minutes after the enrollment is rejected — exactly
  // the failure this derivation exists to prevent.
  const remainingMinutes = Math.floor((deadline - now) / 60_000);

  // Below KBZPay's one-minute minimum there is nothing safe to issue. Let the
  // expiry process win rather than creating an order that outlives its
  // enrollment by construction.
  if (remainingMinutes < KBZ_MIN_WINDOW_MINUTES) return { kind: "expired" };

  return {
    kind: "ok",
    timeoutMinutes: Math.min(remainingMinutes, KBZ_MAX_WINDOW_MINUTES),
    // Whichever comes first: the enrollment deadline, or KBZPay's own cap.
    expiresAt: new Date(Math.min(deadline, now + KBZ_MAX_WINDOW_MINUTES * 60_000)),
  };
}

