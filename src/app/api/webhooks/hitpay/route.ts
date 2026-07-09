import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import hitpay from "@/lib/hitpay";
import { dispatchPaymentApproved } from "@/server/notifications/dispatchPaymentApproved";
import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";

// ─── POST /api/webhooks/hitpay ────────────────────────────────────────────────
// HitPay payment webhook. Verifies HMAC-SHA256 signature, confirms enrollment.
// Always returns 200 — HitPay retries on non-200.

export async function POST(request: NextRequest) {
  const bodyText = await request.text();

  // ── 1. Verify signature ────────────────────────────────────────────────────
  // HitPay includes the HMAC as an `hmac` field in the form-urlencoded body.
  const hmac = new URLSearchParams(bodyText).get("hmac") ?? "";
  if (!hmac) {
    console.warn("[hitpay-webhook] Missing hmac in payload");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const isValid = hitpay.verifyWebhook(bodyText, hmac);
    if (!isValid) {
      console.warn("[hitpay-webhook] Invalid signature");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch {
    console.warn("[hitpay-webhook] Signature verification error");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── 2. Parse payload ───────────────────────────────────────────────────────
  let payload: ReturnType<typeof hitpay.parseWebhookPayload>;
  try {
    payload = hitpay.parseWebhookPayload(bodyText);
  } catch {
    console.warn("[hitpay-webhook] Failed to parse payload");
    return NextResponse.json({ ok: true });
  }

  const supabase = createAdminClient();

  // ── 3. Handle failed status ────────────────────────────────────────────────
  if (payload.status === "failed") {
    const { data: payment } = (await supabase
      .from("payments")
      .select("id")
      .eq("hitpay_payment_id", payload.payment_request_id)
      .single()) as { data: { id: string } | null; error: unknown };

    if (payment) {
      await supabase
        .from("payments")
        .update({ status: "rejected" } as never)
        .eq("id", payment.id);
    }
    return NextResponse.json({ ok: true });
  }

  // ── 4. Only process completed ──────────────────────────────────────────────
  if (payload.status !== "completed") {
    return NextResponse.json({ ok: true });
  }

  // ── 5. Find payment by hitpay_payment_id ──────────────────────────────────
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, amount, status")
    .eq("hitpay_payment_id", payload.payment_request_id)
    .single()) as {
    data: { id: string; enrollment_id: string; amount: number; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    console.warn("[hitpay-webhook] Payment not found for hitpay_payment_id:", payload.payment_request_id);
    return NextResponse.json({ ok: true });
  }

  // ── 6. Replay guard ────────────────────────────────────────────────────────
  if (payment.status === "verified" || payment.status === "rejected") {
    return NextResponse.json({ ok: true });
  }

  // ── 7. Confirm payment + enrollment ───────────────────────────────────────
  const now = new Date().toISOString();

  await supabase
    .from("payments")
    .update({ status: "verified", verified_at: now, received_amount: payment.amount } as never)
    .eq("id", payment.id);

  await supabase
    .from("enrollments")
    .update({ status: "confirmed" } as never)
    .eq("id", payment.enrollment_id);

  // ── 8. Fetch notification data ─────────────────────────────────────────────
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select(
      "tenant_id, telegram_chat_id, email, phone, enrollment_ref, student_name_en, class_id, quantity, form_data, messenger_psid",
    )
    .eq("id", payment.enrollment_id)
    .single()) as {
    data: {
      tenant_id: string;
      telegram_chat_id: string | null;
      email: string | null;
      phone: string | null;
      enrollment_ref: string;
      student_name_en: string;
      class_id: string | null;
      quantity: number | null;
      form_data: Record<string, string> | null;
      messenger_psid: string | null;
    } | null;
    error: unknown;
  };

  if (!enrollment) return NextResponse.json({ ok: true });

  const host = request.headers.get("host") ?? "localhost:3005";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const statusUrl = `${proto}://${host}/status?ref=${enrollment.enrollment_ref}`;

  const { data: tenantInfo } = (await supabase
    .from("tenants")
    .select("name, org_type, logo_url, currency, sms_on_payment")
    .eq("id", enrollment.tenant_id)
    .single()) as {
    data: {
      name: string;
      org_type: string;
      logo_url: string | null;
      currency: string;
      sms_on_payment: boolean;
    } | null;
    error: unknown;
  };

  const tenantCurrency = tenantInfo?.currency ?? "SGD";
  let classLevel = "Ticket";
  let feeFormatted: string | undefined;
  const isCart = enrollment.class_id === null;

  if (isCart) {
    const { data: items } = (await supabase
      .from("enrollment_items")
      .select("quantity, fee_amount, classes(level)")
      .eq("enrollment_id", payment.enrollment_id)) as {
      data: { quantity: number; fee_amount: number; classes: { level: string } | null }[] | null;
      error: unknown;
    };
    if (items && items.length > 0) {
      classLevel = items
        .map((i) => (i.quantity > 1 ? `${i.classes?.level ?? "?"} x${i.quantity}` : (i.classes?.level ?? "?")))
        .join(", ");
      const total = items.reduce((s, i) => s + i.fee_amount * i.quantity, 0);
      feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${tenantCurrency}`;
    }
  } else {
    const { data: cls } = (await supabase
      .from("classes")
      .select("level, fee_amount")
      .eq("id", enrollment.class_id!)
      .single()) as { data: { level: string; fee_amount: number } | null; error: unknown };
    if (cls) {
      classLevel = cls.level;
      const total = cls.fee_amount * (enrollment.quantity ?? 1);
      feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${tenantCurrency}`;
    }
  }

  // ── 9. Dispatch notifications ──────────────────────────────────────────────
  await dispatchPaymentApproved({
    tenantId: enrollment.tenant_id,
    enrollmentId: payment.enrollment_id,
    enrollmentRef: enrollment.enrollment_ref,
    studentName: enrollment.student_name_en || "Student",
    classLevel,
    feeFormatted,
    statusUrl,
    paymentUrl: statusUrl,
    currency: tenantCurrency,
    email: enrollment.email || resolveEmailFromFormData(enrollment.form_data),
    phone: enrollment.phone || resolvePhoneFromFormData(enrollment.form_data),
    messengerPsid: enrollment.messenger_psid,
    telegramChatId: enrollment.telegram_chat_id,
    classId: enrollment.class_id,
    tenantName: tenantInfo?.name,
    orgType: tenantInfo?.org_type,
    logoUrl: tenantInfo?.logo_url ?? undefined,
    smsOnPayment: tenantInfo?.sms_on_payment,
  });

  return NextResponse.json({ ok: true });
}
