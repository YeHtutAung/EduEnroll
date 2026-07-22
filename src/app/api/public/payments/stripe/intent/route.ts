import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { getStripe } from "@/lib/stripe";

// ─── POST /api/public/payments/stripe/intent ──────────────────────────────────
// Creates a Stripe PaymentIntent for the Trusted Official checkout flow.
// Supports card and paynow payment methods.
// Idempotent — returns existing active PaymentIntent if one exists.

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

  const supabase = createAdminClient();

  // ── Look up enrollment ────────────────────────────────────────
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, status, tenant_id, enrollment_ref, enrollment_items(quantity, fee_amount), classes(fee_amount), quantity")
    .eq("enrollment_ref", enrollmentRef.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: EnrollmentRow | null; error: unknown };

  if (!enrollment) {
    return NextResponse.json({ error: "Not Found", message: "Enrollment not found." }, { status: 404 });
  }
  if (enrollment.status !== "pending_payment") {
    return NextResponse.json({ error: "Conflict", message: "This enrollment is not awaiting payment." }, { status: 409 });
  }

  // ── Currency guard — Stripe not available for MMK ─────────────
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("currency")
    .eq("id", tenantId)
    .single()) as { data: { currency: string } | null; error: unknown };

  const currency = (tenant?.currency ?? "MMK").toLowerCase();
  if (currency === "mmk") {
    return NextResponse.json({ error: "Bad Request", message: "Stripe is not available for MMK. Use bank transfer." }, { status: 400 });
  }

  // ── Calculate total ───────────────────────────────────────────
  let totalCents: number;
  if (enrollment.enrollment_items && enrollment.enrollment_items.length > 0) {
    totalCents = enrollment.enrollment_items.reduce((s, i) => s + i.fee_amount * i.quantity, 0) * 100;
  } else if (enrollment.classes) {
    totalCents = enrollment.classes.fee_amount * (enrollment.quantity ?? 1) * 100;
  } else {
    return NextResponse.json({ error: "Internal Server Error", message: "Class data not found." }, { status: 500 });
  }

  // ── Idempotency — return existing active PaymentIntent if any ─
  const { data: existing } = (await supabase
    .from("payments")
    .select("stripe_payment_intent_id")
    .eq("enrollment_id", enrollment.id)
    .eq("payment_method", "stripe")
    .eq("status", "awaiting_payment")
    .not("stripe_payment_intent_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()) as { data: { stripe_payment_intent_id: string } | null; error: unknown };

  if (existing?.stripe_payment_intent_id) {
    try {
      const pi = await getStripe().paymentIntents.retrieve(existing.stripe_payment_intent_id);
      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(pi.status)) {
        return NextResponse.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id });
      }
    } catch {
      // Expired or invalid — fall through to create new
    }
  }

  // ── Create new PaymentIntent ──────────────────────────────────
  try {
    const pi = await getStripe().paymentIntents.create({
      amount: totalCents,
      currency,
      payment_method_types: ["card", "paynow"],
      metadata: {
        tenant_id: tenantId,
        enrollment_id: enrollment.id,
        enrollment_ref: enrollment.enrollment_ref,
      },
    });

    const { error: insertError } = await supabase.from("payments").insert({
      enrollment_id: enrollment.id,
      tenant_id: tenantId,
      amount: totalCents / 100,
      payment_method: "stripe",
      status: "awaiting_payment",
      stripe_payment_intent_id: pi.id,
    } as never);

    // Never hand out a client secret we could not record. This flow resolves
    // payments by stripe_payment_intent_id and has no payment_intent.succeeded
    // handler (#186), so with no row NEITHER the browser NOR any webhook can
    // find the payment — the customer is charged and nothing can be recovered.
    if (insertError) {
      console.error("[stripe/intent] payment insert failed for pi", pi.id);
      try {
        await getStripe().paymentIntents.cancel(pi.id);
      } catch {
        // Cleanup is best-effort and must not replace the original failure.
        console.error("[stripe/intent] cancel failed for pi", pi.id);
      }
      return NextResponse.json(
      { error: "Internal Server Error", message: "Payment could not be recorded. No payment link was issued." },
      { status: 500 },
      );
    }

    return NextResponse.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stripe/intent] create error:", msg);
    return NextResponse.json({ error: "Payment Gateway Error", message: "Failed to create payment session." }, { status: 502 });
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
