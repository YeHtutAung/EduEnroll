// settleMmqrPayment — ONE settlement operation for KBZPay MMQR.
//
// Modelled on settlePaidPayment (the Stripe operation), narrowed to what MMQR
// needs. Design: docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md §6
//
// Contract:
//  0. Currency is checked FIRST. An amount is meaningless without it (R3).
//  1. Validate against the SNAPSHOT (payments.amount, written at order-create
//     time), never a figure recomputed from current class or tenant config.
//  2. Conditional UPDATE ('awaiting_payment','pending') → 'verified'.
//     trg_payments_sync_enrollment confirms the enrollment in the SAME
//     statement; this module never writes enrollments.status.
//  3. Zero rows → fail-closed reload, never an assumed replay.
//  4. settled and already_settled take the SAME post-settlement path; only the
//     notification decision differs (we notify only on 'settled').
//  5. Fulfilment failure after settlement → retryable: the money is recorded,
//     and the retry repairs the tickets.
//
// Unlike the Stripe operation there is no conflict table to write to —
// payment_settlement_conflicts is constrained to provider='stripe' — so
// mismatches are returned to the caller and logged loudly instead.

import { createAdminClient } from "@/lib/supabase/admin";
import { issueTicketsForEnrollment } from "@/server/tickets/issueTickets";
import { notifyEnrollmentConfirmed } from "@/server/payments/notifyEnrollmentConfirmed";

export type SettleMmqrSource = "callback" | "status" | "create";

export type SettleMmqrInput = {
  /** merch_order_id — locates the payment row via payments.payment_ref. */
  paymentRef: string;
  /** Amount observed at the provider, in whole MMK. */
  observedAmount: number | null;
  /** trans_currency observed at the provider. Must be MMK. */
  observedCurrency: string | null;
  /** KBZPay's own order id, stored for reconciliation. */
  mmOrderId?: string | null;
  /** Wallet_identifier — the payer's bank. */
  walletIdentifier?: string | null;
  source: SettleMmqrSource;
};

export type SettleMmqrOutcome =
  | { kind: "settled"; paymentId: string; enrollmentId: string }
  | { kind: "already_settled"; paymentId: string; enrollmentId: string }
  | { kind: "amount_mismatch" }
  | { kind: "currency_mismatch" }
  | { kind: "not_found" }
  | { kind: "retryable"; reason: string };

type PaymentRow = {
  id: string;
  enrollment_id: string;
  tenant_id: string;
  status: string;
  amount: number;
};

export async function settleMmqrPayment(input: SettleMmqrInput): Promise<SettleMmqrOutcome> {
  const supabase = createAdminClient();

  // ── 0. Currency, before anything else (R3) ────────────────────────────────
  // total_amount is only meaningful together with trans_currency: 40000 USD
  // must never settle a 40000 MMK enrollment. Checked ahead of the amount
  // comparison so a matching figure in the wrong currency cannot slip through.
  if (input.observedCurrency !== "MMK") {
    console.error(
      `[kbzpay-settle] currency mismatch for ${input.paymentRef}: ` +
        `observed=${input.observedCurrency ?? "null"} expected=MMK (source=${input.source})`,
    );
    return { kind: "currency_mismatch" };
  }

  // ── 1. Locate ─────────────────────────────────────────────────────────────
  const { data: payment, error: locateError } = (await supabase
    .from("payments")
    .select("id, enrollment_id, tenant_id, status, amount")
    .eq("payment_ref", input.paymentRef)
    .maybeSingle()) as unknown as {
    data: PaymentRow | null;
    error: { message: string } | null;
  };

  if (locateError) {
    return { kind: "retryable", reason: `locate failed: ${locateError.message}` };
  }
  if (!payment) return { kind: "not_found" };

  // ── 2. Amount, against the snapshot ───────────────────────────────────────
  if (input.observedAmount === null || Number(input.observedAmount) !== Number(payment.amount)) {
    console.error(
      `[kbzpay-settle] amount mismatch for ${input.paymentRef}: ` +
        `observed=${input.observedAmount ?? "null"} snapshot=${payment.amount} ` +
        `(source=${input.source})`,
    );
    return { kind: "amount_mismatch" };
  }

  // ── 3. Conditional settlement transition ──────────────────────────────────
  // The .in() predicate elects exactly one winner across the callback, the
  // browser poller and the creation route, which is what makes KBZPay's 60s
  // and 600s retries idempotent.
  const updatePayload: Record<string, unknown> = {
    status: "verified",
    mmqr_status: "SUCCESS",
    paid_at: new Date().toISOString(),
  };
  if (input.mmOrderId) updatePayload.bank_reference = input.mmOrderId;
  if (input.walletIdentifier) updatePayload.payer_institution = input.walletIdentifier;

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

  const transitionWon = (updated?.length ?? 0) > 0;

  // ── 4. Zero rows → fail-closed reload ─────────────────────────────────────
  if (!transitionWon) {
    const { data: reloaded, error: reloadError } = (await supabase
      .from("payments")
      .select("id, status")
      .eq("id", payment.id)
      .maybeSingle()) as unknown as {
      data: { id: string; status: string } | null;
      error: { message: string } | null;
    };
    if (reloadError) {
      return { kind: "retryable", reason: `reload failed: ${reloadError.message}` };
    }
    if (!reloaded) {
      return { kind: "retryable", reason: `payment ${payment.id} vanished` };
    }
    if (reloaded.status !== "verified") {
      // Rejected, or some state we do not understand. Never assume a replay.
      return { kind: "retryable", reason: `unexpected payment state: ${reloaded.status}` };
    }
    return fulfil(false);
  }

  return fulfil(true);

  // ── 5. Post-settlement fulfilment (shared by both outcomes) ───────────────
  async function fulfil(won: boolean): Promise<SettleMmqrOutcome> {
    const { data: enrollment, error: enrollmentError } = (await supabase
      .from("enrollments")
      .select("id, status")
      .eq("id", payment!.enrollment_id)
      .maybeSingle()) as unknown as {
      data: { id: string; status: string } | null;
      error: { message: string } | null;
    };

    if (enrollmentError) {
      return { kind: "retryable", reason: `enrollment reload failed: ${enrollmentError.message}` };
    }
    if (!enrollment) {
      return { kind: "retryable", reason: `enrollment ${payment!.enrollment_id} absent` };
    }
    if (enrollment.status !== "confirmed") {
      // Money verified against an enrollment the trigger did not confirm is an
      // operator decision (refund vs reinstate), never an automatic one. No
      // ticket, no notification.
      console.error(
        `[kbzpay-settle] enrollment ${enrollment.id} is '${enrollment.status}', not confirmed, ` +
          `after settling ${input.paymentRef}`,
      );
      return { kind: "retryable", reason: `enrollment not confirmed: ${enrollment.status}` };
    }

    // Throws on failure → retryable. The money is recorded; the retry repairs
    // the ticket set.
    try {
      await issueTicketsForEnrollment(payment!.enrollment_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[kbzpay-settle] issueTicketsForEnrollment failed:", message);
      return { kind: "retryable", reason: `fulfilment failed: ${message}` };
    }

    // Notification belongs to the transition winner, so whichever of the
    // callback / poller / creation route wins sends it exactly once.
    if (won) {
      try {
        await notifyEnrollmentConfirmed(payment!.enrollment_id);
      } catch (error) {
        // Best-effort transports are not part of the money/ticket commit.
        console.error("[kbzpay-settle] notification failed:", error);
      }
    }

    return won
      ? { kind: "settled", paymentId: payment!.id, enrollmentId: payment!.enrollment_id }
      : { kind: "already_settled", paymentId: payment!.id, enrollmentId: payment!.enrollment_id };
  }
}
