import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, enrollmentApprovedEmail, enrollmentRejectedEmail } from "@/lib/email";
import type { Enrollment, Payment, PaymentStatus, EnrollmentStatus } from "@/types/database";

type EnrollmentResult = { data: Enrollment | null; error: unknown };
type PaymentResult    = { data: Payment    | null; error: unknown };

// ─── PATCH /api/admin/payments/[id]/verify ────────────────────────────────────
// [id] = payment id
// Body: { action: 'approve' | 'reject', rejection_reason?: string }
//
// approve → payment.status='verified', enrollment.status='confirmed',
//            payment.verified_by + verified_at set
// reject  → payment.status='rejected', enrollment.status='rejected',
//            class.seat_remaining incremented back by 1 (capped at seat_total)

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

  const { action, rejection_reason } = body as Record<string, unknown>;

  if (action !== "approve" && action !== "reject") {
    return badRequest("action must be 'approve' or 'reject'.");
  }
  if (action === "reject" && rejection_reason !== undefined && typeof rejection_reason !== "string") {
    return badRequest("rejection_reason must be a string.");
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
      const host = request.headers.get("host") ?? "localhost:3005";
      const proto = host.startsWith("localhost") ? "http" : "https";
      const statusUrl = `${proto}://${host}/status?ref=${enrollment.enrollment_ref}`;

      const { data: cls2 } = await admin
        .from("classes")
        .select("level")
        .eq("id", enrollment.class_id)
        .single() as { data: { level: string } | null; error: unknown };

      const emailData = enrollmentApprovedEmail({
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel: cls2?.level ?? "",
        statusUrl,
      });

      sendEmail({ to: enrollment.email, ...emailData }).catch((err) => {
        console.error("[verify] Approval email failed:", err);
      });

      // Mark notification sent
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

  // Seat restore is handled by the trg_enrollments_seats trigger
  // when enrollment status changes to 'rejected'.

  // Send rejection email (best-effort, non-blocking)
  if (enrollment.email) {
    const host = request.headers.get("host") ?? "localhost:3005";
    const proto = host.startsWith("localhost") ? "http" : "https";
    const statusUrl = `${proto}://${host}/status?ref=${enrollment.enrollment_ref}`;

    const clsForLevel = await admin
      .from("classes")
      .select("level")
      .eq("id", enrollment.class_id)
      .single() as { data: { level: string } | null; error: unknown };

    const emailData = enrollmentRejectedEmail({
      studentName: enrollment.student_name_en || "Student",
      enrollmentRef: enrollment.enrollment_ref,
      classLevel: clsForLevel.data?.level ?? "",
      reason: typeof rejection_reason === "string" ? rejection_reason : null,
      statusUrl,
    });

    sendEmail({ to: enrollment.email, ...emailData }).catch((err) => {
      console.error("[verify] Rejection email failed:", err);
    });

    // Mark notification sent
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
