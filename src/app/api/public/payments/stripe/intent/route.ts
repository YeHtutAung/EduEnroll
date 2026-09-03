import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { getStripe } from "@/lib/stripe";
import { stripeCreationAllowed } from "@/lib/payments/launchGate";
import { toMinorUnits, isStripeSupported } from "@/lib/payments/currency";
import { buildStripeMetadata } from "@/lib/payments/stripeMetadata";
import {
  selectAttemptContext,
  replacementPlan,
  finalizeStripeAttempt,
} from "@/server/payments/stripeAttempt";
import { settlePaidPayment } from "@/server/payments/settlePaidPayment";
import { resolveOrderTotal } from "@/server/payments/platformFee";

// ─── POST /api/public/payments/stripe/intent ─────────────────────────────────
// Direct-PaymentIntent creation (Plan v18 §3). Idempotent via predecessor-
// bound Stripe idempotency keys; fail-closed on every lookup; discriminated
// results (§3c) — the client never mistakes one shape for another.
//
// Eligibility gate (§3b-2, PRESERVED from pre-plan code): only
// `pending_payment` proceeds. This route deliberately refuses
// `partial_payment` — it has no remaining-balance contract; Checkout does.

const FLOW = "direct_payment_intent" as const;

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  let body: { enrollmentRef?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON." }, { status: 400 });
  }

  const { enrollmentRef } = body;
  if (!enrollmentRef || typeof enrollmentRef !== "string") {
    return NextResponse.json({ error: "Bad Request", message: "enrollmentRef is required." }, { status: 400 });
  }
  const ref = enrollmentRef.trim();

  // ── Launch gate — BEFORE any lookup or Stripe call ──────────────────────
  if (!stripeCreationAllowed(ref)) {
    return NextResponse.json(
      { error: "Service Unavailable", message: "Online card payment is not currently available." },
      { status: 503 },
    );
  }

  const supabase = createAdminClient();

  // ── Enrollment, fail-closed ──────────────────────────────────────────────
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("id, status, tenant_id, enrollment_ref, enrollment_items(quantity, fee_amount), classes(fee_amount), quantity")
    .eq("enrollment_ref", ref)
    .eq("tenant_id", tenantId)
    .maybeSingle()) as { data: EnrollmentRow | null; error: { message: string } | null };

  if (enrollmentError) {
    return NextResponse.json(
      { error: "Internal Server Error", message: "Could not load enrollment." },
      { status: 500 },
    );
  }
  if (!enrollment) {
    return NextResponse.json({ error: "Not Found", message: "Enrollment not found." }, { status: 404 });
  }
  // Eligibility allow-list: rejected/confirmed/anything unlisted is refused
  // BEFORE Stripe. Idempotency makes repetition safe; it does not make an
  // ineligible payment legitimate.
  if (enrollment.status !== "pending_payment") {
    return NextResponse.json(
      { error: "Conflict", message: "This enrollment is not awaiting payment." },
      { status: 409 },
    );
  }

  // ── Currency allow-list, fail-closed ─────────────────────────────────────
  const { data: tenant, error: tenantError } = (await supabase
    .from("tenants")
    .select("currency")
    .eq("id", tenantId)
    .maybeSingle()) as { data: { currency: string } | null; error: { message: string } | null };
  if (tenantError || !tenant) {
    return NextResponse.json(
      { error: "Internal Server Error", message: "Could not load tenant." },
      { status: 500 },
    );
  }
  const currency = tenant.currency.toLowerCase();
  if (!isStripeSupported(currency)) {
    return NextResponse.json(
      { error: "Bad Request", message: `Stripe is not available for ${tenant.currency}.` },
      { status: 400 },
    );
  }

  // ── Amount: whole major units, converted by the ONE helper ───────────────
  let totalMajor: number;
  if (enrollment.enrollment_items && enrollment.enrollment_items.length > 0) {
    totalMajor = enrollment.enrollment_items.reduce((s, i) => s + i.fee_amount * i.quantity, 0);
  } else if (enrollment.classes) {
    totalMajor = enrollment.classes.fee_amount * (enrollment.quantity ?? 1);
  } else {
    return NextResponse.json(
      { error: "Internal Server Error", message: "Class data not found." },
      { status: 500 },
    );
  }

  // platform_fee_amount is in whole major units, the same unit as totalMajor,
  // so it is added before the minor-unit conversion rather than after.
  const { platformFee } = await resolveOrderTotal(supabase, enrollment);
  totalMajor += platformFee;
  let amountMinor: number;
  try {
    amountMinor = toMinorUnits(totalMajor, currency);
  } catch (err) {
    return NextResponse.json(
      { error: "Bad Request", message: (err as Error).message },
      { status: 400 },
    );
  }

  const source = { type: "creation_request" as const, id: randomUUID() };
  const conflictResponse = (paymentIntentId?: string) =>
    NextResponse.json({
      kind: "settlement_conflict",
      ...(paymentIntentId ? { paymentIntentId } : {}),
      reference: enrollment.enrollment_ref,
    });

  try {
    // ── Attempt context ──────────────────────────────────────────────────
    let ctx = await selectAttemptContext(enrollment.id, FLOW);
    if (ctx.kind === "retryable") {
      console.error("[stripe/intent]", ctx.reason);
      return NextResponse.json(
        { error: "Internal Server Error", message: "Payment state needs attention. Contact support." },
        { status: 500 },
      );
    }

    // ── Active attempt: provider-state contract (§3c) ─────────────────────
    if (ctx.kind === "active") {
      const row = ctx.row;
      if (row.integration_flow !== FLOW || !row.stripe_payment_intent_id) {
        // An active attempt from the OTHER flow owns this enrollment. Its
        // provider state is not this route's to judge — fail closed.
        return NextResponse.json(
          { error: "Conflict", message: "Another payment attempt is already in progress." },
          { status: 409 },
        );
      }

      let pi;
      try {
        pi = await getStripe().paymentIntents.retrieve(row.stripe_payment_intent_id);
      } catch (err) {
        if ((err as { code?: string }).code === "resource_missing") {
          ctx = replacementPlan(FLOW, row); // definitively terminal → replace
        } else {
          // Connection error, 401, 429, unexpected shape: retrieval failures
          // never authorise a replacement. 502, create nothing.
          return NextResponse.json(
            { error: "Payment Gateway Error", message: "Could not verify payment state." },
            { status: 502 },
          );
        }
      }

      if (ctx.kind === "active" && pi) {
        switch (pi.status) {
          case "requires_payment_method":
          case "requires_confirmation":
          case "requires_action":
            return NextResponse.json({
              kind: "requires_payment",
              clientSecret: pi.client_secret,
              paymentIntentId: pi.id,
            });
          case "requires_capture":
          case "processing":
            return NextResponse.json({ kind: "processing", paymentIntentId: pi.id });
          case "succeeded": {
            // Settle synchronously; never claim a ticket exists — the client
            // routes to a status screen that polls the database.
            const outcome = await settlePaidPayment({
              paymentIntentId: pi.id,
              observedAmountMinor: pi.amount_received,
              observedCurrency: pi.currency,
              source,
            });
            if (outcome.kind === "settled" || outcome.kind === "already_settled") {
              return NextResponse.json({ kind: "succeeded", paymentIntentId: pi.id });
            }
            if (outcome.kind === "conflict") return conflictResponse(pi.id);
            console.error("[stripe/intent] settle retryable:", outcome.reason);
            return NextResponse.json(
              { error: "Internal Server Error", message: "Settlement failed. Try again." },
              { status: 500 },
            );
          }
          case "canceled":
            ctx = replacementPlan(FLOW, row);
            break;
          default:
            return NextResponse.json(
              { error: "Payment Gateway Error", message: "Unexpected payment state." },
              { status: 502 },
            );
        }
      }
    }

    if (ctx.kind !== "create") {
      // Exhaustiveness guard — every active branch above either returned or
      // reassigned ctx to a create plan.
      return NextResponse.json(
        { error: "Internal Server Error", message: "Unreachable payment state." },
        { status: 500 },
      );
    }

    // ── Create, keyed to the predecessor's identity ────────────────────────
    let pi;
    try {
      pi = await getStripe().paymentIntents.create(
        {
          amount: amountMinor,
          currency,
          payment_method_types: ["card", "paynow"],
          metadata: buildStripeMetadata({
            flow: FLOW,
            tenantId,
            enrollmentId: enrollment.id,
            enrollmentRef: enrollment.enrollment_ref,
          }),
        },
        { idempotencyKey: ctx.idempotencyKey },
      );
    } catch (err) {
      console.error("[stripe/intent] create error:", (err as Error).message);
      return NextResponse.json(
        { error: "Payment Gateway Error", message: "Failed to create payment session." },
        { status: 502 },
      );
    }

    const result = await finalizeStripeAttempt({
      enrollmentId: enrollment.id,
      tenantId,
      flow: FLOW,
      attemptSeq: ctx.attemptSeq,
      intentId: pi.id,
      sessionId: null,
      amountMajor: totalMajor,
      amountMinor,
      platformFee,
      currency,
      predecessorId: ctx.predecessorId,
      source,
      cancelObject: async () => {
        await getStripe().paymentIntents.cancel(pi.id);
      },
    });

    switch (result.kind) {
      case "ok":
        return NextResponse.json({
          kind: "requires_payment",
          clientSecret: pi.client_secret,
          paymentIntentId: pi.id,
        });
      case "conflict":
        return conflictResponse(pi.id);
      case "retryable":
        console.error("[stripe/intent] finalize retryable:", result.reason);
        return NextResponse.json(
          { error: "Internal Server Error", message: "Payment could not be recorded. No payment was issued." },
          { status: 500 },
        );
    }
  } catch (err) {
    // Conflict-write failures land here: recorded-or-500, never silent.
    console.error("[stripe/intent] retryable failure:", err);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Payment could not be processed." },
      { status: 500 },
    );
  }
}

interface EnrollmentRow {
  id: string;
  status: string;
  tenant_id: string;
  enrollment_ref: string;
  quantity: number | null;
  enrollment_items: { quantity: number; fee_amount: number }[] | null;
  classes: { fee_amount: number } | null;
}
