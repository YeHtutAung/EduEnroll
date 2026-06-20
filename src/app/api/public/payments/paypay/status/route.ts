import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import paypay from "@/lib/paypay";
import { sendPaymentNotifications } from "@/lib/payment-notifications";

// ─── GET /api/public/payments/paypay/status?ref=PY-xxx ──────────────────────
// Polls PayPay API and updates local payment record.
// Returns: { paypay_status: "CREATED" | "COMPLETED" | "EXPIRED" | "CANCELED" | "FAILED" }

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
    .select("id, enrollment_id, amount, paypay_status, status")
    .eq("payment_ref", paymentRef)
    .single()) as {
    data: { id: string; enrollment_id: string; amount: number; paypay_status: string; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    return NextResponse.json({ paypay_status: "CREATED" });
  }

  // Already finalized locally
  if (payment.paypay_status === "COMPLETED" || payment.status === "verified") {
    return NextResponse.json({ paypay_status: "COMPLETED" });
  }
  if (payment.paypay_status === "FAILED" || payment.paypay_status === "CANCELED") {
    return NextResponse.json({ paypay_status: payment.paypay_status });
  }
  if (payment.paypay_status === "EXPIRED") {
    return NextResponse.json({ paypay_status: "EXPIRED" });
  }

  // Poll PayPay API
  try {
    const result = await paypay.getPaymentStatus(paymentRef);
    const status = result.data?.status ?? "CREATED";

    if (status === "COMPLETED") {
      // Update payment + enrollment (conditional to prevent duplicate notifications)
      const { data: updated } = (await supabase
        .from("payments")
        .update({
          paypay_status: "COMPLETED",
          status: "verified",
          paid_at: new Date().toISOString(),
          bank_reference: result.data?.paymentId ?? null,
          received_amount: payment.amount,
        } as never)
        .eq("id", payment.id)
        .neq("status", "verified")
        .select("id")) as { data: { id: string }[] | null; error: unknown };

      // Only update enrollment + send notifications if we actually changed the payment
      if (updated && updated.length > 0) {
        await supabase
          .from("enrollments")
          .update({ status: "confirmed" } as never)
          .eq("id", payment.enrollment_id);

        // Send notifications
        await sendPaymentNotifications(supabase, payment, request);
      }
    } else if (status === "FAILED") {
      await supabase
        .from("payments")
        .update({ paypay_status: "FAILED" } as never)
        .eq("id", payment.id);
    } else if (status === "EXPIRED") {
      await supabase
        .from("payments")
        .update({ paypay_status: "EXPIRED" } as never)
        .eq("id", payment.id);
    } else if (status === "CANCELED") {
      await supabase
        .from("payments")
        .update({ paypay_status: "CANCELED", status: "rejected" } as never)
        .eq("id", payment.id);
    }

    return NextResponse.json({ paypay_status: status });
  } catch (err) {
    console.error("[paypay-status] poll error:", err);
    return NextResponse.json({ paypay_status: payment.paypay_status ?? "CREATED" });
  }
}
