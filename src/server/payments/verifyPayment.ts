import { createAdminClient } from "@/lib/supabase/admin";
import { tenantOrigin } from "@/lib/origin";
import { issueTicketsForEnrollment } from "@/server/tickets/issueTickets";
import type { Enrollment, Payment, PaymentStatus, EnrollmentStatus } from "@/types/database";

interface VerifierContext {
  verifiedByHuman: string | null;
  verifiedByAgent: number | null;
}

interface TenantContext {
  currency: string;
  subdomain: string | null;
}

export interface VerifyPaymentInput {
  action: "approve" | "reject" | "request_remaining";
  payment: Payment;
  enrollment: Enrollment;
  tenantId: string;
  tenantInfo: TenantContext;
  verifier: VerifierContext;
  rejection_reason?: string;
  admin_note?: string;
  received_amount?: number;
}

export interface VerifyPaymentResult {
  enrollment: Enrollment;
  payment: Partial<Payment>;
  rejection_reason?: string;
  classLevel: string;
  statusUrl: string;
  paymentUrl: string;
  feeFormatted?: string;
}

/**
 * Executes a payment verification action (approve / reject / request_remaining).
 * Updates payment and enrollment records in Supabase.
 * Does NOT send notifications — the calling route handles that.
 */
export async function verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
  const {
    action, payment, enrollment, tenantInfo, verifier,
    rejection_reason, admin_note, received_amount,
  } = input;

  const admin = createAdminClient();
  const now = new Date().toISOString();
  const base = tenantOrigin(tenantInfo.subdomain);
  const statusUrl = `${base}/status?ref=${enrollment.enrollment_ref}`;
  const paymentUrl = `${base}/enroll/payment/${enrollment.enrollment_ref}`;

  // ── Resolve class level and fee ─────────────────────────────────────────────
  const isCart = enrollment.class_id === null;
  let classLevel = "";
  let totalFee = 0;

  if (isCart) {
    const { data: items } = await admin
      .from("enrollment_items")
      .select("quantity, fee_amount, classes(level)")
      .eq("enrollment_id", enrollment.id) as {
      data: { quantity: number; fee_amount: number; classes: { level: string } | null }[] | null;
      error: unknown;
    };
    if (items && items.length > 0) {
      classLevel = items
        .map((i) => i.quantity > 1 ? `${i.classes?.level ?? "?"} x${i.quantity}` : (i.classes?.level ?? "?"))
        .join(", ");
      totalFee = items.reduce((sum, i) => sum + i.fee_amount * i.quantity, 0);
    }
  } else {
    const { data: cls } = await admin
      .from("classes")
      .select("level, fee_amount")
      .eq("id", enrollment.class_id!)
      .single() as { data: { level: string; fee_amount: number } | null; error: unknown };
    classLevel = cls?.level ?? "";
    totalFee = (cls?.fee_amount ?? 0) * (enrollment.quantity ?? 1);
  }

  const feeFormatted = totalFee > 0
    ? `${String(totalFee).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${tenantInfo.currency}`
    : undefined;

  // ── Approve ─────────────────────────────────────────────────────────────────
  if (action === "approve") {
    await admin
      .from("payments")
      .update({
        status: "verified" as PaymentStatus,
        verified_by: verifier.verifiedByHuman,
        verified_by_agent: verifier.verifiedByAgent,
        verified_at: now,
      } as never)
      .eq("id", payment.id);

    const { data: updatedEnrollment, error: enrollmentUpdateError } = await admin
      .from("enrollments")
      .update({ status: "confirmed" as EnrollmentStatus } as never)
      .eq("id", enrollment.id)
      .select()
      .single() as { data: Enrollment | null; error: unknown };

    if (!enrollmentUpdateError) {
      try {
        await issueTicketsForEnrollment(enrollment.id);
      } catch (err) {
        console.error("[tickets] issueTicketsForEnrollment failed:", err);
      }
    }

    return {
      enrollment: updatedEnrollment ?? enrollment,
      payment: {
        ...payment,
        status: "verified" as PaymentStatus,
        verified_by: verifier.verifiedByHuman,
        verified_by_agent: verifier.verifiedByAgent,
        verified_at: now,
      },
      classLevel,
      statusUrl,
      paymentUrl,
      feeFormatted,
    };
  }

  // ── Request Remaining ────────────────────────────────────────────────────────
  if (action === "request_remaining") {
    const paymentUpdate: Record<string, unknown> = {
      admin_note: admin_note!.trim(),
      verified_by: verifier.verifiedByHuman,
      verified_at: now,
    };
    if (typeof received_amount === "number") {
      paymentUpdate.received_amount = received_amount;
    }

    await admin
      .from("payments")
      .update(paymentUpdate as never)
      .eq("id", payment.id);

    const { data: updatedEnrollment } = await admin
      .from("enrollments")
      .update({ status: "partial_payment" as EnrollmentStatus } as never)
      .eq("id", enrollment.id)
      .select()
      .single() as { data: Enrollment | null; error: unknown };

    return {
      enrollment: updatedEnrollment ?? enrollment,
      payment: { ...payment, ...paymentUpdate },
      classLevel,
      statusUrl,
      paymentUrl,
      feeFormatted,
    };
  }

  // ── Reject ───────────────────────────────────────────────────────────────────
  await admin
    .from("payments")
    .update({
      status: "rejected" as PaymentStatus,
      verified_by: verifier.verifiedByHuman,
      verified_by_agent: verifier.verifiedByAgent,
      verified_at: now,
    } as never)
    .eq("id", payment.id);

  const enrollUpdatePayload: Record<string, unknown> = { status: "rejected" as EnrollmentStatus };
  if (typeof rejection_reason === "string") {
    enrollUpdatePayload.rejection_reason = rejection_reason;
  }

  const { data: updatedEnrollment } = await admin
    .from("enrollments")
    .update(enrollUpdatePayload as never)
    .eq("id", enrollment.id)
    .select()
    .single() as { data: Enrollment | null; error: unknown };

  // Seats are restored by the status trigger, which fires on the enrollment
  // update above. This route used to call restoreSeats() as well, restoring
  // twice — the guard read the pre-update snapshot, so it passed in exactly
  // the case where the trigger had just fired.

  return {
    enrollment: updatedEnrollment ?? enrollment,
    payment: {
      ...payment,
      status: "rejected" as PaymentStatus,
      verified_by: verifier.verifiedByHuman,
      verified_by_agent: verifier.verifiedByAgent,
      verified_at: now,
    },
    rejection_reason: typeof rejection_reason === "string" ? rejection_reason : undefined,
    classLevel,
    statusUrl,
    paymentUrl,
    feeFormatted,
  };
}
