import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import abank from "@/lib/abank";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";

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

    // Send Telegram notification (best-effort)
    const { data: enrollment } = (await supabase
      .from("enrollments")
      .select("tenant_id, telegram_chat_id, enrollment_ref, student_name_en")
      .eq("id", payment.enrollment_id)
      .single()) as {
      data: { tenant_id: string; telegram_chat_id: string | null; enrollment_ref: string; student_name_en: string } | null;
      error: unknown;
    };

    if (enrollment?.telegram_chat_id) {
      const host = request.headers.get("host") ?? "localhost:3005";
      const proto = host.startsWith("localhost") ? "http" : "https";
      const statusUrl = `${proto}://${host}/status?ref=${enrollment.enrollment_ref}`;

      sendTelegramStatusNotification({
        tenantId: enrollment.tenant_id,
        telegramChatId: enrollment.telegram_chat_id,
        action: "approve",
        studentName: enrollment.student_name_en || "Student",
        enrollmentRef: enrollment.enrollment_ref,
        classLevel: "Ticket",
        statusUrl,
        paymentUrl: statusUrl,
      }).catch((err) => {
        console.error("[abank-callback] Telegram notification failed:", err);
      });
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
