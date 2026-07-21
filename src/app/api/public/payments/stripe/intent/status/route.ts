import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { issueTicketsForEnrollment } from "@/server/tickets/issueTickets";

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

        // Notifications intentionally omitted: Stripe checkout is browser-driven.
        // The user is already on the success page. No push notification is needed.
      }

      // Fulfil on every succeeded poll, not only when this call settled: the
      // webhook's replay guard means whoever settles second never issues, so
      // this path was leaving orders ticketless. Idempotent, and #187's guard
      // declines anything not confirmed.
      //
      // Caught deliberately: the helper now throws on query failure, and this
      // route must keep returning its existing Stripe-status shape rather than
      // 500 after the customer has been charged. Retry is #186.
      if (payment) {
        try {
          await issueTicketsForEnrollment(payment.enrollment_id);
        } catch (err) {
          console.error("[tickets] intent/status fulfilment failed:", err);
        }
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
