// resolveKbzpayOrder — spec §5.1 step 7.
//
// Answers ONE question about a locally-live KBZPay order we cannot serve:
// is it still payable, and if not, why?
//
// This procedure is where every wrong-statement finding in the design review
// landed, so the invariant is stated once and enforced here:
//
//   NO terminal transition and NO order-slot release without a queryorder
//   ANSWER. Not a local clock (R8), not a cached QR (R9), not a closeorder
//   return code (R12), not a failed outbound request (R13).
//
// Callers reach this with a single 'unresolved' outcome from
// claim_kbzpay_order_slot, whatever the local reason — stale expiry hint,
// changed amount, or a missing QR from a failed write. All three ask the
// provider the same question, so they share one path.
//
// This module decides; it does not write. complete_kbzpay_supersede performs
// the local transition, and only for a reason produced here.

import { queryOrder, closeOrder, type TradeStatus } from "@/lib/kbzpay";
import { settleMmqrPayment, type SettleMmqrSource } from "@/server/payments/settleMmqrPayment";

export type RetireReason = "FAILED" | "EXPIRED" | "SUPERSEDED";

export type ResolveOutcome =
  /** The student already paid this order. It has been settled; issue no replacement. */
  | { kind: "already_paid" }
  /** Settlement refused the money (amount/currency). Needs an operator, not a QR. */
  | { kind: "settlement_conflict"; reason: "amount_mismatch" | "currency_mismatch" }
  /** Provider-confirmed dead and unpaid. Safe to retire locally for this reason. */
  | { kind: "retire"; reason: RetireReason }
  /** We could not prove anything. Change nothing; the old order stays live. */
  | { kind: "blocked"; reason: string };

export type ResolveInput = {
  /** payment_ref of the live row we could not serve. */
  oldRef: string;
  source: SettleMmqrSource;
};

/** Terminal at the provider AND unpaid — the order can never be paid now. */
const TERMINAL_UNPAID: TradeStatus[] = ["ORDER_EXPIRED", "ORDER_CLOSED", "PAY_FAILED"];

export async function resolveKbzpayOrder(input: ResolveInput): Promise<ResolveOutcome> {
  const { oldRef, source } = input;

  // ── a. Ask the provider ───────────────────────────────────────────────────
  // Before any close: "not found" means precreate never landed (FAILED), and a
  // terminal status means the order died on its own (EXPIRED).
  const first = await queryOrder(oldRef);
  const firstOutcome = await classify(first, "initial query", {
    notFound: "FAILED",
    terminal: "EXPIRED",
  });
  if (firstOutcome.kind !== "still_payable") return firstOutcome.outcome;

  // ── b. Still payable → close it, then ASK AGAIN (R12) ─────────────────────
  // A close that did not error is not proof the order went unpaid:
  // ORDER_ALREADY_CLOSED and QUERYORDER_FAIL both say "not payable now" without
  // saying whether it was cancelled or COMPLETED. The payer can settle between
  // (a) and this call, and the settling callback need not have arrived yet — so
  // the local row still reads PENDING and looks perfectly retirable. Trusting
  // the close code here re-opens the over-collection R5 exists to prevent.
  const closed = await closeOrder(oldRef);
  if (!closed.ok) {
    return {
      kind: "blocked",
      reason: `closeOrder failed for ${oldRef}; old order remains live`,
    };
  }

  // After a close we performed, any dead-or-absent answer means WE retired it,
  // so the recorded reason is SUPERSEDED rather than EXPIRED or FAILED.
  const second = await queryOrder(oldRef);
  const secondOutcome = await classify(second, "re-query after close", {
    notFound: "SUPERSEDED",
    terminal: "SUPERSEDED",
  });
  if (secondOutcome.kind !== "still_payable") return secondOutcome.outcome;

  // The close reported success and the provider still says payable. Believe the
  // provider. Freeing the slot now would leave two payable orders.
  return {
    kind: "blocked",
    reason: `${oldRef} still payable after a successful close; refusing to free the slot`,
  };

  // ── Shared classification ─────────────────────────────────────────────────
  // Used for both the initial query and the re-query, so the two can never
  // drift apart in how they read the provider's answer.
  async function classify(
    result: Awaited<ReturnType<typeof queryOrder>>,
    stage: string,
    reasons: { notFound: RetireReason; terminal: RetireReason },
  ): Promise<{ kind: "still_payable" } | { kind: "done"; outcome: ResolveOutcome }> {
    if (!result.ok) {
      return {
        kind: "done",
        outcome: { kind: "blocked", reason: `${stage} unreachable for ${oldRef}` },
      };
    }

    if (result.tradeStatus === "PAY_SUCCESS") {
      const settled = await settleMmqrPayment({
        paymentRef: oldRef,
        observedAmount: result.totalAmount === undefined ? null : Number(result.totalAmount),
        observedCurrency: result.transCurrency ?? null,
        mmOrderId: result.mmOrderId ?? null,
        walletIdentifier: result.walletIdentifier ?? null,
        source,
      });

      if (settled.kind === "settled" || settled.kind === "already_settled") {
        return { kind: "done", outcome: { kind: "already_paid" } };
      }
      if (settled.kind === "amount_mismatch" || settled.kind === "currency_mismatch") {
        return { kind: "done", outcome: { kind: "settlement_conflict", reason: settled.kind } };
      }
      // not_found / retryable — real money may be involved, so never fall
      // through to retiring the order.
      return {
        kind: "done",
        outcome: { kind: "blocked", reason: `settlement of ${oldRef} returned ${settled.kind}` },
      };
    }

    // R13: only "the order does not exist" proves KBZPay holds nothing under
    // this reference. Before any close that means precreate never landed
    // (FAILED); after our own close it means we retired it (SUPERSEDED).
    if (result.tradeStatus === "ORDER_NOT_FOUND") {
      return { kind: "done", outcome: { kind: "retire", reason: reasons.notFound } };
    }

    if (TERMINAL_UNPAID.includes(result.tradeStatus)) {
      return { kind: "done", outcome: { kind: "retire", reason: reasons.terminal } };
    }

    // WAIT_PAY / PAYING — including when our own clock said the order was
    // stale (R8). The local hint decides when to ask, never what is true.
    return { kind: "still_payable" };
  }
}
