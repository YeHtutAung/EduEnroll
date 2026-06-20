import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import paypay from "@/lib/paypay";
import { sendPaymentNotifications } from "@/lib/payment-notifications";

// ─── POST /api/public/payments/paypay/webhook ───────────────────────────────
// PayPay transaction webhook handler.
// Verifies webhook signature, then updates payment + enrollment status.

export async function POST(request: NextRequest) {
  // ── 1. Read headers and body ─────────────────────────────────
  const signature = request.headers.get("x-paypay-signature") ?? "";
  const bodyText = await request.text();

  // ── 2. Verify webhook signature ──────────────────────────────
  if (signature) {
    try {
      const isValid = paypay.verifyWebhook(bodyText, signature);
      if (!isValid) {
        console.warn("[paypay-webhook] Invalid signature");
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } catch {
      console.warn("[paypay-webhook] Signature verification error");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    // If no signature header present, log warning but still process
    // (PayPay sandbox may not send signatures — remove this fallback in production)
    console.warn("[paypay-webhook] No signature header — processing anyway (sandbox mode?)");
  }

  // ── 3. Parse webhook payload ─────────────────────────────────
  let data: ReturnType<typeof paypay.parseWebhookPayload>["data"];
  try {
    const parsed = paypay.parseWebhookPayload(bodyText);
    data = parsed.data;
  } catch {
    console.warn("[paypay-webhook] Failed to parse payload");
    return NextResponse.json({ error: "Bad Request" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── 4. Find payment by merchantPaymentId ─────────────────────
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, amount, status")
    .eq("payment_ref", data.merchantPaymentId)
    .single()) as {
    data: { id: string; enrollment_id: string; amount: number; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    console.warn("[paypay-webhook] Payment not found for merchantPaymentId:", data.merchantPaymentId);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  // Skip if already finalized (idempotent)
  if (payment.status === "verified" || payment.status === "rejected") {
    return NextResponse.json({ message: "Already processed" }, { status: 200 });
  }

  // ── 5. Update based on state ─────────────────────────────────
  if (data.state === "COMPLETED") {
    await supabase
      .from("payments")
      .update({
        paypay_status: "COMPLETED",
        status: "verified",
        paid_at: new Date().toISOString(),
        bank_reference: data.paymentId,
        received_amount: payment.amount,
      } as never)
      .eq("id", payment.id);

    await supabase
      .from("enrollments")
      .update({ status: "confirmed" } as never)
      .eq("id", payment.enrollment_id);

    // Send notifications
    await sendPaymentNotifications(supabase, payment, request);
  } else if (data.state === "FAILED") {
    await supabase
      .from("payments")
      .update({ paypay_status: "FAILED" } as never)
      .eq("id", payment.id);
  } else if (data.state === "CANCELED") {
    await supabase
      .from("payments")
      .update({ paypay_status: "CANCELED", status: "rejected" } as never)
      .eq("id", payment.id);
  } else if (data.state === "EXPIRED") {
    await supabase
      .from("payments")
      .update({ paypay_status: "EXPIRED" } as never)
      .eq("id", payment.id);
  }

  // PayPay expects 200 OK response
  return NextResponse.json({ message: "OK" }, { status: 200 });
}
