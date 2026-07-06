import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";

// ─── GET /api/public/payments/stripe/intent/status?pi=pi_xxx ─────────────────
// Polls Stripe for PaymentIntent status. Used by PayNow QR polling loop.
// No PII returned — PaymentIntent IDs are already client-side (in URL).
// Idempotent — safe to call on every poll tick.

export async function GET(request: NextRequest) {
  const piId = request.nextUrl.searchParams.get("pi");
  if (!piId) {
    return NextResponse.json({ error: "pi parameter is required." }, { status: 400 });
  }

  try {
    const pi = await getStripe().paymentIntents.retrieve(piId, { expand: ["payment_method"] });

    if (pi.status === "succeeded") {
      const supabase = createAdminClient();

      const { data: payment } = (await supabase
        .from("payments")
        .select("id, enrollment_id, status")
        .eq("stripe_payment_intent_id", piId)
        .single()) as { data: { id: string; enrollment_id: string; status: string } | null; error: unknown };

      if (payment && payment.status !== "verified") {
        const pm = pi.payment_method as import("stripe").Stripe.PaymentMethod | null;
        const cardBrand = pm?.card?.brand ?? null;
        const cardLast4 = pm?.card?.last4 ?? null;

        await supabase
          .from("payments")
          .update({
            status: "verified",
            paid_at: new Date().toISOString(),
            ...(cardBrand ? { card_brand: cardBrand } : {}),
            ...(cardLast4 ? { card_last4: cardLast4 } : {}),
          } as never)
          .eq("id", payment.id);

        await supabase
          .from("enrollments")
          .update({ status: "confirmed" } as never)
          .eq("id", payment.enrollment_id);
      }

      return NextResponse.json({ status: "succeeded" });
    }

    if (pi.status === "canceled") {
      return NextResponse.json({ status: "cancelled" });
    }

    return NextResponse.json({ status: "pending" });
  } catch (err) {
    console.error("[stripe/intent/status]", err);
    return NextResponse.json({ error: "Failed to retrieve payment status." }, { status: 500 });
  }
}
