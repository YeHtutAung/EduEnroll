import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import abank from "@/lib/abank";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";

// ─── GET /api/public/payments/abank/status?ref=AB-xxx ───────────────────────
// Polls ABank enquiry API and updates local payment record.
// Returns: { status: "PENDING" | "SUCCESS" | "FAILED" | "REFUNDED" | "NOT_FOUND" }

const STATUS_MAP: Record<number, string> = {
  200: "SUCCESS",
  100: "PENDING",
  500: "FAILED",
  400: "REFUNDED",
  403: "NOT_FOUND",
};

export async function GET(request: NextRequest) {
  const paymentRef = request.nextUrl.searchParams.get("ref");
  if (!paymentRef) {
    return NextResponse.json(
      { error: "Bad Request", message: "ref is required." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // Check local DB first — if already finalized, skip API call
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, mmqr_status, status")
    .eq("payment_ref", paymentRef)
    .single()) as {
    data: { id: string; enrollment_id: string; mmqr_status: string; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    return NextResponse.json({ mmqr_status: "PENDING" });
  }

  // Already finalized locally (via callback or previous poll)
  if (payment.mmqr_status === "SUCCESS" || payment.status === "verified") {
    return NextResponse.json({ mmqr_status: "SUCCESS" });
  }
  if (payment.mmqr_status === "FAILED") {
    return NextResponse.json({ mmqr_status: "FAILED" });
  }

  // Poll ABank enquiry API
  try {
    const enquiry = await abank.enquiryOrder(paymentRef);
    const txnData = enquiry.data;
    const txnStatus = STATUS_MAP[txnData.paymentTxnStatus] ?? "PENDING";

    if (txnStatus === "SUCCESS") {
      // Update payment + enrollment
      await supabase
        .from("payments")
        .update({
          mmqr_status: "SUCCESS",
          status: "verified",
          paid_at: new Date().toISOString(),
          bank_reference: txnData.transactionId ?? null,
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
          console.error("[abank-status] Telegram notification failed:", err);
        });
      }
    } else if (txnStatus === "FAILED") {
      await supabase
        .from("payments")
        .update({ mmqr_status: "FAILED" } as never)
        .eq("id", payment.id);
    } else if (txnStatus === "REFUNDED") {
      await supabase
        .from("payments")
        .update({ mmqr_status: "REFUNDED", status: "rejected" } as never)
        .eq("id", payment.id);
    }

    return NextResponse.json({ mmqr_status: txnStatus });
  } catch (err) {
    console.error("[abank-status] enquiry error:", err);
    // Fall back to local status on API error
    return NextResponse.json({ mmqr_status: payment.mmqr_status ?? "PENDING" });
  }
}
