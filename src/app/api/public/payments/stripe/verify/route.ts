import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";

// ─── GET /api/public/payments/stripe/verify?session_id=cs_xxx ────────────────
// Called by the client after Stripe redirects back with ?stripe=success.
// Retrieves the Checkout Session from Stripe, confirms the enrollment if paid,
// and returns the current enrollment status. Idempotent — safe to call multiple times.

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");

  if (!sessionId) {
    return NextResponse.json({ error: "session_id is required" }, { status: 400 });
  }

  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return NextResponse.json({ status: "pending" });
    }

    const supabase = createAdminClient();

    // Find the payment record
    const { data: payment } = (await supabase
      .from("payments")
      .select("id, enrollment_id, status")
      .eq("stripe_session_id", sessionId)
      .single()) as { data: { id: string; enrollment_id: string; status: string } | null; error: unknown };

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    // Idempotent: if webhook already confirmed, just return current enrollment status
    if (payment.status !== "verified") {
      await supabase
        .from("payments")
        .update({
          status: "verified",
          stripe_payment_intent_id: session.payment_intent as string,
          paid_at: new Date().toISOString(),
        } as never)
        .eq("id", payment.id);

      await supabase
        .from("enrollments")
        .update({ status: "confirmed" } as never)
        .eq("id", payment.enrollment_id);
    }

    const { data: enrollment } = (await supabase
      .from("enrollments")
      .select("enrollment_ref, status, student_name_en")
      .eq("id", payment.enrollment_id)
      .single()) as { data: { enrollment_ref: string; status: string; student_name_en: string } | null; error: unknown };

    return NextResponse.json({ status: enrollment?.status ?? "confirmed" });
  } catch (err) {
    console.error("[stripe-verify]", err);
    return NextResponse.json({ error: "Failed to verify payment" }, { status: 500 });
  }
}
