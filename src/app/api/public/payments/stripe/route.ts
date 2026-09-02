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
import { recordConflict } from "@/server/payments/settlementConflicts";
import { resolveOrderTotal } from "@/server/payments/platformFee";

// ─── POST /api/public/payments/stripe ────────────────────────────────────────
// Hosted Checkout creation (Plan v18 §3). Discriminated results (§3c);
// predecessor-bound idempotency; the §4 metadata contract goes on the Session
// AND (via payment_intent_data) its underlying PaymentIntent — a
// PaymentIntent-side sweep must be able to attribute hosted objects.
//
// Eligibility gate (§3b-2, PRESERVED): pending_payment | partial_payment.
// partial_payment is payable HERE because this route computes a remaining
// balance; the intent route has no such contract and refuses it.

const FLOW = "hosted_checkout" as const;

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  let body: { enrollmentRef?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const { enrollmentRef } = body;
  if (!enrollmentRef || typeof enrollmentRef !== "string") {
    return NextResponse.json(
      { error: "Bad Request", message: "enrollmentRef is required." },
      { status: 400 },
    );
  }
  const ref = enrollmentRef.trim();

  // ── Launch gate — BEFORE any lookup or Stripe call ──────────────────────
  if (!stripeCreationAllowed(ref)) {
    return NextResponse.json(
      { error: "Service Unavailable", message: "Online payment is not currently available." },
      { status: 503 },
    );
  }

  const supabase = createAdminClient();

  // ── Enrollment, fail-closed ──────────────────────────────────────────────
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("*, classes(id, fee_amount, level, intakes(name, slug)), enrollment_items(class_id, quantity, fee_amount, classes(level))")
    .eq("enrollment_ref", ref)
    .eq("tenant_id", tenantId)
    .maybeSingle()) as {
    data: {
      id: string;
      enrollment_ref: string;
      tenant_id: string;
      class_id: string | null;
      quantity: number | null;
      status: string;
      student_name_en: string;
      classes: { id: string; fee_amount: number; level: string; intakes: { name: string; slug: string } | null } | null;
      enrollment_items: { class_id: string; quantity: number; fee_amount: number; classes: { level: string } | null }[] | null;
    } | null;
    error: { message: string } | null;
  };

  if (enrollmentError) {
    return NextResponse.json(
      { error: "Internal Server Error", message: "Could not load enrollment." },
      { status: 500 },
    );
  }
  if (!enrollment) {
    return NextResponse.json(
      { error: "Not Found", message: "Enrollment not found." },
      { status: 404 },
    );
  }

  // Eligibility allow-list (§3b-2): anything unlisted fails closed BEFORE
  // Stripe — idempotency does not make an ineligible payment legitimate.
  if (enrollment.status !== "pending_payment" && enrollment.status !== "partial_payment") {
    return NextResponse.json(
      { error: "Conflict", message: "This enrollment is not awaiting payment." },
      { status: 409 },
    );
  }

  // ── Currency allow-list, fail-closed ─────────────────────────────────────
  const { data: tenant, error: tenantError } = (await supabase
    .from("tenants")
    .select("currency, name")
    .eq("id", tenantId)
    .maybeSingle()) as { data: { currency: string; name: string } | null; error: { message: string } | null };
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

  // ── Total + line items, all conversion through the ONE helper ────────────
  const isCart =
    !enrollment.class_id &&
    enrollment.enrollment_items &&
    enrollment.enrollment_items.length > 0;

  let totalMajor: number;
  let lineItems: { price_data: { currency: string; unit_amount: number; product_data: { name: string } }; quantity: number }[];

  try {
    if (isCart) {
      lineItems = enrollment.enrollment_items!.map((item) => ({
        price_data: {
          currency,
          unit_amount: toMinorUnits(item.fee_amount, currency),
          product_data: { name: item.classes?.level ?? "Class" },
        },
        quantity: item.quantity,
      }));
      totalMajor = enrollment.enrollment_items!.reduce(
        (sum, item) => sum + item.fee_amount * item.quantity,
        0,
      );
    } else if (enrollment.classes) {
      const qty = enrollment.quantity ?? 1;
      totalMajor = enrollment.classes.fee_amount * qty;
      lineItems = [
        {
          price_data: {
            currency,
            unit_amount: toMinorUnits(enrollment.classes.fee_amount, currency),
            product_data: {
              name: `${enrollment.classes.level}${enrollment.classes.intakes ? ` — ${enrollment.classes.intakes.name}` : ""}`,
            },
          },
          quantity: qty,
        },
      ];
    } else {
      return NextResponse.json(
        { error: "Internal Server Error", message: "Class data not found." },
        { status: 500 },
      );
    }

    // Online platform fee. Stripe is sent line items as well as a total, so
    // the fee gets its own line — otherwise the lines do not sum to the amount
    // charged. platform_fee_amount is in whole major units, the same unit as
    // totalMajor, so the minor-unit conversion happens here as it does above.
    const { platformFee } = await resolveOrderTotal(supabase, enrollment);
    if (platformFee > 0) {
      totalMajor += platformFee;
      lineItems.push({
        price_data: {
          currency,
          unit_amount: toMinorUnits(platformFee, currency),
          product_data: { name: "Online platform fee" },
        },
        quantity: 1,
      });
    }

    // ── Partial payment: single remaining-balance line ──────────────────────
    if (enrollment.status === "partial_payment") {
      const { data: prevPayment, error: prevError } = (await supabase
        .from("payments")
        .select("received_amount")
        .eq("enrollment_id", enrollment.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()) as { data: { received_amount: number | null } | null; error: { message: string } | null };
      if (prevError) {
        return NextResponse.json(
          { error: "Internal Server Error", message: "Could not load payment history." },
          { status: 500 },
        );
      }
      if (prevPayment?.received_amount) {
        totalMajor = totalMajor - prevPayment.received_amount;
        lineItems = [
          {
            price_data: {
              currency,
              unit_amount: toMinorUnits(totalMajor, currency),
              product_data: { name: "Remaining Balance" },
            },
            quantity: 1,
          },
        ];
      }
    }
  } catch (err) {
    // toMinorUnits throws on fractional/invalid amounts — whole-unit contract.
    return NextResponse.json(
      { error: "Bad Request", message: (err as Error).message },
      { status: 400 },
    );
  }

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
  const conflictResponse = (sessionId?: string) =>
    NextResponse.json({
      kind: "settlement_conflict",
      ...(sessionId ? { sessionId } : {}),
      reference: enrollment.enrollment_ref,
    });

  try {
    // ── Attempt context ─────────────────────────────────────────────────────
    let ctx = await selectAttemptContext(enrollment.id, FLOW);
    if (ctx.kind === "retryable") {
      console.error("[stripe/checkout]", ctx.reason);
      return NextResponse.json(
        { error: "Internal Server Error", message: "Payment state needs attention. Contact support." },
        { status: 500 },
      );
    }

    // ── Active attempt: provider-state contract (§3c) ───────────────────────
    if (ctx.kind === "active") {
      const row = ctx.row;
      if (row.integration_flow !== FLOW || !row.stripe_session_id) {
        return NextResponse.json(
          { error: "Conflict", message: "Another payment attempt is already in progress." },
          { status: 409 },
        );
      }

      let session;
      try {
        session = await getStripe().checkout.sessions.retrieve(row.stripe_session_id);
      } catch (err) {
        if ((err as { code?: string }).code === "resource_missing") {
          ctx = replacementPlan(FLOW, row);
        } else {
          return NextResponse.json(
            { error: "Payment Gateway Error", message: "Could not verify payment state." },
            { status: 502 },
          );
        }
      }

      if (ctx.kind === "active" && session) {
        if (session.status === "open" && session.url) {
          return NextResponse.json({ kind: "redirect", url: session.url, sessionId: session.id });
        }
        if (session.status === "complete") {
          if (session.payment_status === "paid") {
            const outcome = await settlePaidPayment({
              sessionId: session.id,
              observedAmountMinor: session.amount_total,
              observedCurrency: session.currency,
              source,
              backfillPaymentIntentId:
                typeof session.payment_intent === "string" ? session.payment_intent : null,
            });
            if (outcome.kind === "settled" || outcome.kind === "already_settled") {
              return NextResponse.json({ kind: "succeeded", sessionId: session.id });
            }
            if (outcome.kind === "conflict") return conflictResponse(session.id);
            console.error("[stripe/checkout] settle retryable:", outcome.reason);
            return NextResponse.json(
              { error: "Internal Server Error", message: "Settlement failed. Try again." },
              { status: 500 },
            );
          }
          if (session.payment_status === "no_payment_required") {
            // The creation contract rejects zero amounts, so this cannot
            // satisfy the expected positive-payment contract — a conflict,
            // never a success screen. Object is owned by this row → shape (i).
            await recordConflict({
              objectId: session.id,
              conflictType: "unexpected_no_payment_required",
              source,
              paymentId: row.id,
              enrollmentId: enrollment.id,
              expectedAmountMinor: amountMinor,
              expectedCurrency: currency,
            });
            return conflictResponse(session.id);
          }
          // complete + unpaid: a delayed method is in flight.
          return NextResponse.json({ kind: "processing", sessionId: session.id });
        }
        if (session.status === "expired") {
          ctx = replacementPlan(FLOW, row);
        } else if (ctx.kind === "active") {
          return NextResponse.json(
            { error: "Payment Gateway Error", message: "Unexpected payment state." },
            { status: 502 },
          );
        }
      }
    }

    if (ctx.kind !== "create") {
      return NextResponse.json(
        { error: "Internal Server Error", message: "Unreachable payment state." },
        { status: 500 },
      );
    }

    // ── Create, keyed to the predecessor's identity ──────────────────────────
    const host = request.headers.get("host") ?? "localhost:3005";
    const proto = host.startsWith("localhost") ? "http" : "https";
    const baseUrl = `${proto}://${host}`;
    const metadata = buildStripeMetadata({
      flow: FLOW,
      tenantId,
      enrollmentId: enrollment.id,
      enrollmentRef: enrollment.enrollment_ref,
    });

    let session;
    try {
      session = await getStripe().checkout.sessions.create(
        {
          mode: "payment",
          line_items: lineItems,
          success_url: `${baseUrl}/enroll/payment/${enrollment.enrollment_ref}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${baseUrl}/enroll/payment/${enrollment.enrollment_ref}?stripe=cancelled`,
          metadata,
          // §4: the underlying PaymentIntent carries the SAME contract on
          // itself — a Session-only contract leaves it unattributable to a
          // PaymentIntent-side sweep and unmarked for ownership dispatch.
          payment_intent_data: { metadata },
        },
        { idempotencyKey: ctx.idempotencyKey },
      );
    } catch (err) {
      console.error("[stripe/checkout] create error:", (err as Error).message);
      return NextResponse.json(
        { error: "Payment Gateway Error", message: "Failed to create payment session. Please try again." },
        { status: 502 },
      );
    }

    const result = await finalizeStripeAttempt({
      enrollmentId: enrollment.id,
      tenantId,
      flow: FLOW,
      attemptSeq: ctx.attemptSeq,
      intentId: null,
      sessionId: session.id,
      amountMajor: totalMajor,
      amountMinor,
      currency,
      predecessorId: ctx.predecessorId,
      source,
      cancelObject: async () => {
        await getStripe().checkout.sessions.expire(session.id);
      },
    });

    switch (result.kind) {
      case "ok":
        return NextResponse.json({ kind: "redirect", url: session.url, sessionId: session.id });
      case "conflict":
        return conflictResponse(session.id);
      case "retryable":
        console.error("[stripe/checkout] finalize retryable:", result.reason);
        return NextResponse.json(
          { error: "Internal Server Error", message: "Payment could not be recorded. No payment link was issued." },
          { status: 500 },
        );
    }
  } catch (err) {
    console.error("[stripe/checkout] retryable failure:", err);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Payment could not be processed." },
      { status: 500 },
    );
  }
}
