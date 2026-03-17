import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import abank from "@/lib/abank";

// ─── POST /api/public/payments/abank ────────────────────────────────────────
// Creates an ABank MMQR order and returns a QR string for the user to scan.
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
    .select("*, classes(id, fee_mmk, level), enrollment_items(class_id, quantity, fee_mmk)")
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
      classes: { id: string; fee_mmk: number; level: string } | null;
      enrollment_items: { class_id: string; quantity: number; fee_mmk: number }[] | null;
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

  // ── 4. Calculate total fee ─────────────────────────────────
  const isCart =
    !enrollment.class_id &&
    enrollment.enrollment_items &&
    enrollment.enrollment_items.length > 0;

  let totalFee: number;

  if (isCart) {
    totalFee = enrollment.enrollment_items!.reduce(
      (sum, item) => sum + item.fee_mmk * item.quantity,
      0,
    );
  } else if (enrollment.classes) {
    const qty = enrollment.quantity ?? 1;
    totalFee = enrollment.classes.fee_mmk * qty;
  } else {
    return NextResponse.json(
      { error: "Internal Server Error", message: "Class data not found." },
      { status: 500 },
    );
  }

  // ── 5. Adjust for partial payment ──────────────────────────
  if (enrollment.status === "partial_payment") {
    const { data: existingPayment } = (await supabase
      .from("payments")
      .select("received_amount_mmk")
      .eq("enrollment_id", enrollment.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()) as { data: { received_amount_mmk: number | null } | null; error: unknown };

    if (existingPayment?.received_amount_mmk) {
      totalFee = totalFee - existingPayment.received_amount_mmk;
    }
  }

  // ── 6. Build orderId (≤ 20 chars) ─────────────────────────
  // Format: AB-{short-enrollment-id}-{timestamp-suffix}
  const ts = Date.now().toString(36); // ~8 chars
  const shortEnroll = enrollment.id.replace(/-/g, "").slice(0, 8);
  const orderId = `AB-${shortEnroll}-${ts}`.slice(0, 20);

  try {
    const result = await abank.createOrder({
      orderId,
      amount: totalFee,
      description: `Payment for ${enrollment.enrollment_ref}`,
    });

    // ── 7. Create payment record ─────────────────────────────
    await supabase.from("payments").insert({
      enrollment_id: enrollment.id,
      tenant_id: enrollment.tenant_id,
      amount_mmk: totalFee,
      payment_ref: orderId,
      payment_method: "abank_mmqr",
      mmqr_status: "PENDING",
      status: "pending",
    } as never);

    return NextResponse.json({
      qr: result.qr ?? null,
      orderId,
      amount: totalFee,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[abank] createOrder error:", errMsg);
    return NextResponse.json(
      { error: "Payment Gateway Error", message: "Failed to generate QR code. Please try again." },
      { status: 502 },
    );
  }
}
