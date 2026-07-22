// settlePaidPayment — ONE settlement operation behind the three PAID events
// (Plan v18 §5): payment_intent.succeeded, checkout.session.completed,
// checkout.session.async_payment_succeeded. The failed event has its own
// operation (§5b, handleStripePaymentFailure) — feeding a failure into a paid
// path would settle a payment that never arrived.
//
// Contract:
//  1. Validate against the SNAPSHOT (provider_amount_minor/provider_currency),
//     never recomputed from current class/tenant config. Null snapshot does
//     not settle — missing_contract_snapshot conflict, 200.
//  2. Conditional UPDATE payments ('awaiting_payment','pending') → 'verified'.
//     trg_payments_sync_enrollment confirms the enrollment in the SAME
//     statement; this module never writes enrollments.status.
//  3. Zero rows → fail-closed reload, never an assumed replay.
//  4. settled and already_settled take the SAME post-settlement path; only the
//     notification decision differs (the caller notifies only on 'settled').
//  5. Fulfilment failure after settlement → retryable (500): the money is
//     recorded; the retry repairs tickets.

import { createAdminClient } from "@/lib/supabase/admin";
import { issueTicketsForEnrollment } from "@/server/tickets/issueTickets";
import { recordConflict, type ConflictSource, type ConflictType } from "./settlementConflicts";

export type SettleInput = {
  /** Exactly one of the two provider ids locates the payment row. */
  paymentIntentId?: string | null;
  sessionId?: string | null;
  /** Observed on the provider object (amount_received / amount_total). */
  observedAmountMinor: number | null;
  observedCurrency: string | null;
  source: ConflictSource;
  /**
   * Hosted settlement backfills the Session's PaymentIntent id onto the row
   * (webhook route behaviour predating this plan, kept: the id is real and
   * later events reference it).
   */
  backfillPaymentIntentId?: string | null;
};

export type SettleOutcome =
  | { kind: "settled"; paymentId: string; enrollmentId: string }
  | { kind: "already_settled"; paymentId: string; enrollmentId: string }
  | { kind: "conflict"; conflictType: ConflictType }
  /** Route maps to 500 — Stripe's retry schedule is the durability mechanism. */
  | { kind: "retryable"; reason: string };

type PaymentRow = {
  id: string;
  enrollment_id: string;
  tenant_id: string;
  status: string;
  provider_amount_minor: number | null;
  provider_currency: string | null;
};

export async function settlePaidPayment(input: SettleInput): Promise<SettleOutcome> {
  const supabase = createAdminClient();
  const objectId = input.paymentIntentId ?? input.sessionId;
  if (!objectId) return { kind: "retryable", reason: "no provider id supplied" };

  const locate = () => {
    const q = supabase
      .from("payments")
      .select("id, enrollment_id, tenant_id, status, provider_amount_minor, provider_currency");
    return input.paymentIntentId
      ? q.eq("stripe_payment_intent_id", input.paymentIntentId).maybeSingle()
      : q.eq("stripe_session_id", input.sessionId!).maybeSingle();
  };

  // ── Locate, fail-closed ────────────────────────────────────────────────────
  const { data: payment, error: locateError } = (await locate()) as unknown as {
    data: PaymentRow | null;
    error: { message: string } | null;
  };
  if (locateError) return { kind: "retryable", reason: `locate failed: ${locateError.message}` };
  // Creation inserts the row BEFORE handing out a payable object, so an
  // absent row on a paid event is a real anomaly, not a replay.
  if (!payment) return { kind: "retryable", reason: `no payment row for ${objectId}` };

  const conflict = async (
    conflictType: ConflictType,
    extra?: { expectedAmountMinor?: number | null; expectedCurrency?: string | null },
  ): Promise<SettleOutcome> => {
    // recordConflict throws on write failure → caller's catch → 500. A
    // conflict that is not durably recorded was not handled.
    await recordConflict({
      objectId,
      conflictType,
      source: input.source,
      paymentId: payment.id,
      enrollmentId: payment.enrollment_id,
      expectedAmountMinor: extra?.expectedAmountMinor ?? payment.provider_amount_minor,
      actualAmountMinor: input.observedAmountMinor,
      expectedCurrency: extra?.expectedCurrency ?? payment.provider_currency,
      actualCurrency: input.observedCurrency,
    });
    return { kind: "conflict", conflictType };
  };

  // ── 1. Contract snapshot validation ───────────────────────────────────────
  if (payment.provider_amount_minor === null || payment.provider_currency === null) {
    return conflict("missing_contract_snapshot");
  }
  if (
    input.observedAmountMinor === null ||
    Number(input.observedAmountMinor) !== Number(payment.provider_amount_minor)
  ) {
    return conflict("amount_mismatch");
  }
  if (
    input.observedCurrency === null ||
    input.observedCurrency.toLowerCase() !== payment.provider_currency
  ) {
    return conflict("currency_mismatch");
  }

  // ── 2. Conditional settlement UPDATE ───────────────────────────────────────
  const updatePayload: Record<string, unknown> = {
    status: "verified",
    paid_at: new Date().toISOString(),
  };
  if (input.backfillPaymentIntentId) {
    updatePayload.stripe_payment_intent_id = input.backfillPaymentIntentId;
  }
  const { data: updated, error: updateError } = (await supabase
    .from("payments")
    .update(updatePayload as never)
    .eq("id", payment.id)
    .in("status", ["awaiting_payment", "pending"])
    .select("id")) as unknown as {
    data: { id: string }[] | null;
    error: { message: string } | null;
  };
  if (updateError) {
    return { kind: "retryable", reason: `settlement update failed: ${updateError.message}` };
  }

  let transitionWon = (updated?.length ?? 0) > 0;

  // ── 3. Zero rows → fail-closed reload ─────────────────────────────────────
  if (!transitionWon) {
    const { data: reloaded, error: reloadError } = (await supabase
      .from("payments")
      .select("id, status")
      .eq("id", payment.id)
      .maybeSingle()) as unknown as {
      data: { id: string; status: string } | null;
      error: { message: string } | null;
    };
    if (reloadError) return { kind: "retryable", reason: `reload failed: ${reloadError.message}` };
    if (!reloaded) return { kind: "retryable", reason: `payment ${payment.id} vanished` };
    if (reloaded.status === "rejected") return conflict("payment_already_rejected");
    if (reloaded.status !== "verified") return conflict("unexpected_payment_state");
    // verified → already_settled: falls through to the same path below.
    transitionWon = false;
  }

  // ── 4. Post-settlement classification (same path for both) ────────────────
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("id, status")
    .eq("id", payment.enrollment_id)
    .maybeSingle()) as unknown as {
    data: { id: string; status: string } | null;
    error: { message: string } | null;
  };
  if (enrollmentError) {
    return { kind: "retryable", reason: `enrollment reload failed: ${enrollmentError.message}` };
  }
  if (!enrollment) {
    return { kind: "retryable", reason: `enrollment ${payment.enrollment_id} absent` };
  }
  if (enrollment.status === "rejected") {
    // No ticket, no notification — money verified against a rejected
    // enrollment is an operator decision (refund vs reinstate), never
    // an automatic one.
    return conflict("rejected_enrollment");
  }
  if (enrollment.status !== "confirmed") {
    return conflict("unexpected_enrollment_state");
  }

  // ── 5. Fulfilment (retryable) ──────────────────────────────────────────────
  // issueTicketsForEnrollment repairs partial sets and declines non-confirmed
  // enrollments; it throws on query failure. A throw here is a 500: the money
  // is recorded, the retry repairs tickets.
  await issueTicketsForEnrollment(payment.enrollment_id);

  return transitionWon
    ? { kind: "settled", paymentId: payment.id, enrollmentId: payment.enrollment_id }
    : { kind: "already_settled", paymentId: payment.id, enrollmentId: payment.enrollment_id };
}
