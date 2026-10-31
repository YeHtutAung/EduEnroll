// ─── CB order window ────────────────────────────────────────────────────────
// Spec §5.1 steps 4 and 7. CB chooses the QR's lifetime (we cannot send one),
// so the rule "a QR must not outlive its enrollment" is enforced twice: before
// asking CB, against CB's maximum validity, and after, against the expiry CB
// actually returned. A QR that fails the second check is never displayed, so
// nobody can pay it.

/** CB's maximum QR validity. 3 until CB answers question 2 (gate G2). */
export const CB_MAX_QR_MINUTES = 3;
/** Clock-skew and round-trip allowance on every CB time comparison. */
export const CB_EXPIRY_MARGIN_MINUTES = 2;

const MIN = 60_000;

export type Deadline = { kind: "none" } | { kind: "unknown" } | { kind: "at"; ms: number };

/**
 * When check_expired_enrollments() will reject this enrollment.
 * NOTE: tenants.auto_cancel_hours holds MINUTES since migration 058.
 */
export function enrollmentDeadline(
  autoCancelMinutes: number | null | undefined,
  enrolledAt: string | null | undefined,
): Deadline {
  if (!autoCancelMinutes || autoCancelMinutes <= 0) return { kind: "none" };
  const enrolled = enrolledAt ? Date.parse(enrolledAt) : NaN;
  if (!Number.isFinite(enrolled)) return { kind: "unknown" };
  return { kind: "at", ms: enrolled + Math.floor(autoCancelMinutes) * MIN };
}

/** Before calling CB: is there room for a full-lifetime QR plus the margin? */
export function preCheck(deadline: Deadline, now: number): "ok" | "too_close" | "unknown" {
  if (deadline.kind === "none") return "ok";
  if (deadline.kind === "unknown") return "unknown";
  return deadline.ms - now >= (CB_MAX_QR_MINUTES + CB_EXPIRY_MARGIN_MINUTES) * MIN ? "ok" : "too_close";
}

/** After CB answers: may this QR be displayed? Unreadable expiry → no. */
export function postCheck(deadline: Deadline, qrExpiresAtMs: number | null): "ok" | "too_late" {
  if (qrExpiresAtMs === null) return "too_late";
  if (deadline.kind === "none") return "ok";
  if (deadline.kind === "unknown") return "too_late";
  return qrExpiresAtMs < deadline.ms - CB_EXPIRY_MARGIN_MINUTES * MIN ? "ok" : "too_late";
}

/** The provisional provider_order_expires_at written at claim time (a hint). */
export function provisionalExpiry(now: number): number {
  return now + (CB_MAX_QR_MINUTES + CB_EXPIRY_MARGIN_MINUTES) * MIN;
}
