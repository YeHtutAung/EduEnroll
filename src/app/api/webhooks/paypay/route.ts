import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import paypay from "@/lib/paypay";
import { issueTicketsForEnrollment } from "@/server/tickets/issueTickets";
import { dispatchPaymentApproved } from "@/server/notifications/dispatchPaymentApproved";
import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";

// ─── POST /api/webhooks/paypay ───────────────────────────────
// PayPay transaction webhook handler.
// Verifies webhook signature, then updates payment + enrollment status.

export async function POST(request: NextRequest) {
  // ── 1. Read headers and body ─────────────────────────────────
  const signature = request.headers.get("x-paypay-signature") ?? "";
  const bodyText = await request.text();

  // ── 2. Verify webhook signature ──────────────────────────────
  if (signature) {
    try {
      const isValid = paypay.verifyWebhook(bodyText, signature);
      if (!isValid) {
        console.warn("[paypay-webhook] Invalid signature");
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } catch {
      console.warn("[paypay-webhook] Signature verification error");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    // Reject missing signatures in production — only allow in sandbox
    if (process.env.PAYPAY_MODE === "production") {
      console.warn("[paypay-webhook] Missing signature in production — rejecting");
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.warn("[paypay-webhook] No signature header — allowing in sandbox mode");
  }

  // ── 3. Parse webhook payload ─────────────────────────────────
  let data: ReturnType<typeof paypay.parseWebhookPayload>["data"];
  try {
    const parsed = paypay.parseWebhookPayload(bodyText);
    data = parsed.data;
  } catch {
    console.warn("[paypay-webhook] Failed to parse payload");
    return NextResponse.json({ error: "Bad Request" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── 4. Find payment by merchantPaymentId ─────────────────────
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, amount, status")
    .eq("payment_ref", data.merchantPaymentId)
    .single()) as {
    data: { id: string; enrollment_id: string; amount: number; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    console.warn("[paypay-webhook] Payment not found for merchantPaymentId:", data.merchantPaymentId);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  // Skip if already finalized (idempotent)
  if (payment.status === "verified" || payment.status === "rejected") {
    return NextResponse.json({ message: "Already processed" }, { status: 200 });
  }

  // ── 5. Update based on state ─────────────────────────────────
  if (data.state === "COMPLETED") {
    await supabase
      .from("payments")
      .update({
        paypay_status: "COMPLETED",
        status: "verified",
        paid_at: new Date().toISOString(),
        bank_reference: data.paymentId,
        received_amount: payment.amount,
      } as never)
      .eq("id", payment.id);

    await supabase
      .from("enrollments")
      .update({ status: "confirmed" } as never)
      .eq("id", payment.enrollment_id);

    try {
      await issueTicketsForEnrollment(payment.enrollment_id);
    } catch (err) {
      console.error("[tickets] issueTicketsForEnrollment failed:", err);
    }

    // Send notifications
    const { data: enrollment } = (await supabase
      .from("enrollments")
      .select("tenant_id, telegram_chat_id, email, phone, enrollment_ref, student_name_en, class_id, quantity, form_data")
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
      } | null;
      error: unknown;
    };

    if (enrollment) {
      // Use the configured app origin, not the inbound Host header (spoofable).
      const appOrigin = process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com";
      const statusUrl = `${appOrigin}/status?ref=${enrollment.enrollment_ref}`;

      const { data: tenantInfo } = (await supabase
        .from("tenants")
        .select("name, org_type, logo_url, currency, sms_on_payment")
        .eq("id", enrollment.tenant_id)
        .single()) as {
        data: { name: string; org_type: string; logo_url: string | null; currency: string; sms_on_payment: boolean } | null;
        error: unknown;
      };
      const tenantCurrency = tenantInfo?.currency ?? "JPY";

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
        telegramChatId: enrollment.telegram_chat_id,
        classId: enrollment.class_id,
        tenantName: tenantInfo?.name,
        orgType: tenantInfo?.org_type,
        logoUrl: tenantInfo?.logo_url ?? undefined,
        smsOnPayment: tenantInfo?.sms_on_payment,
      });
    }
  } else if (data.state === "FAILED") {
    await supabase
      .from("payments")
      .update({ paypay_status: "FAILED" } as never)
      .eq("id", payment.id);
  } else if (data.state === "CANCELED") {
    await supabase
      .from("payments")
      .update({ paypay_status: "CANCELED", status: "rejected" } as never)
      .eq("id", payment.id);
  } else if (data.state === "EXPIRED") {
    await supabase
      .from("payments")
      .update({ paypay_status: "EXPIRED" } as never)
      .eq("id", payment.id);
  }

  // PayPay expects 200 OK response
  return NextResponse.json({ message: "OK" }, { status: 200 });
}
