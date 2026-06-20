// ─── Shared payment success notification helper ─────────────────────────────
// Used by PayPay status polling and webhook routes.
// Same notification pattern as abank/status and mmpay/webhook.

import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";
import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";
import { sendSms } from "@/lib/sms";

export async function sendPaymentNotifications(
  supabase: ReturnType<typeof createAdminClient>,
  payment: { id: string; enrollment_id: string },
  request: NextRequest,
) {
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("tenant_id, telegram_chat_id, email, phone, enrollment_ref, student_name_en, class_id, quantity, form_data")
    .eq("id", payment.enrollment_id)
    .single()) as {
    data: {
      tenant_id: string;
      telegram_chat_id: string | null;
      email: string | null;
      phone: string | null;
      enrollment_ref: string;
      student_name_en: string;
      class_id: string | null;
      quantity: number | null;
      form_data: Record<string, string> | null;
    } | null;
    error: unknown;
  };

  if (!enrollment) return;

  const enrollEmail = enrollment.email
    || resolveEmailFromFormData(enrollment.form_data as Record<string, string> | null);
  const host = request.headers.get("host") ?? "localhost:3005";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const statusUrl = `${proto}://${host}/status?ref=${enrollment.enrollment_ref}`;

  // Resolve class level
  let classLevel = "Ticket";
  let feeFormatted: string | undefined;
  const isCart = enrollment.class_id === null;

  if (isCart) {
    const { data: items } = (await supabase
      .from("enrollment_items")
      .select("quantity, fee_amount, classes(level)")
      .eq("enrollment_id", payment.enrollment_id)) as {
      data: { quantity: number; fee_amount: number; classes: { level: string } | null }[] | null;
      error: unknown;
    };
    if (items && items.length > 0) {
      classLevel = items
        .map((i) => (i.quantity > 1 ? `${i.classes?.level ?? "?"} x${i.quantity}` : (i.classes?.level ?? "?")))
        .join(", ");
      const total = items.reduce((s, i) => s + i.fee_amount * i.quantity, 0);
      feeFormatted = String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
  } else {
    const { data: cls } = (await supabase
      .from("classes")
      .select("level, fee_amount")
      .eq("id", enrollment.class_id!)
      .single()) as { data: { level: string; fee_amount: number } | null; error: unknown };
    if (cls) {
      classLevel = cls.level;
      const total = cls.fee_amount * (enrollment.quantity ?? 1);
      feeFormatted = String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
  }

  // Fetch tenant info
  const { data: tenantInfo } = (await supabase
    .from("tenants")
    .select("name, org_type, logo_url, currency, sms_on_payment")
    .eq("id", enrollment.tenant_id)
    .single()) as {
    data: { name: string; org_type: string; logo_url: string | null; currency: string; sms_on_payment: boolean } | null;
    error: unknown;
  };
  const tenantCurrency = tenantInfo?.currency ?? "JPY";
  if (feeFormatted) feeFormatted = `${feeFormatted} ${tenantCurrency}`;

  const notifyTasks: Promise<unknown>[] = [];

  // Telegram notification
  if (enrollment.telegram_chat_id) {
    notifyTasks.push(
      sendTelegramStatusNotification({
        tenantId: enrollment.tenant_id,
        telegramChatId: enrollment.telegram_chat_id,
        action: "approve",
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel,
        statusUrl,
        paymentUrl: statusUrl,
        currency: tenantCurrency,
      }).catch((err) => {
        console.error("[paypay] Telegram notification failed:", err);
      }),
    );
  }

  // Email notification
  if (enrollEmail) {
    const emailData = enrollmentApprovedEmail({
      studentName: enrollment.student_name_en || "Student",
      enrollmentRef: enrollment.enrollment_ref,
      classLevel,
      statusUrl,
      feeFormatted,
      orgType: tenantInfo?.org_type,
      tenantName: tenantInfo?.name,
      logoUrl: tenantInfo?.logo_url ?? undefined,
    });
    notifyTasks.push(
      sendEmail({ to: enrollEmail, ...emailData }).catch((err) => {
        console.error("[paypay] Approval email failed:", err);
      }),
    );
  }

  // SMS notification
  const enrollPhone = enrollment.phone
    || resolvePhoneFromFormData(enrollment.form_data as Record<string, string> | null);
  if (enrollPhone && tenantInfo?.sms_on_payment !== false) {
    const name = enrollment.student_name_en || "Student";
    notifyTasks.push(
      sendSms({
        to: enrollPhone,
        message: `Hi ${name}, your payment for ${enrollment.enrollment_ref} has been confirmed. Welcome to class!`,
        clientReference: enrollment.enrollment_ref,
      }).catch((err) => {
        console.error("[paypay] Approval SMS failed:", err);
      }),
    );
  }

  // Channel invite
  if (enrollment.telegram_chat_id) {
    notifyTasks.push(
      sendChannelInviteIfEligible({
        tenantId: enrollment.tenant_id,
        enrollmentId: payment.enrollment_id,
        classId: enrollment.class_id,
        telegramChatId: enrollment.telegram_chat_id,
        studentName: enrollment.student_name_en || "Student",
      }).catch((err) => {
        console.error("[paypay] Channel invite failed:", err);
      }),
    );
  }

  await Promise.allSettled(notifyTasks);
}
