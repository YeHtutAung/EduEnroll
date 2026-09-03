import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import hitpay from "@/lib/hitpay";
import { tenantOrigin } from "@/lib/origin";
import { isAllowedRedirect } from "@/lib/payments/redirect-allowlist";
import { resolveOrderTotal } from "@/server/payments/platformFee";

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
      "id, enrollment_ref, tenant_id, status, student_name_en, email, class_id, quantity, classes(id, fee_amount, level), enrollment_items(class_id, quantity, fee_amount), tenants(subdomain)",
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
      // Joined so the redirect allowlist can build the tenant's canonical
      // origin without a second round trip.
      tenants: { subdomain: string } | null;
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

  // Online platform fee. Resolved by the shared calculator rather than worked
  // out here, so no two payment routes can disagree about the amount — a
  // disagreement surfaces as amount_mismatch at settlement, after the payer
  // has already been charged.
  const { platformFee } = await resolveOrderTotal(supabase, enrollment);
  totalFee += platformFee;
  // What THIS ROW records. The partial-payment branch below charges a
  // remainder rather than the order total, and a remainder is not the row that
  // quoted the fee — the row that did keeps it, and this one records none.
  let recordedFee = platformFee;

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
      recordedFee = 0;
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
  // Two untrusted paths, both closed here:
  //   1. A supplied redirectUrl is client input — unvalidated it turns a genuine
  //      HitPay link into a phishing redirect.
  //   2. The fallback used to take its origin from the inbound Host, which is
  //      also request data.

  // Card only, structurally — and that includes every dependency the redirect
  // needs, not just the validation. PayNow never receives a redirectUrl, so
  // nothing here may run for it: neither a rogue body field nor a missing
  // tenant join may affect a PayNow payment.
  let redirectUrl: string | undefined;
  if (hitpayMethod === "card") {
    // Fail closed. `?? ""` would fail OPEN: tenantOrigin() returns the PLATFORM
    // ROOT for a falsy subdomain, so a join that came back missing or reshaped
    // would silently allowlist kuunyi.com — the one origin this design excludes
    // — and aim the fallback at a page that does not exist. The column is
    // non-null, so this should be unreachable; if it fires, the join is wrong.
    const subdomain = enrollment.tenants?.subdomain;
    if (!subdomain) {
      console.error("[hitpay] Tenant subdomain missing for enrollment", enrollment.id);
      return NextResponse.json(
        { error: "Internal Server Error", message: "Tenant origin could not be resolved." },
        { status: 500 },
      );
    }

    // nextUrl.origin, NOT a host/proto guess: `host.startsWith("localhost")`
    // would label tenant.localhost:3005 and 192.168.50.3:3005 as https while the
    // browser sends http, and exact-origin comparison would reject real dev
    // traffic.
    const requestOrigin = request.nextUrl.origin;

    // Trusted origin + the canonical DB ref (the client's enrollmentRef is only
    // trimmed for the lookup, so the raw value can differ from what matched).
    redirectUrl =
      `${tenantOrigin(subdomain)}/enroll/payment/` +
      `${encodeURIComponent(enrollment.enrollment_ref)}?hitpay=success`;

    if (clientRedirectUrl !== undefined) {
      if (
        typeof clientRedirectUrl !== "string" ||
        !isAllowedRedirect(clientRedirectUrl, subdomain, requestOrigin)
      ) {
        // Reject rather than silently substituting the fallback: a rejected
        // value is either an attack or a broken client, and both should surface.
        return NextResponse.json(
          { error: "Bad Request", message: "Invalid redirect origin." },
          { status: 400 },
        );
      }
      redirectUrl = clientRedirectUrl;
    }
  }

  // ── 8. Call HitPay API ─────────────────────────────────────────────────────
  try {
    const result = await hitpay.createPaymentRequest({
      amount: totalFee.toFixed(2),
      currency: "SGD",
      method: hitpayMethod,
      referenceNumber: enrollment.enrollment_ref,
      name: enrollment.student_name_en || undefined,
      email: enrollment.email || undefined,
      redirectUrl,
    });

    // ── 9. Insert payment record ───────────────────────────────────────────────
    const { error: insertError } = await supabase.from("payments").insert({
      enrollment_id: enrollment.id,
      tenant_id: enrollment.tenant_id,
      amount: totalFee,
      platform_fee: recordedFee,
      payment_method: "hitpay",
      hitpay_payment_id: result.id,
      status: "awaiting_payment",
    } as never);

    // Never hand out a QR or card URL we could not record. Cleanup is deferred:
    // the HitPay wrapper exposes create/verify/parse only, with no cancellation
    // (#186). No `detail` field here — a database error must not reach the
    // public body.
    if (insertError) {
      console.error("[hitpay] payment insert failed for request", result.id);
      return NextResponse.json(
      { error: "Internal Server Error", message: "Payment could not be recorded. No payment link was issued." },
      { status: 500 },
      );
    }

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
    // Neither returned nor logged. The provider body can carry customer data
    // and internal tokens, so the only diagnostic recorded is the HTTP status
    // the wrapper attaches — the error message itself is never logged, since
    // truncating a body is not the same as sanitizing it.
    const status = (err as { status?: number } | null)?.status;
    console.error(
      "[hitpay] createPaymentRequest failed",
      typeof status === "number" ? `(HTTP ${status})` : "(no status)",
    );
    return NextResponse.json(
      {
        error: "Payment Gateway Error",
        message: "Failed to create HitPay payment. Please try again.",
      },
      { status: 502 },
    );
  }
}
