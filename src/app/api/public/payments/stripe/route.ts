import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { getStripe } from "@/lib/stripe";

// ─── POST /api/public/payments/stripe ─────────────────────────────────────────
// Creates a Stripe Checkout Session and returns the URL.
//
// Body: { enrollmentRef: string }

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  // ── 1. Parse body ──────────────────────────────────────────
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

  const supabase = createAdminClient();

  // ── 2. Look up enrollment ──────────────────────────────────
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select("*, classes(id, fee_amount, level, intakes(name, slug)), enrollment_items(class_id, quantity, fee_amount, classes(level))")
    .eq("enrollment_ref", enrollmentRef.trim())
    .eq("tenant_id", tenantId)
    .single()) as {
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
    error: unknown;
  };

  if (enrollmentError || !enrollment) {
    return NextResponse.json(
      { error: "Not Found", message: "Enrollment not found." },
      { status: 404 },
    );
  }

  // ── 3. Guard: only pending_payment or partial_payment ──────
  if (enrollment.status !== "pending_payment" && enrollment.status !== "partial_payment") {
    return NextResponse.json(
      { error: "Conflict", message: "This enrollment is not awaiting payment." },
      { status: 409 },
    );
  }

  // ── 4. Check for existing awaiting_payment Stripe session ──
  const { data: existingPayment } = (await supabase
    .from("payments")
    .select("stripe_session_id")
    .eq("enrollment_id", enrollment.id)
    .eq("payment_method", "stripe")
    .eq("status", "awaiting_payment")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()) as { data: { stripe_session_id: string | null } | null; error: unknown };

  if (existingPayment?.stripe_session_id) {
    try {
      const existingSession = await getStripe().checkout.sessions.retrieve(existingPayment.stripe_session_id);
      if (existingSession.status === "open" && existingSession.url) {
        return NextResponse.json({ url: existingSession.url });
      }
    } catch {
      // Session expired or invalid — continue to create new one
    }
  }

  // ── 5. Fetch tenant currency ───────────────────────────────
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("currency, name")
    .eq("id", tenantId)
    .single()) as { data: { currency: string; name: string } | null; error: unknown };

  const currency = (tenant?.currency ?? "MMK").toLowerCase();

  // Stripe is for non-MMK tenants (SGD, USD, etc.).
  // MMK is a zero-decimal currency — multiplying by 100 would overcharge.
  if (currency === "mmk") {
    return NextResponse.json(
      { error: "Bad Request", message: "Stripe is not available for MMK currency. Use bank transfer or MMQR." },
      { status: 400 },
    );
  }

  // ── 6. Calculate total fee & build line items ──────────────
  const isCart =
    !enrollment.class_id &&
    enrollment.enrollment_items &&
    enrollment.enrollment_items.length > 0;

  let totalFee: number;
  let lineItems: { price_data: { currency: string; unit_amount: number; product_data: { name: string } }; quantity: number }[];

  if (isCart) {
    lineItems = enrollment.enrollment_items!.map((item) => ({
      price_data: {
        currency,
        unit_amount: item.fee_amount * 100, // convert to smallest unit (cents)
        product_data: {
          name: item.classes?.level ?? "Class",
        },
      },
      quantity: item.quantity,
    }));
    totalFee = enrollment.enrollment_items!.reduce(
      (sum, item) => sum + item.fee_amount * item.quantity,
      0,
    );
  } else if (enrollment.classes) {
    const qty = enrollment.quantity ?? 1;
    totalFee = enrollment.classes.fee_amount * qty;
    lineItems = [
      {
        price_data: {
          currency,
          unit_amount: enrollment.classes.fee_amount * 100,
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

  // ── 7. Adjust for partial payment ──────────────────────────
  if (enrollment.status === "partial_payment") {
    const { data: prevPayment } = (await supabase
      .from("payments")
      .select("received_amount")
      .eq("enrollment_id", enrollment.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()) as { data: { received_amount: number | null } | null; error: unknown };

    if (prevPayment?.received_amount) {
      const remaining = totalFee - prevPayment.received_amount;
      totalFee = remaining;
      // Replace line items with single remaining balance item
      lineItems = [
        {
          price_data: {
            currency,
            unit_amount: remaining * 100,
            product_data: {
              name: "Remaining Balance",
            },
          },
          quantity: 1,
        },
      ];
    }
  }

  // ── 8. Build URLs ──────────────────────────────────────────
  const host = request.headers.get("host") ?? "localhost:3005";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const baseUrl = `${proto}://${host}`;

  try {
    // ── 9. Create Stripe Checkout Session ─────────────────────
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${baseUrl}/enroll/payment/${enrollment.enrollment_ref}?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/enroll/payment/${enrollment.enrollment_ref}?stripe=cancelled`,
      metadata: {
        tenant_id: enrollment.tenant_id,
        enrollment_id: enrollment.id,
        enrollment_ref: enrollment.enrollment_ref,
      },
    });

    // ── 10. Create payment record ────────────────────────────
    const { error: insertError } = await supabase.from("payments").insert({
      enrollment_id: enrollment.id,
      tenant_id: enrollment.tenant_id,
      amount: totalFee,
      payment_method: "stripe",
      status: "awaiting_payment",
      stripe_session_id: session.id,
    } as never);

    // Never hand out a checkout URL we could not record: the customer would pay
    // against a session no webhook can resolve to an enrollment.
    //
    // A local 500, not the provider 502 below — Stripe succeeded, our database
    // did not, and mislabelling would send someone debugging the wrong system.
    if (insertError) {
      console.error("[stripe] payment insert failed for session", session.id);
      try {
        await getStripe().checkout.sessions.expire(session.id);
      } catch {
        // Best-effort; must not replace the original failure.
        console.error("[stripe] session expire failed for", session.id);
      }
      return NextResponse.json(
      { error: "Internal Server Error", message: "Payment could not be recorded. No payment link was issued." },
      { status: 500 },
      );
    }

    return NextResponse.json({ url: session.url });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[stripe] createCheckoutSession error:", errMsg);
    return NextResponse.json(
      { error: "Payment Gateway Error", message: "Failed to create payment session. Please try again." },
      { status: 502 },
    );
  }
}
