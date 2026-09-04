import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import abank from "@/lib/abank";
import { issueTicketsForEnrollment } from "@/server/tickets/issueTickets";
import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";
import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";
import { sendSms } from "@/lib/sms";
import { buildEticketEmailAttachment } from "@/server/tickets/eticketEmailAttachment";

// ─── GET /api/webhooks/abank ────────────────────────────────
// ABank calls this URL (GET) after payment completes.
// Success params: orderId, amount, status, transactionId, billNo,
//                 endToEndId, transactionDateTime, institutionName
// Fail adds: errorCode, errorDesc

export async function GET(request: NextRequest) {
  const params = abank.parseCallback(request.nextUrl.searchParams);

  if (!params.orderId) {
    return NextResponse.json({ error: "Missing orderId" }, { status: 400 });
  }

  // Bounded: every param here is unauthenticated caller input, so log a
  // correlation id and nothing else. The authoritative verdict is logged below.
  console.log("[abank-callback] orderId=%s", params.orderId.slice(0, 32));

  const supabase = createAdminClient();

  // ── Find payment by payment_ref ───────────────────────────
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, status, amount")
    .eq("payment_ref", params.orderId)
    .single()) as {
    data: { id: string; enrollment_id: string; status: string; amount: number } | null;
    error: unknown;
  };

  if (!payment) {
    console.warn("[abank-callback] Payment not found for orderId:", params.orderId);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  // Skip if already finalized
  if (payment.status === "verified" || payment.status === "rejected") {
    return NextResponse.json({ message: "Already processed" }, { status: 200 });
  }

  // ── Confirm with ABank before trusting the callback ───────
  // This endpoint is a public, unauthenticated GET, and the orderId is handed
  // to the student when the QR is created — so a forged
  //   ?orderId=<theirs>&status=SUCCESS
  // must never confirm anything. Ask ABank directly instead, the same way the
  // status poller does (src/app/api/public/payments/abank/status/route.ts).
  // Callback params stay usable for logging and cosmetic fields, never to gate.
  let enquiry;
  try {
    enquiry = await abank.enquiryOrder(params.orderId);
  } catch (err) {
    console.error("[abank-callback] Enquiry failed for", params.orderId, err);
    // Leave the payment untouched — the status poller will settle it.
    return NextResponse.json({ error: "Enquiry failed" }, { status: 502 });
  }

  const verdict = abank.verifyEnquiry(enquiry.data, {
    orderId: params.orderId,
    amountMmk: payment.amount,
  });

  if (verdict.outcome === "pending") {
    return NextResponse.json({ message: "Pending" }, { status: 200 });
  }

  if (verdict.outcome === "failed") {
    // Callback error fields are diagnostics only — bounded, and logged rather
    // than stored. They are unauthenticated input and must not reach the audit
    // record, exactly as on the success path above.
    console.warn(
      "[abank-callback] Refusing to confirm orderId=%s reason=%s callbackErrorCode=%s",
      params.orderId.slice(0, 32),
      verdict.reason,
      (params.errorCode ?? "none").slice(0, 32),
    );
    await supabase
      .from("payments")
      .update({
        mmqr_status: "FAILED",
        // Provider verdict only. A caller who knows an order id could otherwise
        // inject arbitrary text into financial audit data.
        bank_reference: verdict.reason,
      } as never)
      .eq("id", payment.id);

    return NextResponse.json({ message: "OK" }, { status: 200 });
  }

  // ── Verified by ABank: confirm ────────────────────────────
  {
    await supabase
      .from("payments")
      .update({
        mmqr_status: "SUCCESS",
        status: "verified",
        // Server time, never params.transactionDateTime. Once ABank confirms the
        // payment, a caller who knows their own orderId could otherwise forge the
        // settlement time — paid_at feeds reporting and reconciliation, so it is
        // financial data, not decoration.
        paid_at: new Date().toISOString(),
        // ABank's enquiry values ONLY — no fallback to callback params. These are
        // audit fields; an unauthenticated caller must not be able to write them
        // even on a genuinely settled payment.
        bank_reference: verdict.transactionId ? `CB:${verdict.transactionId}` : "CB:verified",
        payer_institution: verdict.institutionName ?? null,
      } as never)
      .eq("id", payment.id);

    await supabase
      .from("enrollments")
      .update({ status: "confirmed" } as never)
      .eq("id", payment.enrollment_id);

    try {
      await issueTicketsForEnrollment(payment.enrollment_id);
    } catch (err) {
      console.error("[tickets] issueTicketsForEnrollment failed:", err);
    }

    // Send notifications (best-effort)
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

    if (enrollment) {
      // Resolve email: column first, then form_data
      const enrollEmail = enrollment.email
        || resolveEmailFromFormData(enrollment.form_data as Record<string, string> | null);
      // Use the configured app origin, not the inbound Host header (spoofable).
      const appOrigin = process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com";
      const statusUrl = `${appOrigin}/status?ref=${enrollment.enrollment_ref}`;

      // Resolve class level for email
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

      // Fetch tenant info for email branding
      const { data: tenantInfo } = (await supabase
        .from("tenants")
        .select("name, org_type, logo_url, currency, sms_on_payment")
        .eq("id", enrollment.tenant_id)
        .single()) as {
        data: { name: string; org_type: string; logo_url: string | null; currency: string; sms_on_payment: boolean } | null;
        error: unknown;
      };
      const tenantCurrency = tenantInfo?.currency ?? "MMK";
      if (feeFormatted) feeFormatted = `${feeFormatted} ${tenantCurrency}`;

      // Collect notification promises — must await before returning
      // so Vercel serverless doesn't kill the function prematurely
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
            console.error("[abank-callback] Telegram notification failed:", err);
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
        const attachment = await buildEticketEmailAttachment(payment.enrollment_id).catch((err) => {
          console.error("[abank-callback] e-ticket attachment failed:", err);
          return null;
        });
        notifyTasks.push(
          sendEmail({
            to: enrollEmail,
            ...emailData,
            ...(attachment ? { attachments: [attachment] } : {}),
          }).catch((err) => {
            console.error("[abank-callback] Approval email failed:", err);
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
            console.error("[abank-callback] Approval SMS failed:", err);
          }),
        );
      }

      // Channel invite (language_school only, gated inside)
      if (enrollment.telegram_chat_id) {
        notifyTasks.push(
          sendChannelInviteIfEligible({
            tenantId: enrollment.tenant_id,
            enrollmentId: payment.enrollment_id,
            classId: enrollment.class_id,
            telegramChatId: enrollment.telegram_chat_id,
            studentName: enrollment.student_name_en || "Student",
          }).catch((err) => {
            console.error("[abank-callback] Channel invite failed:", err);
          }),
        );
      }

      await Promise.allSettled(notifyTasks);
    }
  }

  return NextResponse.json({ message: "OK" }, { status: 200 });
}
