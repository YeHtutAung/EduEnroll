import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import mmpay from "@/lib/mmpay";

// ─── POST /api/public/payments/mmqr ─────────────────────────────────────────
// Creates an MMQR payment via MyanMyanPay and returns a QR code.
//
// Body: { enrollmentRef: string }
//
// Looks up the enrollment + calculates total fee, then calls MyanMyanPay SDK.

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
  let items: { name: string; amount: number; quantity: number }[];

  if (isCart) {
    totalFee = enrollment.enrollment_items!.reduce(
      (sum, item) => sum + item.fee_mmk * item.quantity,
      0,
    );
    items = enrollment.enrollment_items!.map((item) => ({
      name: `Enrollment item`,
      amount: item.fee_mmk,
      quantity: item.quantity,
    }));
  } else if (enrollment.classes) {
    const qty = enrollment.quantity ?? 1;
    totalFee = enrollment.classes.fee_mmk * qty;
    items = [
      {
        name: enrollment.classes.level,
        amount: enrollment.classes.fee_mmk,
        quantity: qty,
      },
    ];
  } else {
    return NextResponse.json(
      { error: "Internal Server Error", message: "Class data not found." },
      { status: 500 },
    );
  }

  // ── 5. Check for partial payment — reduce amount by received ──
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

  // ── 6. Generate orderId and call MyanMyanPay ───────────────
  const orderId = `KNY-${tenantId.slice(0, 8)}-${enrollment.id.slice(0, 8)}-${Date.now()}`;

  // Derive callback URL from the incoming request host
  const host = request.headers.get("host") ?? "kuunyi.com";
  const protocol = host.includes("localhost") ? "http" : "https";
  const callbackUrl = `${protocol}://${host}/api/public/payments/mmqr/webhook`;

  // Use sandbox or production based on env var (default: sandbox)
  const useProd = process.env.MMPAY_MODE === "production";

  try {
    const pay = useProd ? mmpay.pay : mmpay.sandboxPay;
    const result = await pay({
      orderId,
      amount: totalFee,
      currency: "MMK",
      callbackUrl,
      items,
    });

    // ── 7. Create payment record with MMQR method ────────────
    await supabase.from("payments").insert({
      enrollment_id: enrollment.id,
      tenant_id: enrollment.tenant_id,
      amount_mmk: totalFee,
      payment_ref: orderId,
      payment_method: "mmqr",
      mmqr_status: "PENDING",
      status: "pending",
    } as never);

    return NextResponse.json({
      qr: result.qr ?? null,
      orderId,
      amount: totalFee,
      transactionRefId: result.transactionRefId ?? null,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[mmqr] MyanMyanPay SDK error:", errMsg);
    return NextResponse.json(
      { error: "Payment Gateway Error", message: "Failed to generate QR code. Please try again.", detail: errMsg },
      { status: 502 },
    );
  }
}
