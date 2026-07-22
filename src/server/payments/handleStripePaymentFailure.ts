// handleStripePaymentFailure — checkout.session.async_payment_failed
// (Plan v18 §5b). A delayed method (PayNow, bank debit) did not clear.
//
// NOT settlePaidPayment: every step of that operation is a paid path, and
// feeding a failure into it would settle a payment that never arrived
// (R15 asserts the separation).
//
// This operation NEVER touches enrollments — Plan A's trigger owns the
// rejection decision (pre-confirmation AND no other verified/active payment),
// and duplicating it here is precisely the read-then-write Plan A removed.
// Failures are not notified in this plan (#186 owns the durable channel).

import { createAdminClient } from "@/lib/supabase/admin";
import { recordConflict, type ConflictSource, type ConflictType } from "./settlementConflicts";

export type FailureOutcome =
  | { kind: "rejected"; paymentId: string }
  | { kind: "replay" } // already rejected — idempotent, no conflict
  | { kind: "conflict"; conflictType: ConflictType }
  | { kind: "retryable"; reason: string };

export async function handleStripePaymentFailure(input: {
  /** Session event — the session id is the only identifier guaranteed present. */
  sessionId: string;
  source: ConflictSource;
}): Promise<FailureOutcome> {
  const supabase = createAdminClient();

  // ── Conditional UPDATE: active → rejected ──────────────────────────────────
  // The trigger decides what (if anything) happens to the enrollment.
  const { data: updated, error: updateError } = (await supabase
    .from("payments")
    .update({ status: "rejected" } as never)
    .eq("stripe_session_id", input.sessionId)
    .in("status", ["awaiting_payment", "pending"])
    .select("id")) as unknown as {
    data: { id: string }[] | null;
    error: { message: string } | null;
  };
  if (updateError) {
    return { kind: "retryable", reason: `failure update failed: ${updateError.message}` };
  }
  if (updated && updated.length > 0) {
    return { kind: "rejected", paymentId: updated[0].id };
  }

  // ── Zero rows → fail-closed reload ─────────────────────────────────────────
  const { data: reloaded, error: reloadError } = (await supabase
    .from("payments")
    .select("id, enrollment_id, status")
    .eq("stripe_session_id", input.sessionId)
    .maybeSingle()) as unknown as {
    data: { id: string; enrollment_id: string; status: string } | null;
    error: { message: string } | null;
  };
  if (reloadError) {
    return { kind: "retryable", reason: `failure reload failed: ${reloadError.message}` };
  }
  // Creation inserts the row before handing out a payable object, so absent
  // on a failure event is a real anomaly → 500.
  if (!reloaded) {
    return { kind: "retryable", reason: `no payment row for session ${input.sessionId}` };
  }
  if (reloaded.status === "rejected") {
    // Idempotent replay: no conflict, no notification.
    return { kind: "replay" };
  }

  const conflictType: ConflictType =
    reloaded.status === "verified"
      ? // Stale failure — the payment is PAID. No status change, no ticket
        // revocation; the conflict makes the anomaly visible to an operator.
        "failure_after_verified"
      : "unexpected_payment_state";

  await recordConflict({
    objectId: input.sessionId,
    conflictType,
    source: input.source,
    paymentId: reloaded.id,
    enrollmentId: reloaded.enrollment_id,
  });
  return { kind: "conflict", conflictType };
}
