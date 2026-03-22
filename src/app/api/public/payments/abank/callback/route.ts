import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import abank from "@/lib/abank";
import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";

// ─── GET /api/public/payments/abank/callback ────────────────────────────────
// ABank calls this URL (GET) after payment completes.
// Success params: orderId, amount, status, transactionId, billNo,
//                 endToEndId, transactionDateTime, institutionName
// Fail adds: errorCode, errorDesc

export async function GET(request: NextRequest) {
  const params = abank.parseCallback(request.nextUrl.searchParams);

  if (!params.orderId) {
    return NextResponse.json({ error: "Missing orderId" }, { status: 400 });
  }

  console.log("[abank-callback]", params);

  const supabase = createAdminClient();

  // ── Find payment by payment_ref ───────────────────────────
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, status")
    .eq("payment_ref", params.orderId)
    .single()) as {
    data: { id: string; enrollment_id: string; status: string } | null;
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

  // ── Update based on callback status ───────────────────────
  const isSuccess = !params.errorCode && params.status;

  if (isSuccess) {
    await supabase
      .from("payments")
      .update({
        mmqr_status: "SUCCESS",
        status: "verified",
        paid_at: params.transactionDateTime
          ? new Date(params.transactionDateTime).toISOString()
          : new Date().toISOString(),
        bank_reference: `CB:${params.transactionId || params.endToEndId || "unknown"}`,
      } as never)
      .eq("id", payment.id);

    await supabase
      .from("enrollments")
      .update({ status: "confirmed" } as never)
      .eq("id", payment.enrollment_id);

    // Send notifications (best-effort)
    const { data: enrollment } = (await supabase
      .from("enrollments")
      .select("tenant_id, telegram_chat_id, email, enrollment_ref, student_name_en, class_id, quantity, form_data")
      .eq("id", payment.enrollment_id)
      .single()) as {
      data: {
        tenant_id: string;
        telegram_chat_id: string | null;
        email: string | null;
        enrollment_ref: string;
        student_name_en: string;
        class_id: string | null;
        quantity: number | null;
        form_data: Record<string, string> | null;
      } | null;
      error: unknown;
    };

    if (enrollment) {
      // Resolve email: column first, then form_data custom email field
      const enrollEmail = enrollment.email
        || (enrollment.form_data && Object.entries(enrollment.form_data).find(([k]) => k === "email" || k.startsWith("custom_email_"))?.[1])
        || null;
      const host = request.headers.get("host") ?? "localhost:3005";
      const proto = host.startsWith("localhost") ? "http" : "https";
      const statusUrl = `${proto}://${host}/status?ref=${enrollment.enrollment_ref}`;

      // Resolve class level for email
      let classLevel = "Ticket";
      let feeFormatted: string | undefined;
      const isCart = enrollment.class_id === null;

      if (isCart) {
        const { data: items } = (await supabase
          .from("enrollment_items")
          .select("quantity, fee_mmk, classes(level)")
          .eq("enrollment_id", payment.enrollment_id)) as {
          data: { quantity: number; fee_mmk: number; classes: { level: string } | null }[] | null;
          error: unknown;
        };
        if (items && items.length > 0) {
          classLevel = items
            .map((i) => (i.quantity > 1 ? `${i.classes?.level ?? "?"} x${i.quantity}` : (i.classes?.level ?? "?")))
            .join(", ");
          const total = items.reduce((s, i) => s + i.fee_mmk * i.quantity, 0);
          feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} MMK`;
        }
      } else {
        const { data: cls } = (await supabase
          .from("classes")
          .select("level, fee_mmk")
          .eq("id", enrollment.class_id!)
          .single()) as { data: { level: string; fee_mmk: number } | null; error: unknown };
        if (cls) {
          classLevel = cls.level;
          const total = cls.fee_mmk * (enrollment.quantity ?? 1);
          feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} MMK`;
        }
      }

      // Fetch tenant info for email branding
      const { data: tenantInfo } = (await supabase
        .from("tenants")
        .select("name, org_type, logo_url")
        .eq("id", enrollment.tenant_id)
        .single()) as {
        data: { name: string; org_type: string; logo_url: string | null } | null;
        error: unknown;
      };

      // Telegram notification
      if (enrollment.telegram_chat_id) {
        sendTelegramStatusNotification({
          tenantId: enrollment.tenant_id,
          telegramChatId: enrollment.telegram_chat_id,
          action: "approve",
          studentName: enrollment.student_name_en || "Student",
          enrollmentRef: enrollment.enrollment_ref,
          classLevel,
          statusUrl,
          paymentUrl: statusUrl,
        }).catch((err) => {
          console.error("[abank-callback] Telegram notification failed:", err);
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
          orgType: tenantInfo?.org_type,
          tenantName: tenantInfo?.name,
          logoUrl: tenantInfo?.logo_url ?? undefined,
        });
        sendEmail({ to: enrollEmail, ...emailData }).catch((err) => {
          console.error("[abank-callback] Approval email failed:", err);
        });
      }

      // Channel invite (language_school only, gated inside)
      if (enrollment.telegram_chat_id) {
        sendChannelInviteIfEligible({
          tenantId: enrollment.tenant_id,
          enrollmentId: payment.enrollment_id,
          classId: enrollment.class_id,
          telegramChatId: enrollment.telegram_chat_id,
          studentName: enrollment.student_name_en || "Student",
        }).catch((err) => {
          console.error("[abank-callback] Channel invite failed:", err);
        });
      }
    }
  } else {
    await supabase
      .from("payments")
      .update({
        mmqr_status: "FAILED",
        bank_reference: params.errorCode
          ? `${params.errorCode}: ${params.errorDesc ?? ""}`
          : null,
      } as never)
      .eq("id", payment.id);
  }

  return NextResponse.json({ message: "OK" }, { status: 200 });
}
