import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import abank from "@/lib/abank";

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
        bank_reference: params.transactionId || params.endToEndId || null,
      } as never)
      .eq("id", payment.id);

    await supabase
      .from("enrollments")
      .update({ status: "confirmed" } as never)
      .eq("id", payment.enrollment_id);
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
