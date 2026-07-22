import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { settlePaidPayment } from "@/server/payments/settlePaidPayment";

// ─── GET /api/public/payments/stripe/verify?session_id=cs_xxx ────────────────
// Called by the client after Stripe redirects back with ?stripe=success.
//
// This route is an ADAPTER over the shared settlement operation (Plan v18 §5):
// its old inline verified/confirmed writes bypassed snapshot validation, the
// conditional transition, conflict recording and the trigger-owned enrollment
// decision — the exact contract #203 introduced. It keeps only its response
// shape: `{status: <enrollment status>}`, plus the terminal
// `settlement_conflict` the client maps to a support state.

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

    // Shape fidelity only: the old route 404'd on an unknown session, and the
    // client treats 404 as "nothing to show". Read-only; settlement decisions
    // all live in the operation below.
    const { data: payment, error: lookupError } = (await supabase
      .from("payments")
      .select("id, enrollment_id")
      .eq("stripe_session_id", sessionId)
      .maybeSingle()) as unknown as {
      data: { id: string; enrollment_id: string } | null;
      error: { message: string } | null;
    };
    if (lookupError) {
      return NextResponse.json({ error: "Failed to verify payment" }, { status: 500 });
    }
    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    const outcome = await settlePaidPayment({
      sessionId,
      observedAmountMinor: session.amount_total,
      observedCurrency: session.currency,
      source: { type: "creation_request", id: randomUUID() },
      backfillPaymentIntentId:
        typeof session.payment_intent === "string" ? session.payment_intent : null,
    });

    switch (outcome.kind) {
      case "settled":
      case "already_settled":
        break; // fall through to the enrollment-status read
      case "conflict":
        // Terminal — recorded before this response existed. The client stops
        // treating this as a pending payment and surfaces support.
        return NextResponse.json({ status: "settlement_conflict" });
      case "retryable":
        // The customer may already be charged; the webhook path retries
        // independently and the client may call verify again. Never a false
        // "confirmed".
        console.error("[stripe-verify] settle retryable:", outcome.reason);
        return NextResponse.json({ error: "Failed to verify payment" }, { status: 500 });
    }

    const { data: enrollment } = (await supabase
      .from("enrollments")
      .select("enrollment_ref, status, student_name_en")
      .eq("id", payment.enrollment_id)
      .single()) as { data: { enrollment_ref: string; status: string; student_name_en: string } | null; error: unknown };

    return NextResponse.json({ status: enrollment?.status ?? "confirmed" });
  } catch (err) {
    // Conflict-write failures land here too: recorded-or-500, never silent.
    console.error("[stripe-verify]", err);
    return NextResponse.json({ error: "Failed to verify payment" }, { status: 500 });
  }
}
