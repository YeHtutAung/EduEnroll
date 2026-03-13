import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendEmail,
  enrollmentApprovedEmail,
  enrollmentRejectedEmail,
  partialPaymentEmail,
} from "@/lib/email";
import type { Enrollment, Payment, PaymentStatus, EnrollmentStatus } from "@/types/database";

type EnrollmentResult = { data: Enrollment | null; error: unknown };
type PaymentResult    = { data: Payment    | null; error: unknown };

// ─── PATCH /api/admin/payments/[id]/verify ────────────────────────────────────
// [id] = payment id
// Body: { action: 'approve' | 'reject' | 'request_remaining',
//         rejection_reason?: string,
//         admin_note?: string,
//         received_amount?: number }

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId, user } = auth;

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const { action, rejection_reason, admin_note, received_amount } = body as Record<string, unknown>;

  if (action !== "approve" && action !== "reject" && action !== "request_remaining") {
    return badRequest("action must be 'approve', 'reject', or 'request_remaining'.");
  }
  if (action === "reject" && rejection_reason !== undefined && typeof rejection_reason !== "string") {
    return badRequest("rejection_reason must be a string.");
  }
  if (action === "request_remaining") {
    if (typeof admin_note !== "string" || !admin_note.trim()) {
      return badRequest("admin_note is required for request_remaining.");
    }
    if (received_amount !== undefined && typeof received_amount !== "number") {
      return badRequest("received_amount must be a number.");
    }
  }

  // ── Load payment (scoped to tenant) ─────────────────────────────────────────
  const { data: payment, error: paymentErr } = await supabase
    .from("payments")
    .select("*")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single() as PaymentResult;

  if (paymentErr || !payment) return notFound("Payment");

  if (payment.status !== "pending") {
    return NextResponse.json(
      { error: "Conflict", message: `Payment is already '${payment.status}'.` },
      { status: 409 },
    );
  }

  // ── Load enrollment ──────────────────────────────────────────────────────────
  const { data: enrollment, error: enrollErr } = await supabase
    .from("enrollments")
    .select("*")
    .eq("id", payment.enrollment_id)
    .eq("tenant_id", tenantId)
    .single() as EnrollmentResult;

  if (enrollErr || !enrollment) return notFound("Enrollment");

  const now = new Date().toISOString();
  const admin = createAdminClient(); // bypasses RLS for class seat update

  // ── Helper: get class level + build URLs ────────────────────────────────────
  async function getClassAndUrls() {
    const { data: cls } = await admin
      .from("classes")
      .select("level")
      .eq("id", enrollment!.class_id)
      .single() as { data: { level: string } | null; error: unknown };

    const host = request.headers.get("host") ?? "localhost:3005";
    const proto = host.startsWith("localhost") ? "http" : "https";
    const statusUrl = `${proto}://${host}/status?ref=${enrollment!.enrollment_ref}`;
    const paymentUrl = `${proto}://${host}/enroll/payment/${enrollment!.enrollment_ref}`;

    return { classLevel: cls?.level ?? "", statusUrl, paymentUrl };
  }

  // ── Approve ──────────────────────────────────────────────────────────────────
  if (action === "approve") {
    const newPaymentStatus: PaymentStatus    = "verified";
    const newEnrollStatus: EnrollmentStatus  = "confirmed";

    const { error: pe } = await admin
      .from("payments")
      .update({ status: newPaymentStatus, verified_by: user.id, verified_at: now } as never)
      .eq("id", payment.id);

    if (pe) return NextResponse.json({ error: (pe as Error).message }, { status: 500 });

    const { data: updatedEnrollment, error: ee } = await admin
      .from("enrollments")
      .update({ status: newEnrollStatus } as never)
      .eq("id", enrollment.id)
      .select()
      .single() as EnrollmentResult;

    if (ee) return NextResponse.json({ error: (ee as Error).message }, { status: 500 });

    // Send approval email (best-effort, non-blocking)
    if (enrollment.email) {
      const { classLevel, statusUrl } = await getClassAndUrls();
      const emailData = enrollmentApprovedEmail({
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel,
        statusUrl,
      });
      sendEmail({ to: enrollment.email, ...emailData }).catch((err) => {
        console.error("[verify] Approval email failed:", err);
      });
      await admin
        .from("enrollments")
        .update({ status_notified_at: now } as never)
        .eq("id", enrollment.id);
    }

    return NextResponse.json({
      enrollment: updatedEnrollment,
      payment: { ...payment, status: newPaymentStatus, verified_by: user.id, verified_at: now },
    });
  }

  // ── Request Remaining (partial payment) ────────────────────────────────────
  if (action === "request_remaining") {
    const newEnrollStatus: EnrollmentStatus = "partial_payment";

    // Update payment with admin note and received amount
    const paymentUpdate: Record<string, unknown> = {
      admin_note: (admin_note as string).trim(),
      verified_by: user.id,
      verified_at: now,
    };
    if (typeof received_amount === "number") {
      paymentUpdate.received_amount_mmk = received_amount;
    }

    const { error: pe } = await admin
      .from("payments")
      .update(paymentUpdate as never)
      .eq("id", payment.id);

    if (pe) return NextResponse.json({ error: (pe as Error).message }, { status: 500 });

    const { data: updatedEnrollment, error: ee } = await admin
      .from("enrollments")
      .update({ status: newEnrollStatus } as never)
      .eq("id", enrollment.id)
      .select()
      .single() as EnrollmentResult;

    if (ee) return NextResponse.json({ error: (ee as Error).message }, { status: 500 });

    // Send partial payment email (best-effort, non-blocking)
    if (enrollment.email) {
      const { classLevel, paymentUrl, statusUrl } = await getClassAndUrls();
      const remainingAmount = typeof received_amount === "number"
        ? payment.amount_mmk - received_amount
        : null;

      const emailData = partialPaymentEmail({
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel,
        totalAmount: payment.amount_mmk,
        receivedAmount: typeof received_amount === "number" ? received_amount : null,
        remainingAmount,
        adminNote: (admin_note as string).trim(),
        paymentUrl,
        statusUrl,
      });
      sendEmail({ to: enrollment.email, ...emailData }).catch((err) => {
        console.error("[verify] Partial payment email failed:", err);
      });
      await admin
        .from("enrollments")
        .update({ status_notified_at: now } as never)
        .eq("id", enrollment.id);
    }

    return NextResponse.json({
      enrollment: updatedEnrollment,
      payment: { ...payment, ...paymentUpdate },
    });
  }

  // ── Reject ───────────────────────────────────────────────────────────────────
  const newPaymentStatus: PaymentStatus   = "rejected";
  const newEnrollStatus: EnrollmentStatus = "rejected";

  const { error: pe } = await admin
    .from("payments")
    .update({ status: newPaymentStatus, verified_by: user.id, verified_at: now } as never)
    .eq("id", payment.id);

  if (pe) return NextResponse.json({ error: (pe as Error).message }, { status: 500 });

  const enrollUpdatePayload: Record<string, unknown> = { status: newEnrollStatus };
  if (typeof rejection_reason === "string") {
    enrollUpdatePayload.rejection_reason = rejection_reason;
  }

  const { data: updatedEnrollment, error: ee } = await admin
    .from("enrollments")
    .update(enrollUpdatePayload as never)
    .eq("id", enrollment.id)
    .select()
    .single() as EnrollmentResult;

  if (ee) return NextResponse.json({ error: (ee as Error).message }, { status: 500 });

  // Send rejection email (best-effort, non-blocking)
  if (enrollment.email) {
    const { classLevel, statusUrl } = await getClassAndUrls();
    const emailData = enrollmentRejectedEmail({
      studentName: enrollment.student_name_en || "Student",
      enrollmentRef: enrollment.enrollment_ref,
      classLevel,
      reason: typeof rejection_reason === "string" ? rejection_reason : null,
      statusUrl,
    });
    sendEmail({ to: enrollment.email, ...emailData }).catch((err) => {
      console.error("[verify] Rejection email failed:", err);
    });
    await admin
      .from("enrollments")
      .update({ status_notified_at: now } as never)
      .eq("id", enrollment.id);
  }

  const responseBody: Record<string, unknown> = {
    enrollment: updatedEnrollment,
    payment: { ...payment, status: newPaymentStatus, verified_by: user.id, verified_at: now },
  };
  if (typeof rejection_reason === "string") responseBody.rejection_reason = rejection_reason;

  return NextResponse.json(responseBody);
}
