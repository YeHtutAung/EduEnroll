// ─── settleCbmmqrPayment ────────────────────────────────────────────────────
// Spec §5.5. Input is ALWAYS a status-check response obtained with the pinned
// merchant's credentials — never callback fields. Order:
//   1. every field check below, with no side effects;
//   2. bind_cbmmqr_settlement, which ties CB's qrReferenceNo and transactionId
//      to this payment under a row lock (a different transaction is refused);
//   3. settleMmqrPayment(), unchanged: snapshot amount check, conditional
//      transition, fulfilment.

import { createAdminClient } from "@/lib/supabase/admin";
import { CB_SUCCESS, type CbMerchant, type StatusResult } from "@/lib/cbmmqr";
import { settleMmqrPayment, type SettleMmqrSource } from "@/server/payments/settleMmqrPayment";

export type CbPaymentIdentity = {
  payment_ref: string;
  payment_method: string | null;
  cbmmqr_merchant: string | null;
};

export type CbSettleOutcome =
  | { kind: "settled" }
  | { kind: "already_settled" }
  /** Money must not move on this answer. Logged; needs a human if it was real. */
  | { kind: "refused"; reason: string }
  /** Could not finish; a retry may. */
  | { kind: "retryable"; reason: string };

export async function settleCbmmqrPayment(input: {
  payment: CbPaymentIdentity;
  merchant: CbMerchant;
  status: StatusResult;
  source: SettleMmqrSource;
}): Promise<CbSettleOutcome> {
  const { payment, merchant, status, source } = input;
  const ref = payment.payment_ref;

  const refuse = (reason: string): CbSettleOutcome => {
    // Merchant id and our reference only; never credentials or CB's token.
    console.error(`[cbmmqr-settle] refused ${ref} (merchant ${merchant.id}): ${reason}`);
    return { kind: "refused", reason };
  };

  if (payment.payment_method !== "cb_mmqr") return refuse("not a cb_mmqr payment");
  if (payment.cbmmqr_merchant !== merchant.id) return refuse("merchant is not the payment's pin");
  if (status.kind !== "answer" || status.code !== CB_SUCCESS) return refuse("status is not success");
  if (status.referenceNo !== ref) return refuse("referenceNo does not match");
  if (status.merchantId !== merchant.merchantId) return refuse("merchantId does not match");
  if (status.currency !== "MMK") return refuse("currency is not 104");
  if (status.amount === null || !Number.isInteger(status.amount)) return refuse("amount is not a whole number");
  if (!status.transactionId) return refuse("no transactionId");
  if (!status.qrReferenceNo) return refuse("no qrReferenceNo");

  const { data, error } = (await createAdminClient().rpc("bind_cbmmqr_settlement", {
    p_payment_ref: ref,
    p_qr_reference_no: status.qrReferenceNo,
    p_transaction_id: status.transactionId,
    p_merchant: merchant.id,
  } as never)) as { data: string | null; error: { message: string } | null };

  if (error) {
    console.error(`[cbmmqr-settle] bind failed for ${ref}: ${error.message}`);
    return { kind: "retryable", reason: "bind failed" };
  }
  if (data !== "bound") return refuse(`bind ${data}`);

  const settled = await settleMmqrPayment({
    paymentRef: ref,
    observedAmount: status.amount,
    observedCurrency: "MMK",
    mmOrderId: status.transactionId,
    walletIdentifier: status.institutionName ?? null,
    source,
  });

  switch (settled.kind) {
    case "settled":
      return { kind: "settled" };
    case "already_settled":
      return { kind: "already_settled" };
    case "amount_mismatch":
    case "currency_mismatch":
      return refuse(settled.kind);
    default:
      return { kind: "retryable", reason: settled.kind };
  }
}
