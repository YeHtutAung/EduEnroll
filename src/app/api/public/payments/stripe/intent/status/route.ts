import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getStripe } from "@/lib/stripe";
import { settlePaidPayment } from "@/server/payments/settlePaidPayment";
import type Stripe from "stripe";

// ─── GET /api/public/payments/stripe/intent/status?pi=pi_xxx ─────────────────
// Polls Stripe for PaymentIntent status. Used by the PayNow QR polling loop.
// No PII returned — PaymentIntent IDs are already client-side (in URL).
//
// Settlement goes through the SHARED operation (Plan v18 §5): the old inline
// read-then-write here was the exact pattern the plan removes — no snapshot
// validation, no conditional update, direct enrollment write racing the
// trigger. The response keeps its poll shape: `{status}` where
// `settlement_conflict` is terminal (client stops polling → support state).

export async function GET(request: NextRequest) {
  const piId = request.nextUrl.searchParams.get("pi");
  if (!piId) {
    return NextResponse.json({ error: "pi parameter is required." }, { status: 400 });
  }

  try {
    const pi = await getStripe().paymentIntents.retrieve(piId, { expand: ["payment_method"] });

    if (pi.status === "succeeded") {
      const pm = pi.payment_method as Stripe.PaymentMethod | null;
      const outcome = await settlePaidPayment({
        paymentIntentId: piId,
        observedAmountMinor: pi.amount_received,
        observedCurrency: pi.currency,
        source: { type: "creation_request", id: randomUUID() },
        cardBrand: pm?.card?.brand ?? null,
        cardLast4: pm?.card?.last4 ?? null,
      });

      switch (outcome.kind) {
        case "settled":
        case "already_settled":
          // Tickets are issued INSIDE the operation (settle → fulfil order);
          // "succeeded" here means the database confirms, not just Stripe.
          return NextResponse.json({ status: "succeeded" });
        case "conflict":
          // Terminal — the client stops polling and shows support quoting
          // the reference it already has.
          return NextResponse.json({ status: "settlement_conflict" });
        case "retryable":
          // The customer may already be charged; the webhook path retries
          // independently, and the next poll tick retries here. 500 tells
          // the client "not resolved yet", never "failed".
          console.error("[stripe/intent/status] settle retryable:", outcome.reason);
          return NextResponse.json({ error: "Settlement pending. Keep polling." }, { status: 500 });
      }
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
