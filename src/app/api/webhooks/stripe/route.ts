import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { settlePaidPayment, type SettleOutcome } from "@/server/payments/settlePaidPayment";
import { handleStripePaymentFailure } from "@/server/payments/handleStripePaymentFailure";
import { recordConflict } from "@/server/payments/settlementConflicts";
import {
  reconcileStripeRefund,
  refundRejectedStripePayment,
} from "@/server/payments/refundRejectedStripePayment";
import type Stripe from "stripe";

// ─── POST /api/webhooks/stripe ───────────────────────────────────────────────
// Browser-independent settlement (Plan v18). One settlement operation behind
// the three PAID events; the failed event has its own operation. Response
// policy (§7) deliberately diverges from the house "always 200 and log":
// Stripe's retry schedule is the durability mechanism, so retryable failures
// return 500.
//
// IMPORTANT: request.text(), not request.json() — signature verification
// needs the unmodified body.

export async function POST(request: NextRequest) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const source = { type: "webhook_event" as const, id: event.id };

  try {
    // ── Session paid events: completed / async_payment_succeeded ────────────
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const session = event.data.object as Stripe.Checkout.Session;

      // completed can fire unpaid for delayed methods — that is 'processing',
      // not a settlement and not a conflict; async_payment_succeeded (or a
      // paid completed replay) settles it later.
      if (session.payment_status !== "paid") {
        console.warn(
          "[stripe-webhook] session not paid:",
          session.id,
          session.payment_status,
        );
        return NextResponse.json({ received: true });
      }

      const outcome = await settlePaidPayment({
        sessionId: session.id,
        observedAmountMinor: session.amount_total,
        observedCurrency: session.currency,
        source,
        backfillPaymentIntentId:
          typeof session.payment_intent === "string" ? session.payment_intent : null,
      });
      if (outcome.kind === "conflict" && outcome.conflictType === "rejected_enrollment") {
        const paymentIntentId =
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id;
        if (!paymentIntentId) throw new Error(`paid session ${session.id} has no PaymentIntent`);
        await refundRejectedStripePayment(paymentIntentId, session.id);
      }
      return respond(outcome);
    }

    // ── Session failed event: its OWN operation (§5b), never the paid path ──
    if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const outcome = await handleStripePaymentFailure({ sessionId: session.id, source });
      switch (outcome.kind) {
        case "rejected":
        case "replay":
        case "conflict":
          return NextResponse.json({ received: true });
        case "retryable":
          console.error("[stripe-webhook] failure handling retryable:", outcome.reason);
          return NextResponse.json({ error: "retry" }, { status: 500 });
      }
    }

    // ── Session expired: retire the attempt if still active ─────────────────
    if (event.type === "checkout.session.expired") {
      const session = event.data.object as Stripe.Checkout.Session;
      const supabase = createAdminClient();
      const { error } = await supabase
        .from("payments")
        .update({ status: "rejected" } as never)
        .eq("stripe_session_id", session.id)
        .in("status", ["awaiting_payment", "pending"]);
      if (error) {
        console.error("[stripe-webhook] expiry update failed:", error.message);
        return NextResponse.json({ error: "retry" }, { status: 500 });
      }
      return NextResponse.json({ received: true });
    }

    // ── Direct PaymentIntent success: ownership dispatch (§4) ────────────────
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object as Stripe.PaymentIntent;
      const flow = pi.metadata?.integration_flow;

      if (flow === "hosted_checkout") {
        // The Session events own this object. 200, no settlement.
        return NextResponse.json({ received: true });
      }

      if (flow !== "direct_payment_intent") {
        // Missing or unrecognised is never assumed-direct: historical objects
        // carry no marker, and guessing wrong is a double settlement or a
        // permanent retry loop. Visible instead. recordConflict throws on
        // write failure → outer catch → 500.
        await recordConflict({
          objectId: pi.id,
          conflictType: "unknown_integration_flow",
          source,
          actualAmountMinor: pi.amount_received ?? null,
          actualCurrency: pi.currency ?? null,
        });
        return NextResponse.json({ received: true });
      }

      // Card metadata when the event payload carries charge data; PayNow and
      // other non-card methods (and slim event shapes) leave these null — the
      // browser status route backfills if the buyer returns.
      const card = (pi as unknown as {
        charges?: { data?: { payment_method_details?: { card?: { brand?: string; last4?: string } } }[] };
      }).charges?.data?.[0]?.payment_method_details?.card;

      const outcome = await settlePaidPayment({
        paymentIntentId: pi.id,
        observedAmountMinor: pi.amount_received,
        observedCurrency: pi.currency,
        source,
        cardBrand: card?.brand ?? null,
        cardLast4: card?.last4 ?? null,
      });
      if (outcome.kind === "conflict" && outcome.conflictType === "rejected_enrollment") {
        await refundRejectedStripePayment(pi.id);
      }
      return respond(outcome);
    }

    // PayNow refunds are asynchronous. The initial refund remains an open
    // conflict until Stripe reports its terminal state here.
    if (event.type === "refund.updated" || event.type === "refund.failed") {
      await reconcileStripeRefund(event.data.object as Stripe.Refund);
      return NextResponse.json({ received: true });
    }

    // Unhandled event types are acknowledged.
    return NextResponse.json({ received: true });
  } catch (err) {
    // Conflict-write failures and fulfilment failures land here: the money
    // decision is durable or retried, never silently dropped.
    console.error("[stripe-webhook] retryable failure:", err);
    return NextResponse.json({ error: "retry" }, { status: 500 });
  }
}
// ── Outcome → HTTP (§7) ─────────────────────────────────────────────────────
// Notification belongs to settlePaidPayment's transition-winner boundary so
// browser settlement and webhook settlement cannot diverge again.
async function respond(outcome: SettleOutcome): Promise<NextResponse> {
  switch (outcome.kind) {
    case "settled":
      return NextResponse.json({ received: true });
    case "already_settled":
    case "conflict":
      return NextResponse.json({ received: true });
    case "retryable":
      console.error("[stripe-webhook] settlement retryable:", outcome.reason);
      return NextResponse.json({ error: "retry" }, { status: 500 });
  }
}
