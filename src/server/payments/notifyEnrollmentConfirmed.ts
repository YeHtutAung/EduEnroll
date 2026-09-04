import { createAdminClient } from "@/lib/supabase/admin";
import { tenantOrigin } from "@/lib/origin";
import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";
import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";
import { sendSms } from "@/lib/sms";
import { buildEticketEmailAttachment } from "@/server/tickets/eticketEmailAttachment";

/**
 * Best-effort customer notifications for the single settlement-transition
 * winner. Every transport handles its own failure so a delivered payment and
 * ticket are never rolled back because an external notification provider is
 * unavailable.
 */
export async function notifyEnrollmentConfirmed(enrollmentId: string): Promise<void> {
  const supabase = createAdminClient();

  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select(
      "tenant_id, telegram_chat_id, email, phone, enrollment_ref, student_name_en, class_id, quantity, form_data",
    )
    .eq("id", enrollmentId)
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
    error: { message?: string } | null;
  };
  if (enrollmentError || !enrollment) {
    console.error(
      "[payment-notify] enrollment lookup failed:",
      enrollmentError?.message ?? "not found",
    );
    return;
  }

  const enrollEmail = enrollment.email || resolveEmailFromFormData(enrollment.form_data);

  let classLevel = "Class";
  let feeFormatted: string | undefined;
  let ticketCount: number | undefined;
  const isCart = enrollment.class_id === null;

  if (isCart) {
    const { data: items, error: itemsError } = (await supabase
      .from("enrollment_items")
      .select("quantity, fee_amount, classes(level)")
      .eq("enrollment_id", enrollmentId)) as {
      data: { quantity: number; fee_amount: number; classes: { level: string } | null }[] | null;
      error: { message?: string } | null;
    };
    if (itemsError) console.error("[payment-notify] item lookup failed:", itemsError.message);
    if (items?.length) {
      classLevel = items
        .map((i) =>
          i.quantity > 1 ? `${i.classes?.level ?? "?"} x${i.quantity}` : (i.classes?.level ?? "?"),
        )
        .join(", ");
      const total = items.reduce((sum, item) => sum + item.fee_amount * item.quantity, 0);
      feeFormatted = String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      ticketCount = items.reduce((sum, item) => sum + item.quantity, 0);
    }
  } else {
    const { data: cls, error: classError } = (await supabase
      .from("classes")
      .select("level, fee_amount")
      .eq("id", enrollment.class_id!)
      .single()) as {
      data: { level: string; fee_amount: number } | null;
      error: { message?: string } | null;
    };
    if (classError) console.error("[payment-notify] class lookup failed:", classError.message);
    if (cls) {
      classLevel = cls.level;
      const total = cls.fee_amount * (enrollment.quantity ?? 1);
      feeFormatted = String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      ticketCount = enrollment.quantity ?? 1;
    }
  }

  const { data: tenantInfo, error: tenantError } = (await supabase
    .from("tenants")
    .select("name, org_type, logo_url, currency, sms_on_payment, subdomain")
    .eq("id", enrollment.tenant_id)
    .single()) as {
    data: {
      name: string;
      org_type: string;
      logo_url: string | null;
      currency: string;
      sms_on_payment: boolean;
      subdomain: string | null;
    } | null;
    error: { message?: string } | null;
  };
  if (tenantError) console.error("[payment-notify] tenant lookup failed:", tenantError.message);
  if (feeFormatted && tenantInfo?.currency) feeFormatted = `${feeFormatted} ${tenantInfo.currency}`;

  // Student links must be on the tenant's host so the public status API can
  // resolve the school. The platform root (including www.kuunyi.com) has no
  // tenant context and returns "Tenant could not be determined."
  const statusUrl = `${tenantOrigin(tenantInfo?.subdomain)}/status?ref=${enrollment.enrollment_ref}`;

  const tasks: Promise<unknown>[] = [];
  if (enrollment.telegram_chat_id) {
    tasks.push(
      sendTelegramStatusNotification({
        tenantId: enrollment.tenant_id,
        telegramChatId: enrollment.telegram_chat_id,
        action: "approve",
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel,
        statusUrl,
        paymentUrl: statusUrl,
        currency: tenantInfo?.currency ?? "MMK",
      }).catch((error) => console.error("[payment-notify] Telegram failed:", error)),
    );
  }

  if (enrollEmail) {
    let ticketSubtotalFormatted: string | undefined;
    let platformFeeFormatted: string | undefined;
    let totalPaidFormatted: string | undefined;

    try {
      const { data: payment, error: paymentError } = (await supabase
        .from("payments")
        .select("amount, platform_fee")
        .eq("enrollment_id", enrollmentId)
        .eq("status", "verified")
        // attempt_seq is only unique per enrollment attempt, so more than one
        // verified row can exist. Describe the settlement that happened last;
        // legacy verified rows without paid_at sort last, then created_at
        // provides a deterministic tie-break for identical paid_at values.
        .order("paid_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()) as {
        data: { amount: number | null; platform_fee: number | null } | null;
        error: { message?: string } | null;
      };

      if (paymentError) {
        console.error("[payment-notify] settled payment lookup failed:", paymentError.message);
      } else if (payment && payment.amount != null && payment.platform_fee != null && feeFormatted) {
        const currency = tenantInfo?.currency ?? "MMK";
        ticketSubtotalFormatted = feeFormatted;
        platformFeeFormatted = payment.platform_fee > 0
          ? `${String(payment.platform_fee).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${currency}`
          : "No fee";
        totalPaidFormatted = `${String(payment.amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${currency}`;
      }
    } catch (error) {
      console.error("[payment-notify] settled payment lookup failed:", error);
    }

    const email = enrollmentApprovedEmail({
      studentName: enrollment.student_name_en || "Student",
      enrollmentRef: enrollment.enrollment_ref,
      classLevel,
      statusUrl,
      feeFormatted,
      ticketSubtotalFormatted,
      platformFeeFormatted,
      totalPaidFormatted,
      ticketCount,
      orgType: tenantInfo?.org_type,
      tenantName: tenantInfo?.name,
      logoUrl: tenantInfo?.logo_url ?? undefined,
    });
    const attachment = await buildEticketEmailAttachment(enrollmentId).catch((error) => {
      console.error("[payment-notify] e-ticket attachment failed:", error);
      return null;
    });
    tasks.push(
      sendEmail({
        to: enrollEmail,
        ...email,
        ...(attachment ? { attachments: [attachment] } : {}),
      }).catch((error) =>
        console.error("[payment-notify] email failed:", error),
      ),
    );
  }

  const enrollPhone = enrollment.phone || resolvePhoneFromFormData(enrollment.form_data);
  if (enrollPhone && tenantInfo?.sms_on_payment !== false) {
    tasks.push(
      sendSms({
        to: enrollPhone,
        message: `Hi ${enrollment.student_name_en || "Student"}, your payment for ${enrollment.enrollment_ref} has been confirmed. Welcome to class!`,
        clientReference: enrollment.enrollment_ref,
      }).catch((error) => console.error("[payment-notify] SMS failed:", error)),
    );
  }

  if (enrollment.telegram_chat_id) {
    tasks.push(
      sendChannelInviteIfEligible({
        tenantId: enrollment.tenant_id,
        enrollmentId,
        classId: enrollment.class_id,
        telegramChatId: enrollment.telegram_chat_id,
        studentName: enrollment.student_name_en || "Student",
      }).catch((error) => console.error("[payment-notify] channel invite failed:", error)),
    );
  }

  await Promise.allSettled(tasks);
}
