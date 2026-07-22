import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import type Stripe from "stripe";

const CONFLICT_TYPE = "rejected_enrollment";

async function persistRefundState(conflictObjectId: string, refund: Stripe.Refund): Promise<void> {
  const supabase = createAdminClient();
  const succeeded = refund.status === "succeeded";
  const note = `Automatic refund ${refund.id}: ${refund.status}`;
  const patch = succeeded
    ? { status: "resolved", resolved_at: new Date().toISOString(), resolution_note: note }
    : { resolution_note: note };
  const { data, error } = (await supabase
    .from("payment_settlement_conflicts")
    .update(patch as never)
    .eq("provider", "stripe")
    .eq("provider_object_id", conflictObjectId)
    .eq("conflict_type", CONFLICT_TYPE)
    .select("id")) as unknown as {
    data: { id: string }[] | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`refund reconciliation write failed: ${error.message}`);
  if (data?.length !== 1) throw new Error(`refund reconciliation expected one conflict, found ${data?.length ?? 0}`);
}

/** Automatically returns money that arrived after its enrollment was rejected. */
export async function refundRejectedStripePayment(
  paymentIntentId: string,
  conflictObjectId = paymentIntentId,
): Promise<Stripe.Refund> {
  const refund = await getStripe().refunds.create(
    {
      payment_intent: paymentIntentId,
      metadata: {
        integration_namespace: "eduenroll",
        conflict_type: CONFLICT_TYPE,
        source_payment_intent_id: paymentIntentId,
        conflict_object_id: conflictObjectId,
      },
    },
    { idempotencyKey: `eduenroll:refund:rejected:${paymentIntentId}` },
  );
  await persistRefundState(conflictObjectId, refund);
  return refund;
}

/** Applies the terminal result of an asynchronous PayNow refund. */
export async function reconcileStripeRefund(refund: Stripe.Refund): Promise<void> {
  const conflictObjectId = refund.metadata?.conflict_object_id;
  if (!conflictObjectId || refund.metadata?.integration_namespace !== "eduenroll") return;
  if (refund.metadata?.conflict_type !== CONFLICT_TYPE) return;
  await persistRefundState(conflictObjectId, refund);
}
