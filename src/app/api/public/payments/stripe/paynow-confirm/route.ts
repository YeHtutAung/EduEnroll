import { NextRequest, NextResponse } from "next/server";
import { resolveTenantId } from "@/lib/api";
import { getStripe } from "@/lib/stripe";
import { validateStripeAttempt } from "@/server/payments/validateStripeAttempt";

// ─── POST /api/public/payments/stripe/paynow-confirm ─────────────────────────
// Confirms a PaymentIntent with PayNow on the server side and returns
// the QR code image URL for display. Server-side confirmation is required
// because Stripe.js confirmPayNowPayment does not reliably attach the
// payment method on PaymentIntents with multiple payment_method_types.

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  let body: { paymentIntentId?: string; enrollmentRef?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON." }, { status: 400 });
  }

  const { paymentIntentId, enrollmentRef } = body;
  if (!paymentIntentId || !enrollmentRef) {
    return NextResponse.json(
      { error: "Bad Request", message: "paymentIntentId and enrollmentRef are required." },
      { status: 400 },
    );
  }

  // Revalidate immediately before confirmation. The old route checked only
  // existence, so a rejected enrollment could generate a fresh PayNow QR and
  // take money after its seat had been released.
  const eligibility = await validateStripeAttempt({ tenantId, enrollmentRef, paymentIntentId });
  if (eligibility.kind === "not_found") {
    return NextResponse.json({ error: "Not Found", message: "Enrollment not found." }, { status: 404 });
  }
  if (eligibility.kind === "ineligible") {
    return NextResponse.json(
      { error: "Conflict", message: "This enrollment is no longer awaiting payment." },
      { status: 409 },
    );
  }
  if (eligibility.kind === "retryable") {
    console.error("[paynow-confirm] eligibility lookup failed:", eligibility.reason);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Could not verify payment eligibility." },
      { status: 500 },
    );
  }

  try {
    const stripe = getStripe();

    // Retrieve to check current status
    const existing = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (existing.status === "succeeded") {
      return NextResponse.json({ alreadyPaid: true });
    }

    // Create a PayNow PaymentMethod, then confirm the PaymentIntent with it.
    // Two-step approach: payment_method_data inline is unreliable for PayNow
    // on PaymentIntents with multiple payment_method_types.
    const pm = await (stripe.paymentMethods.create as (params: Record<string, unknown>) => Promise<{ id: string }>).call(stripe.paymentMethods, { type: "paynow" });
    const pi = await stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method: pm.id,
      return_url: "https://kuunyi.com", // required field; PayNow uses QR, not redirect
    });

    const qrCode = (pi.next_action as unknown as {
      paynow_display_qr_code?: { image_url_svg?: string };
    } | null)?.paynow_display_qr_code;

    if (!qrCode?.image_url_svg) {
      return NextResponse.json(
        { error: "QR generation failed", message: "Could not generate PayNow QR code." },
        { status: 502 },
      );
    }

    return NextResponse.json({ qrImageUrl: qrCode.image_url_svg });
  } catch (err) {
    const code = (err as { code?: string }).code ?? "stripe_error";
    console.error("[paynow-confirm] Stripe request failed:", code);
    return NextResponse.json(
      { error: "Payment Gateway Error", message: "Could not start PayNow. Please try again." },
      { status: 502 },
    );
  }
}
