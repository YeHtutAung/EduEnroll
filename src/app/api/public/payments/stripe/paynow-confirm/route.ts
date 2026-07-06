import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { getStripe } from "@/lib/stripe";

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

  // Verify the enrollment belongs to this tenant
  const supabase = createAdminClient();
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id")
    .eq("enrollment_ref", enrollmentRef.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: { id: string } | null; error: unknown };

  if (!enrollment) {
    return NextResponse.json({ error: "Not Found", message: "Enrollment not found." }, { status: 404 });
  }

  try {
    const stripe = getStripe();

    // Retrieve to check current status
    const existing = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (existing.status === "succeeded") {
      return NextResponse.json({ alreadyPaid: true });
    }

    // Confirm with PayNow payment method
    const pi = await stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method_data: { type: "paynow" },
    } as never);

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
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[paynow-confirm] error:", msg);
    return NextResponse.json(
      { error: "Payment Gateway Error", message: msg },
      { status: 502 },
    );
  }
}
