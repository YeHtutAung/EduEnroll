import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import mmpay from "@/lib/mmpay";
import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";

// ─── POST /api/public/payments/mmqr/webhook ─────────────────────────────────
// MyanMyanPay webhook callback handler.
// Verifies HMAC signature, then updates payment + enrollment status.

export async function POST(request: NextRequest) {
  // ── 1. Read headers and body ───────────────────────────────
  const signature = request.headers.get("x-mmpay-signature") ?? "";
  const nonce = request.headers.get("x-mmpay-nonce") ?? "";
  const bodyText = await request.text();

  // ── 2. Verify HMAC signature ───────────────────────────────
  const isValid = await mmpay.verifyCb(bodyText, nonce, signature);
  if (!isValid) {
    console.warn("[mmqr-webhook] Invalid signature");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── 3. Parse payload ───────────────────────────────────────
  let payload: {
    orderId: string;
    amount: number;
    currency: string;
    vendor: string;
    method: string;
    status: "PENDING" | "SUCCESS" | "FAILED" | "REFUNDED";
    condition: string;
    transactionRefId: string;
  };

  try {
    payload = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: "Bad Request" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── 4. Find payment by payment_ref ─────────────────────────
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, status")
    .eq("payment_ref", payload.orderId)
    .single()) as {
    data: { id: string; enrollment_id: string; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    console.warn("[mmqr-webhook] Payment not found for orderId:", payload.orderId);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  // Skip if payment already finalized
  if (payment.status === "verified" || payment.status === "rejected") {
    return NextResponse.json({ message: "Already processed" }, { status: 200 });
  }

  // ── 5. Update based on status ──────────────────────────────
  if (payload.status === "SUCCESS") {
    // Update payment to verified
    await supabase
      .from("payments")
      .update({
        mmqr_status: "SUCCESS",
        status: "verified",
        paid_at: new Date().toISOString(),
        bank_reference: payload.transactionRefId,
      } as never)
      .eq("id", payment.id);

    // Update enrollment to confirmed
    await supabase
      .from("enrollments")
      .update({ status: "confirmed" } as never)
      .eq("id", payment.enrollment_id);

    // Send notifications (best-effort)
    const { data: enrollment } = (await supabase
      .from("enrollments")
      .select("tenant_id, telegram_chat_id, email, enrollment_ref, student_name_en, class_id, quantity, form_data")
      .eq("id", payment.enrollment_id)
      .single()) as {
      data: {
        tenant_id: string;
        telegram_chat_id: string | null;
        email: string | null;
        enrollment_ref: string;
        student_name_en: string;
        class_id: string | null;
        quantity: number | null;
        form_data: Record<string, string> | null;
      } | null;
      error: unknown;
    };

    if (enrollment) {
      // Resolve email: column first, then form_data custom email field
      const enrollEmail = enrollment.email
        || (enrollment.form_data && Object.entries(enrollment.form_data).find(([k]) => k === "email" || k.startsWith("custom_email_"))?.[1])
        || null;
      const host = request.headers.get("host") ?? "localhost:3005";
      const proto = host.startsWith("localhost") ? "http" : "https";
      const statusUrl = `${proto}://${host}/status?ref=${enrollment.enrollment_ref}`;

      // Resolve class level
      let classLevel = "Ticket";
      let feeFormatted: string | undefined;
      const isCart = enrollment.class_id === null;

      if (isCart) {
        const { data: items } = (await supabase
          .from("enrollment_items")
          .select("quantity, fee_mmk, classes(level)")
          .eq("enrollment_id", payment.enrollment_id)) as {
          data: { quantity: number; fee_mmk: number; classes: { level: string } | null }[] | null;
          error: unknown;
        };
        if (items && items.length > 0) {
          classLevel = items
            .map((i) => (i.quantity > 1 ? `${i.classes?.level ?? "?"} x${i.quantity}` : (i.classes?.level ?? "?")))
            .join(", ");
          const total = items.reduce((s, i) => s + i.fee_mmk * i.quantity, 0);
          feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} MMK`;
        }
      } else {
        const { data: cls } = (await supabase
          .from("classes")
          .select("level, fee_mmk")
          .eq("id", enrollment.class_id!)
          .single()) as { data: { level: string; fee_mmk: number } | null; error: unknown };
        if (cls) {
          classLevel = cls.level;
          const total = cls.fee_mmk * (enrollment.quantity ?? 1);
          feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} MMK`;
        }
      }

      // Fetch tenant info for email branding
      const { data: tenantInfo } = (await supabase
        .from("tenants")
        .select("name, org_type, logo_url")
        .eq("id", enrollment.tenant_id)
        .single()) as {
        data: { name: string; org_type: string; logo_url: string | null } | null;
        error: unknown;
      };

      // Telegram notification
      if (enrollment.telegram_chat_id) {
        sendTelegramStatusNotification({
          tenantId: enrollment.tenant_id,
          telegramChatId: enrollment.telegram_chat_id,
          action: "approve",
          studentName: enrollment.student_name_en || "Student",
          enrollmentRef: enrollment.enrollment_ref,
          classLevel,
          statusUrl,
          paymentUrl: statusUrl,
        }).catch((err) => {
          console.error("[mmqr-webhook] Telegram notification failed:", err);
        });
      }

      // Email notification
      if (enrollEmail) {
        const emailData = enrollmentApprovedEmail({
          studentName: enrollment.student_name_en || "Student",
          enrollmentRef: enrollment.enrollment_ref,
          classLevel,
          statusUrl,
          feeFormatted,
          orgType: tenantInfo?.org_type,
          tenantName: tenantInfo?.name,
          logoUrl: tenantInfo?.logo_url ?? undefined,
        });
        sendEmail({ to: enrollEmail, ...emailData }).catch((err) => {
          console.error("[mmqr-webhook] Approval email failed:", err);
        });
      }

      // Channel invite (language_school only, gated inside)
      if (enrollment.telegram_chat_id) {
        sendChannelInviteIfEligible({
          tenantId: enrollment.tenant_id,
          enrollmentId: payment.enrollment_id,
          classId: enrollment.class_id,
          telegramChatId: enrollment.telegram_chat_id,
          studentName: enrollment.student_name_en || "Student",
        }).catch((err) => {
          console.error("[mmqr-webhook] Channel invite failed:", err);
        });
      }
    }
  } else if (payload.status === "FAILED") {
    await supabase
      .from("payments")
      .update({
        mmqr_status: "FAILED",
      } as never)
      .eq("id", payment.id);
  } else if (payload.status === "REFUNDED") {
    await supabase
      .from("payments")
      .update({
        mmqr_status: "REFUNDED",
        status: "rejected",
      } as never)
      .eq("id", payment.id);
  }

  return NextResponse.json({ message: "OK" }, { status: 200 });
}
