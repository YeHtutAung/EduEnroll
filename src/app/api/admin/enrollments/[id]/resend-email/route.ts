import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { tenantOrigin } from "@/lib/origin";
import {
  sendEmail,
  enrollmentApprovedEmail,
  enrollmentRejectedEmail,
  partialPaymentEmail,
  enrollmentConfirmationEmail,
} from "@/lib/email";
import { resolveEmailFromFormData } from "@/lib/utils";
import type { Enrollment, Payment } from "@/types/database";

type EnrollmentResult = { data: Enrollment | null; error: unknown };
type PaymentResult = { data: Payment | null; error: unknown };

// ─── POST /api/admin/enrollments/[id]/resend-email ─────────────────────────
// Resend the last status email to the enrollment's email address.
// Body: { email?: string } — optional override email address

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  // ── Parse optional body ──────────────────────────────────────────────────
  let overrideEmail: string | null = null;
  try {
    const body = await request.json();
    if (body.email && typeof body.email === "string") {
      overrideEmail = body.email.trim();
    }
  } catch {
    // No body is fine — we'll use the enrollment's email
  }

  // ── Load enrollment ────────────────────────────────────────────────────────
  const { data: enrollment, error: enrollErr } = await supabase
    .from("enrollments")
    .select("*")
    .eq("id", params.id)
    .eq("tenant_id", tenantId)
    .single() as EnrollmentResult;

  if (enrollErr || !enrollment) return notFound("Enrollment");

  // Resolve email: override > column > form_data
  const fd = enrollment.form_data as Record<string, string> | null;
  const enrollEmail = overrideEmail || enrollment.email || resolveEmailFromFormData(fd);

  if (!enrollEmail) {
    return badRequest("No email address found for this enrollment. Provide one in the request body.");
  }

  const admin = createAdminClient();

  // ── Fetch tenant info for email branding ──────────────────────────────────
  const { data: tenantInfo } = await admin
    .from("tenants")
    .select("name, org_type, logo_url, subdomain")
    .eq("id", tenantId)
    .single() as {
    data: { name: string; org_type: string; logo_url: string | null; subdomain: string | null } | null;
    error: unknown;
  };

  const orgType = tenantInfo?.org_type;
  const tenantName = tenantInfo?.name;
  const logoUrl = tenantInfo?.logo_url ?? undefined;

  // ── Get class level + URLs ────────────────────────────────────────────────
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
        .map((i) =>
          i.quantity > 1
            ? `${i.classes?.level ?? "?"} x${i.quantity}`
            : (i.classes?.level ?? "?"),
        )
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

  const base = tenantOrigin(tenantInfo?.subdomain);
  const statusUrl = `${base}/status?ref=${enrollment.enrollment_ref}`;
  const paymentUrl = `${base}/enroll/payment/${enrollment.enrollment_ref}`;
  const feeFormatted =
    totalFee > 0
      ? `${String(totalFee).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} MMK`
      : undefined;

  // ── Pick the right email template based on enrollment status ──────────────
  let emailContent: { subject: string; html: string };
  const status = enrollment.status;

  if (status === "confirmed") {
    emailContent = enrollmentApprovedEmail({
      studentName: enrollment.student_name_en,
      enrollmentRef: enrollment.enrollment_ref,
      classLevel,
      statusUrl,
      feeFormatted,
      orgType,
      tenantName,
      logoUrl,
    });
  } else if (status === "rejected") {
    emailContent = enrollmentRejectedEmail({
      studentName: enrollment.student_name_en,
      enrollmentRef: enrollment.enrollment_ref,
      classLevel,
      reason: (enrollment as unknown as Record<string, unknown>).rejection_reason as string | null,
      statusUrl,
      orgType,
      tenantName,
      logoUrl,
    });
  } else if (status === "partial_payment") {
    // Load latest payment for amounts
    const { data: payment } = await supabase
      .from("payments")
      .select("*")
      .eq("enrollment_id", enrollment.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single() as PaymentResult;

    const receivedAmount = (payment as unknown as Record<string, unknown>)?.received_amount as number | null;
    const adminNote = (payment as unknown as Record<string, unknown>)?.admin_note as string | null;
    const remainingAmount =
      receivedAmount != null && payment?.amount != null
        ? payment.amount - receivedAmount
        : null;

    emailContent = partialPaymentEmail({
      studentName: enrollment.student_name_en,
      enrollmentRef: enrollment.enrollment_ref,
      classLevel,
      totalAmount: totalFee,
      receivedAmount,
      remainingAmount,
      adminNote: adminNote ?? "",
      paymentUrl,
      statusUrl,
      orgType,
      tenantName,
      logoUrl,
    });
  } else {
    // pending_payment or payment_submitted — send confirmation email
    emailContent = enrollmentConfirmationEmail({
      studentName: enrollment.student_name_en,
      enrollmentRef: enrollment.enrollment_ref,
      classLevel,
      feeAmount: totalFee,
      feeFormatted: feeFormatted ?? "",
      paymentUrl,
      statusUrl,
      orgType,
      tenantName,
      logoUrl,
    });
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  const sent = await sendEmail({
    to: enrollEmail,
    subject: emailContent.subject,
    html: emailContent.html,
  });

  if (!sent) {
    return NextResponse.json(
      { error: "Email send failed. Check server logs." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: `Email resent to ${enrollEmail}`,
    status: enrollment.status,
  });
}
