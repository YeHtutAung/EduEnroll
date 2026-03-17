import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import abank from "@/lib/abank";

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
    const txnStatus = STATUS_MAP[enquiry.paymentTxnStatus] ?? "PENDING";

    if (txnStatus === "SUCCESS") {
      // Update payment + enrollment
      await supabase
        .from("payments")
        .update({
          mmqr_status: "SUCCESS",
          status: "verified",
          paid_at: new Date().toISOString(),
          bank_reference: enquiry.transactionId ?? null,
        } as never)
        .eq("id", payment.id);

      await supabase
        .from("enrollments")
        .update({ status: "confirmed" } as never)
        .eq("id", payment.enrollment_id);
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
