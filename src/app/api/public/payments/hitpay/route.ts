import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import hitpay from "@/lib/hitpay";

// ─── POST /api/public/payments/hitpay ─────────────────────────────────────────
// Creates a HitPay payment request for PayNow QR or Card.
// Body: { enrollmentRef: string, method: "paynow_online" | "card" }

const ALLOWED_METHODS = ["paynow_online", "card"] as const;
type HitPayMethod = (typeof ALLOWED_METHODS)[number];

export async function POST(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  // ── 1. Parse body ──────────────────────────────────────────────────────────
  let body: { enrollmentRef?: string; method?: string; redirectUrl?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const { enrollmentRef, method, redirectUrl: clientRedirectUrl } = body;

  if (!enrollmentRef || typeof enrollmentRef !== "string") {
    return NextResponse.json(
      { error: "Bad Request", message: "enrollmentRef is required." },
      { status: 400 },
    );
  }
  if (!method || !ALLOWED_METHODS.includes(method as HitPayMethod)) {
    return NextResponse.json(
      {
        error: "Bad Request",
        message: `method must be one of: ${ALLOWED_METHODS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const hitpayMethod = method as HitPayMethod;
  const supabase = createAdminClient();

  // ── 2. Look up enrollment ──────────────────────────────────────────────────
  const { data: enrollment, error: enrollmentError } = (await supabase
    .from("enrollments")
    .select(
      "id, enrollment_ref, tenant_id, status, student_name_en, email, class_id, quantity, classes(id, fee_amount, level), enrollment_items(class_id, quantity, fee_amount)",
    )
    .eq("enrollment_ref", enrollmentRef.trim())
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      id: string;
      enrollment_ref: string;
      tenant_id: string;
      status: string;
      student_name_en: string;
      email: string | null;
      class_id: string | null;
      quantity: number | null;
      classes: { id: string; fee_amount: number; level: string } | null;
      enrollment_items: { class_id: string; quantity: number; fee_amount: number }[] | null;
    } | null;
    error: unknown;
  };

  if (enrollmentError || !enrollment) {
    return NextResponse.json(
      { error: "Not Found", message: "Enrollment not found." },
      { status: 404 },
    );
  }

  // ── 3. Guard: only pending_payment or partial_payment ──────────────────────
  if (enrollment.status !== "pending_payment" && enrollment.status !== "partial_payment") {
    return NextResponse.json(
      { error: "Conflict", message: "This enrollment is not awaiting payment." },
      { status: 409 },
    );
  }

  // ── 4. Calculate total fee ─────────────────────────────────────────────────
  const isCart =
    !enrollment.class_id &&
    enrollment.enrollment_items &&
    enrollment.enrollment_items.length > 0;

  let totalFee: number;

  if (isCart) {
    totalFee = enrollment.enrollment_items!.reduce(
      (s, i) => s + i.fee_amount * i.quantity,
      0,
    );
  } else if (enrollment.classes) {
    totalFee = enrollment.classes.fee_amount * (enrollment.quantity ?? 1);
  } else {
    return NextResponse.json(
      { error: "Internal Server Error", message: "Class data not found." },
      { status: 500 },
    );
  }

  // ── 5. Adjust for partial payment ──────────────────────────────────────────
  if (enrollment.status === "partial_payment") {
    const { data: existingPayment } = (await supabase
      .from("payments")
      .select("received_amount")
      .eq("enrollment_id", enrollment.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()) as { data: { received_amount: number | null } | null; error: unknown };

    if (existingPayment?.received_amount) {
      totalFee = totalFee - existingPayment.received_amount;
    }
  }

  // ── 6. Duplicate guard (PayNow only) ──────────────────────────────────────
  // Only guard PayNow — card payments redirect away so they can't be double-tapped.
  // If the student switches from PayNow to Card, we need a fresh card request.
  if (hitpayMethod === "paynow_online") {
    const { data: existingHitPay } = (await supabase
      .from("payments")
      .select("hitpay_payment_id")
      .eq("enrollment_id", enrollment.id)
      .not("hitpay_payment_id", "is", null)
      .eq("status", "awaiting_payment")
      .single()) as { data: { hitpay_payment_id: string | null } | null; error: unknown };

    if (existingHitPay?.hitpay_payment_id) {
      return NextResponse.json({
        paymentRequestId: existingHitPay.hitpay_payment_id,
        amount: totalFee,
      });
    }
  }

  // ── 7. Build redirect URL (card only) ──────────────────────────────────────
  // Prefer client-supplied redirectUrl (the client knows its own page path).
  // Fall back to the generic payment page path for backwards compatibility.
  const host = request.headers.get("host") ?? "localhost:3005";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const fallbackRedirectUrl = `${proto}://${host}/enroll/payment/${encodeURIComponent(enrollmentRef)}?hitpay=success`;
  const redirectUrl = clientRedirectUrl ?? fallbackRedirectUrl;

  // ── 8. Call HitPay API ─────────────────────────────────────────────────────
  try {
    const result = await hitpay.createPaymentRequest({
      amount: totalFee.toFixed(2),
      currency: "SGD",
      method: hitpayMethod,
      referenceNumber: enrollment.enrollment_ref,
      name: enrollment.student_name_en || undefined,
      email: enrollment.email || undefined,
      redirectUrl: hitpayMethod === "card" ? redirectUrl : undefined,
    });

    // ── 9. Insert payment record ───────────────────────────────────────────────
    await supabase.from("payments").insert({
      enrollment_id: enrollment.id,
      tenant_id: enrollment.tenant_id,
      amount: totalFee,
      payment_method: "hitpay",
      hitpay_payment_id: result.id,
      status: "awaiting_payment",
    } as never);

    if (hitpayMethod === "paynow_online") {
      return NextResponse.json({
        qrCode: result.qr_code_data?.qr_code ?? null,
        paymentRequestId: result.id,
        amount: totalFee,
      });
    } else {
      return NextResponse.json({
        url: result.url,
        paymentRequestId: result.id,
        amount: totalFee,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[hitpay] createPaymentRequest error:", errMsg);
    return NextResponse.json(
      {
        error: "Payment Gateway Error",
        message: "Failed to create HitPay payment. Please try again.",
        detail: errMsg,
      },
      { status: 502 },
    );
  }
}
