import { NextRequest, NextResponse } from "next/server";
import { requireAuth, badRequest, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendEmail,
  enrollmentApprovedEmail,
  enrollmentRejectedEmail,
  partialPaymentEmail,
} from "@/lib/email";
import { sendStatusNotification } from "@/lib/messenger/notify";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";
import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";
import { sendSms } from "@/lib/sms";
import type { Enrollment, Payment } from "@/types/database";
import { verifyPayment } from "@/server/payments/verifyPayment";

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
  // Pre-read raw body for agent requests — HMAC verification requires the raw text.
  // For human requests we parse normally below.
  const isAgentRequest = !!request.headers.get("x-agent-signature");
  const rawBody = isAgentRequest ? await request.text() : undefined;

  const auth = await requireAuth(rawBody ?? "");
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId, user, isAgent, agentChatId } = auth;

  // For audit: human verifiers use verified_by (uuid), agents use verified_by_agent (chat_id)
  const verifiedByHuman = isAgent ? null : user.id;
  const verifiedByAgent = isAgent ? agentChatId : null;

  // ── Parse body ──────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : await request.json();
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

  // Resolve email: column first, then form_data
  const fd = enrollment.form_data as Record<string, string> | null;
  const enrollEmail = enrollment.email || resolveEmailFromFormData(fd);

  const admin = createAdminClient(); // bypasses RLS for class seat update

  // ── Fetch tenant info for email branding ───────────────────────────────────
  const { data: tenantInfo } = await admin
    .from("tenants")
    .select("name, org_type, logo_url, currency, sms_on_payment")
    .eq("id", tenantId)
    .single() as { data: { name: string; org_type: string; logo_url: string | null; currency: string; sms_on_payment: boolean } | null; error: unknown };

  const orgType = tenantInfo?.org_type;
  const tenantName = tenantInfo?.name;
  const logoUrl = tenantInfo?.logo_url ?? undefined;
  const currency = tenantInfo?.currency ?? "MMK";

  // ── Execute verification action (DB writes + seat restoration) ───────────────
  const result = await verifyPayment({
    action,
    payment,
    enrollment,
    tenantId,
    tenantInfo: { currency },
    verifier: { verifiedByHuman, verifiedByAgent },
    rejection_reason: typeof rejection_reason === "string" ? rejection_reason : undefined,
    admin_note: typeof admin_note === "string" ? admin_note : undefined,
    received_amount: typeof received_amount === "number" ? received_amount : undefined,
    requestHost: request.headers.get("host") ?? "localhost:3005",
  });

  const {
    enrollment: updatedEnrollment,
    payment: updatedPayment,
    classLevel,
    statusUrl,
    paymentUrl,
    feeFormatted,
  } = result;

  const now = new Date().toISOString();

  // ── Approve notifications ────────────────────────────────────────────────────
  if (action === "approve") {
    // Messenger notification (if enrolled via chatbot)
    if (enrollment.messenger_psid) {
      sendStatusNotification({
        tenantId,
        messengerPsid: enrollment.messenger_psid,
        action: "approve",
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel,
        statusUrl,
        paymentUrl,
        currency,
      }).catch((err) => {
        console.error("[verify] Messenger approval notification failed:", err);
      });
    }

    // Telegram notification
    if (enrollment.telegram_chat_id) {
      sendTelegramStatusNotification({
        tenantId,
        telegramChatId: enrollment.telegram_chat_id,
        action: "approve",
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel,
        statusUrl,
        paymentUrl,
        currency,
      }).catch((err) => {
        console.error("[verify] Telegram approval notification failed:", err);
      });

      // Auto-send channel invite (language_school only, non-blocking)
      sendChannelInviteIfEligible({
        tenantId,
        enrollmentId: enrollment.id,
        classId: enrollment.class_id,
        telegramChatId: enrollment.telegram_chat_id,
        studentName: enrollment.student_name_en || "Student",
      }).catch((err) => {
        console.error("[verify] Channel invite failed:", err);
      });
    }

    // Email notification
    if (enrollEmail) {
      const emailData = enrollmentApprovedEmail({
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel,
        statusUrl,
        feeFormatted,
        orgType,
        tenantName,
        logoUrl,
      });
      sendEmail({ to: enrollEmail, ...emailData }).catch((err) => {
        console.error("[verify] Approval email failed:", err);
      });
    }

    // SMS notification
    const enrollPhone = enrollment.phone || resolvePhoneFromFormData(fd);
    if (enrollPhone && tenantInfo?.sms_on_payment !== false) {
      const name = enrollment.student_name_en || "Student";
      sendSms({
        to: enrollPhone,
        message: `Hi ${name}, your payment for ${enrollment.enrollment_ref} has been confirmed. Welcome to class!`,
        clientReference: enrollment.enrollment_ref,
      }).catch((err) => {
        console.error("[verify] Approval SMS failed:", err);
      });
    }

    if (enrollment.messenger_psid || enrollEmail) {
      await admin
        .from("enrollments")
        .update({ status_notified_at: now } as never)
        .eq("id", enrollment.id);
    }

    return NextResponse.json({ enrollment: updatedEnrollment, payment: updatedPayment });
  }

  // ── Request Remaining notifications ─────────────────────────────────────────
  if (action === "request_remaining") {
    const remainingAmount = typeof received_amount === "number"
      ? payment.amount - received_amount
      : null;

    // Messenger notification (if enrolled via chatbot)
    if (enrollment.messenger_psid) {
      sendStatusNotification({
        tenantId,
        messengerPsid: enrollment.messenger_psid,
        action: "request_remaining",
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel,
        statusUrl,
        paymentUrl,
        adminNote: (admin_note as string).trim(),
        receivedAmount: typeof received_amount === "number" ? received_amount : null,
        remainingAmount,
        currency,
      }).catch((err) => {
        console.error("[verify] Messenger partial notification failed:", err);
      });
    }

    // Telegram notification
    if (enrollment.telegram_chat_id) {
      sendTelegramStatusNotification({
        tenantId,
        telegramChatId: enrollment.telegram_chat_id,
        action: "request_remaining",
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel,
        statusUrl,
        paymentUrl,
        adminNote: (admin_note as string).trim(),
        receivedAmount: typeof received_amount === "number" ? received_amount : null,
        remainingAmount,
        currency,
      }).catch((err) => {
        console.error("[verify] Telegram partial notification failed:", err);
      });
    }

    // Email notification
    if (enrollEmail) {
      const emailData = partialPaymentEmail({
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel,
        totalAmount: payment.amount,
        receivedAmount: typeof received_amount === "number" ? received_amount : null,
        remainingAmount,
        adminNote: (admin_note as string).trim(),
        paymentUrl,
        statusUrl,
        orgType,
        tenantName,
        logoUrl,
      });
      sendEmail({ to: enrollEmail, ...emailData }).catch((err) => {
        console.error("[verify] Partial payment email failed:", err);
      });
    }

    if (enrollment.messenger_psid || enrollEmail) {
      await admin
        .from("enrollments")
        .update({ status_notified_at: now } as never)
        .eq("id", enrollment.id);
    }

    return NextResponse.json({ enrollment: updatedEnrollment, payment: updatedPayment });
  }

  // ── Reject notifications ─────────────────────────────────────────────────────

  // Messenger notification (if enrolled via chatbot)
  if (enrollment.messenger_psid) {
    sendStatusNotification({
      tenantId,
      messengerPsid: enrollment.messenger_psid,
      action: "reject",
      studentName: enrollment.student_name_en || "Student",
      enrollmentRef: enrollment.enrollment_ref,
      classLevel,
      statusUrl,
      paymentUrl,
      rejectionReason: typeof rejection_reason === "string" ? rejection_reason : null,
      currency,
    }).catch((err) => {
      console.error("[verify] Messenger rejection notification failed:", err);
    });
  }

  // Telegram notification
  if (enrollment.telegram_chat_id) {
    sendTelegramStatusNotification({
      tenantId,
      telegramChatId: enrollment.telegram_chat_id,
      action: "reject",
      studentName: enrollment.student_name_en || "Student",
      enrollmentRef: enrollment.enrollment_ref,
      classLevel,
      statusUrl,
      paymentUrl,
      rejectionReason: typeof rejection_reason === "string" ? rejection_reason : null,
      currency,
    }).catch((err) => {
      console.error("[verify] Telegram rejection notification failed:", err);
    });
  }

  // Email notification
  if (enrollEmail) {
    const emailData = enrollmentRejectedEmail({
      studentName: enrollment.student_name_en || "Student",
      enrollmentRef: enrollment.enrollment_ref,
      classLevel,
      reason: typeof rejection_reason === "string" ? rejection_reason : null,
      statusUrl,
      orgType,
      tenantName,
      logoUrl,
    });
    sendEmail({ to: enrollEmail, ...emailData }).catch((err) => {
      console.error("[verify] Rejection email failed:", err);
    });
  }

  if (enrollment.messenger_psid || enrollEmail) {
    await admin
      .from("enrollments")
      .update({ status_notified_at: now } as never)
      .eq("id", enrollment.id);
  }

  const responseBody: Record<string, unknown> = {
    enrollment: updatedEnrollment,
    payment: updatedPayment,
  };
  if (typeof rejection_reason === "string") responseBody.rejection_reason = rejection_reason;

  return NextResponse.json(responseBody);
}
