// ─── resolveCbmmqrOrder ─────────────────────────────────────────────────────
// Spec §5.2. Called for a live CB row the create route cannot simply re-serve
// (amount changed, QR missing, or past its stored expiry). CB has no close
// call, so — unlike resolveKbzpayOrder — this never makes an order dead; it
// can only find out that CB says it is.

import { checkStatus, type CbMerchant, type CallBudget, type StatusResult, CB_SUCCESS } from "@/lib/cbmmqr";
import { settleCbmmqrPayment } from "@/server/payments/settleCbmmqrPayment";
import type { SettleMmqrSource } from "@/server/payments/settleMmqrPayment";
import { CB_EXPIRY_MARGIN_MINUTES, CB_MAX_QR_MINUTES } from "@/server/payments/cbmmqrOrderWindow";

const MIN = 60_000;

/**
 * Status codes CB has confirmed IN WRITING to be final and unpaid: no
 * in-flight or later payment can settle. EMPTY until gate G1 — so until then a
 * QR that was displayed is never replaced. Add a code only with CB's written
 * confirmation and a UAT run that reproduces it, in a reviewed change.
 */
export const CB_CONFIRMED_DEAD_CODES: ReadonlySet<string> = new Set<string>();

/** The only test allowed to free the slot of a QR that was displayed. */
export function isConfirmedDead(status: StatusResult, expiresAtMs: number | null, now: number): boolean {
  if (status.kind !== "answer" || !CB_CONFIRMED_DEAD_CODES.has(status.code)) return false;
  if (expiresAtMs === null) return false;
  return now > expiresAtMs + CB_EXPIRY_MARGIN_MINUTES * MIN;
}

export type CbResolveOutcome =
  | { kind: "already_paid" }
  | { kind: "settlement_conflict"; reason: string }
  | { kind: "retire"; reason: "EXPIRED" | "FAILED" }
  /** Still possibly payable: tell the buyer to wait until retryAtMs. */
  | { kind: "active"; retryAtMs: number }
  | { kind: "blocked"; reason: string };

export async function resolveCbmmqrOrder(input: {
  row: {
    ref: string;
    orderRef: string | null;
    expiresAtMs: number | null;
    createdAtMs: number;
    /** A QR payload for this row was stored, so it may have been shown to a buyer. */
    displayed: boolean;
  };
  /** The merchant pinned on THIS row — never the tenant's current assignment. */
  merchant: CbMerchant;
  source: SettleMmqrSource;
  budget?: CallBudget;
  now?: number;
}): Promise<CbResolveOutcome> {
  const { row, merchant, source, budget } = input;
  const now = input.now ?? Date.now();
  const margin = CB_EXPIRY_MARGIN_MINUTES * MIN;

  // Where CB gave us its reference, ask CB first: a QR we never displayed can
  // still have been paid (a lost response, or one paid between CB's answer and
  // our post-check), and that money must be settled, never stranded.
  // With no reference there is nothing to ask (unchanged: no status call).
  let status: StatusResult | null = null;
  if (row.orderRef) {
    status = await checkStatus(merchant, row.orderRef, budget);

    if (status.kind === "answer" && status.code === CB_SUCCESS) {
      const settled = await settleCbmmqrPayment({
        payment: { payment_ref: row.ref, payment_method: "cb_mmqr", cbmmqr_merchant: merchant.id },
        merchant,
        status,
        source,
      });
      if (settled.kind === "settled" || settled.kind === "already_settled") return { kind: "already_paid" };
      if (settled.kind === "refused") return { kind: "settlement_conflict", reason: settled.reason };
      return { kind: "blocked", reason: settled.reason };
    }
  }

  // NEVER DISPLAYED: we hold no QR payload for this row, so no buyer was ever
  // shown it and nobody can scan it. Two ways to get here:
  //   - CB's create response was lost (no provider_order_ref, no QR);
  //   - CB answered but the post-check withheld the QR because it would have
  //     outlived the enrollment (§5.1 step 7: reference stored, QR not).
  // Both free the slot on elapsed time — the ONE documented exception to
  // "never free a slot on elapsed time" (spec §5.2; disputed by Codex in two
  // reviews and kept deliberately — holding the slot would block the buyer for
  // good). If a callback arrives meanwhile, the bind sets bank_reference and
  // complete_cbmmqr_replace refuses with 'settling'. Idempotent re-create with
  // the same reference (spec §5.2) is NOT built: it waits for CB's answer to
  // question 3.
  if (!row.orderRef || !row.displayed) {
    const freeAt = row.createdAtMs + CB_MAX_QR_MINUTES * MIN + margin;
    return now > freeAt ? { kind: "retire", reason: "FAILED" } : { kind: "active", retryAtMs: freeAt };
  }

  // DISPLAYED: only CB's confirmed-final answer may free it (gate G1).
  if (status && isConfirmedDead(status, row.expiresAtMs, now)) return { kind: "retire", reason: "EXPIRED" };

  return { kind: "active", retryAtMs: Math.max(row.expiresAtMs ?? now, now) + margin };
}
