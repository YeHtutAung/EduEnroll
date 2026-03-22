import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import abank from "@/lib/abank";
import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";

// ─── GET /api/public/payments/abank/status?ref=AB-xxx ───────────────────────
// Polls ABank enquiry API and updates local payment record.
// Returns: { status: "PENDING" | "SUCCESS" | "FAILED" | "REFUNDED" | "NOT_FOUND" }

const STATUS_MAP: Record<number, string> = {
  200: "SUCCESS",
  100: "PENDING",
  500: "FAILED",
  400: "REFUNDED",
  403: "NOT_FOUND",
};

export async function GET(request: NextRequest) {
  const paymentRef = request.nextUrl.searchParams.get("ref");
  if (!paymentRef) {
    return NextResponse.json(
      { error: "Bad Request", message: "ref is required." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // Check local DB first — if already finalized, skip API call
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, mmqr_status, status")
    .eq("payment_ref", paymentRef)
    .single()) as {
    data: { id: string; enrollment_id: string; mmqr_status: string; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    return NextResponse.json({ mmqr_status: "PENDING" });
  }

  // Already finalized locally (via callback or previous poll)
  if (payment.mmqr_status === "SUCCESS" || payment.status === "verified") {
    return NextResponse.json({ mmqr_status: "SUCCESS" });
  }
  if (payment.mmqr_status === "FAILED") {
    return NextResponse.json({ mmqr_status: "FAILED" });
  }

  // Poll ABank enquiry API
  try {
    const enquiry = await abank.enquiryOrder(paymentRef);
    const txnData = enquiry.data;
    const txnStatus = STATUS_MAP[txnData.paymentTxnStatus] ?? "PENDING";

    if (txnStatus === "SUCCESS") {
      // Update payment + enrollment
      await supabase
        .from("payments")
        .update({
          mmqr_status: "SUCCESS",
          status: "verified",
          paid_at: new Date().toISOString(),
          bank_reference: txnData.transactionId ?? null,
        } as never)
        .eq("id", payment.id);

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
            console.error("[abank-status] Telegram notification failed:", err);
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
            console.error("[abank-status] Approval email failed:", err);
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
            console.error("[abank-status] Channel invite failed:", err);
          });
        }
      }
    } else if (txnStatus === "FAILED") {
      await supabase
        .from("payments")
        .update({ mmqr_status: "FAILED" } as never)
        .eq("id", payment.id);
    } else if (txnStatus === "REFUNDED") {
      await supabase
        .from("payments")
        .update({ mmqr_status: "REFUNDED", status: "rejected" } as never)
        .eq("id", payment.id);
    }

    return NextResponse.json({ mmqr_status: txnStatus });
  } catch (err) {
    console.error("[abank-status] enquiry error:", err);
    // Fall back to local status on API error
    return NextResponse.json({ mmqr_status: payment.mmqr_status ?? "PENDING" });
  }
}
