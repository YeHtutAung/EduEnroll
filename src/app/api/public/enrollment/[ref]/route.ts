import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { getStripe } from "@/lib/stripe";

// ─── GET /api/public/enrollment/[ref] ────────────────────────────────────────
// Returns enrollment summary for the Trusted Official checkout flow.
// Public — enrollment_ref acts as the access token.

export async function GET(
  _request: NextRequest,
  { params }: { params: { ref: string } },
) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const supabase = createAdminClient();

  const { data: enrollment, error } = (await supabase
    .from("enrollments")
    .select(`
      enrollment_ref, status, student_name_en, email,
      enrollment_items(quantity, fee_amount, classes(level)),
      classes(level, fee_amount, intakes(name, slug)),
      quantity,
      payments(stripe_payment_intent_id, status, payment_method, card_brand, card_last4)
    `)
    .eq("enrollment_ref", params.ref.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: EnrollmentRow | null; error: unknown };

  if (error || !enrollment) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  if (enrollment.status === "cancelled") {
    return NextResponse.json({ error: "Gone", message: "This order has expired." }, { status: 410 });
  }

  // Build items list (cart or single class)
  const items =
    enrollment.enrollment_items && enrollment.enrollment_items.length > 0
      ? enrollment.enrollment_items.map((i) => ({
          level: (i.classes as { level: string } | null)?.level ?? "Ticket",
          quantity: i.quantity,
          fee_amount: i.fee_amount,
        }))
      : enrollment.classes
      ? [{ level: enrollment.classes.level, quantity: enrollment.quantity ?? 1, fee_amount: enrollment.classes.fee_amount }]
      : [];

  const totalAmount = items.reduce((s, i) => s + i.fee_amount * i.quantity, 0);

  // Conditionally retrieve stripe client_secret if an active PaymentIntent exists
  let stripeClientSecret: string | undefined;
  const payments = enrollment.payments as PaymentRow[] | null;
  const activePayment = payments?.find(
    (p) => p.payment_method === "stripe" && p.status === "awaiting_payment" && p.stripe_payment_intent_id,
  );
  if (activePayment?.stripe_payment_intent_id) {
    try {
      const pi = await getStripe().paymentIntents.retrieve(activePayment.stripe_payment_intent_id);
      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(pi.status)) {
        stripeClientSecret = pi.client_secret ?? undefined;
      }
    } catch {
      // Stripe API error — omit client_secret, client will handle
    }
  }

  const verifiedPayment = payments?.find((p) => p.status === "verified");

  return NextResponse.json({
    enrollment_ref: enrollment.enrollment_ref,
    status: enrollment.status,
    student_name_en: enrollment.student_name_en ?? "",
    email: enrollment.email ?? "",
    total_amount: totalAmount,
    items,
    event_name: (enrollment.classes as { intakes?: { name: string } | null } | null)?.intakes?.name ?? "",
    payment_method: verifiedPayment?.payment_method ?? null,
    card_brand: verifiedPayment?.card_brand ?? null,
    card_last4: verifiedPayment?.card_last4 ?? null,
    ...(stripeClientSecret ? { stripe_client_secret: stripeClientSecret } : {}),
  });
}

// ─── PATCH /api/public/enrollment/[ref] ──────────────────────────────────────
// Updates attendee details on a pending enrollment. Idempotent.

export async function PATCH(
  request: NextRequest,
  { params }: { params: { ref: string } },
) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  let body: { student_name_en?: string; company?: string; email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON." }, { status: 400 });
  }

  const { student_name_en, company, email } = body;
  if (!student_name_en || !email) {
    return NextResponse.json({ error: "Bad Request", message: "student_name_en and email are required." }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, status")
    .eq("enrollment_ref", params.ref.trim())
    .eq("tenant_id", tenantId)
    .single()) as { data: { id: string; status: string } | null; error: unknown };

  if (!enrollment) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
  if (enrollment.status !== "pending_payment") {
    return NextResponse.json({ error: "Conflict", message: "This order is no longer pending." }, { status: 409 });
  }

  await supabase
    .from("enrollments")
    .update({
      student_name_en: student_name_en.trim(),
      email: email.trim(),
      ...(company ? { form_data: { company: company.trim() } } : {}),
    } as never)
    .eq("id", enrollment.id);

  return NextResponse.json({ enrollment_ref: params.ref, status: enrollment.status });
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface PaymentRow {
  stripe_payment_intent_id: string | null;
  status: string;
  payment_method: string;
  card_brand: string | null;
  card_last4: string | null;
}

interface EnrollmentRow {
  enrollment_ref: string;
  status: string;
  student_name_en: string | null;
  email: string | null;
  quantity: number | null;
  enrollment_items: { quantity: number; fee_amount: number; classes: { level: string } | null }[] | null;
  classes: { level: string; fee_amount: number; intakes: { name: string; slug: string } | null } | null;
  payments: PaymentRow[] | null;
}
