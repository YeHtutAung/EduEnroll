import { createAdminClient } from "@/lib/supabase/admin";

export type StripeAttemptEligibility =
  | { kind: "eligible"; enrollmentId: string; paymentId: string }
  | { kind: "not_found" }
  | { kind: "ineligible" }
  | { kind: "retryable"; reason: string };

/**
 * Revalidates the database immediately before a client confirms an existing
 * PaymentIntent. This is intentionally stricter than merely checking that the
 * enrollment exists: the attempt must belong to that enrollment and tenant,
 * and both records must still be active.
 */
export async function validateStripeAttempt(input: {
  tenantId: string;
  enrollmentRef: string;
  paymentIntentId: string;
}): Promise<StripeAttemptEligibility> {
  const supabase = createAdminClient();
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("id, status")
    .eq("enrollment_ref", input.enrollmentRef.trim())
    .eq("tenant_id", input.tenantId)
    .maybeSingle()) as {
    data: { id: string; status: string } | null;
    error: { message: string } | null;
  };
  if (enrollmentError) return { kind: "retryable", reason: enrollmentError.message };
  if (!enrollment) return { kind: "not_found" };
  if (enrollment.status !== "pending_payment") return { kind: "ineligible" };

  const { data: payment, error: paymentError } = (await supabase
    .from("payments")
    .select("id, status")
    .eq("stripe_payment_intent_id", input.paymentIntentId)
    .eq("enrollment_id", enrollment.id)
    .eq("tenant_id", input.tenantId)
    .in("status", ["awaiting_payment", "pending"])
    .maybeSingle()) as {
    data: { id: string; status: string } | null;
    error: { message: string } | null;
  };
  if (paymentError) return { kind: "retryable", reason: paymentError.message };
  if (!payment) return { kind: "ineligible" };
  return { kind: "eligible", enrollmentId: enrollment.id, paymentId: payment.id };
}
