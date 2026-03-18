import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import mmpay from "@/lib/mmpay";

// ─── POST /api/public/payments/mmqr/webhook ─────────────────────────────────
// MyanMyanPay webhook callback handler.
// Verifies HMAC signature, then updates payment + enrollment status.

export async function POST(request: NextRequest) {
  // ── 1. Read headers and body ───────────────────────────────
  const signature = request.headers.get("x-mmpay-signature") ?? "";
  const nonce = request.headers.get("x-mmpay-nonce") ?? "";
  const bodyText = await request.text();

  // ── 2. Verify HMAC signature ───────────────────────────────
  const isValid = await mmpay.verifyCb(bodyText, nonce, signature);
  if (!isValid) {
    console.warn("[mmqr-webhook] Invalid signature");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── 3. Parse payload ───────────────────────────────────────
  let payload: {
    orderId: string;
    amount: number;
    currency: string;
    vendor: string;
    method: string;
    status: "PENDING" | "SUCCESS" | "FAILED" | "REFUNDED";
    condition: string;
    transactionRefId: string;
  };

  try {
    payload = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: "Bad Request" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── 4. Find payment by payment_ref ─────────────────────────
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, status")
    .eq("payment_ref", payload.orderId)
    .single()) as {
    data: { id: string; enrollment_id: string; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    console.warn("[mmqr-webhook] Payment not found for orderId:", payload.orderId);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  // Skip if payment already finalized
  if (payment.status === "verified" || payment.status === "rejected") {
    return NextResponse.json({ message: "Already processed" }, { status: 200 });
  }

  // ── 5. Update based on status ──────────────────────────────
  if (payload.status === "SUCCESS") {
    // Update payment to verified
    await supabase
      .from("payments")
      .update({
        mmqr_status: "SUCCESS",
        status: "verified",
        paid_at: new Date().toISOString(),
        bank_reference: payload.transactionRefId,
      } as never)
      .eq("id", payment.id);

    // Update enrollment to confirmed
    await supabase
      .from("enrollments")
      .update({ status: "confirmed" } as never)
      .eq("id", payment.enrollment_id);
  } else if (payload.status === "FAILED") {
    await supabase
      .from("payments")
      .update({
        mmqr_status: "FAILED",
      } as never)
      .eq("id", payment.id);
  } else if (payload.status === "REFUNDED") {
    await supabase
      .from("payments")
      .update({
        mmqr_status: "REFUNDED",
        status: "rejected",
      } as never)
      .eq("id", payment.id);
  }

  return NextResponse.json({ message: "OK" }, { status: 200 });
}
