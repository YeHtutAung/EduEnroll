import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { tenantLinkOrigin } from "@/lib/origin";
import abank from "@/lib/abank";
import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";
import { resolveEmailFromFormData } from "@/lib/utils";
import { issueTicketsForEnrollment } from "@/server/tickets/issueTickets";
import { buildEticketEmailAttachment } from "@/server/tickets/eticketEmailAttachment";

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
    .select("id, enrollment_id, mmqr_status, status, amount")
    .eq("payment_ref", paymentRef)
    .single()) as {
    data: { id: string; enrollment_id: string; mmqr_status: string; status: string; amount: number | null } | null;
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
          payer_institution: txnData.institutionName ?? null,
        } as never)
        .eq("id", payment.id);

      await supabase
        .from("enrollments")
        .update({ status: "confirmed" } as never)
        .eq("id", payment.enrollment_id);

      try {
        await issueTicketsForEnrollment(payment.enrollment_id);
      } catch (err) {
        console.error("[abank-status] issueTicketsForEnrollment failed:", err);
      }

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
        // Resolve email: column first, then form_data
        const enrollEmail = enrollment.email
          || resolveEmailFromFormData(enrollment.form_data as Record<string, string> | null);
        const { data: originRow } = (await supabase
          .from("tenants")
          .select("subdomain")
          .eq("id", enrollment.tenant_id)
          .single()) as { data: { subdomain: string | null } | null; error: unknown };
        const statusUrl = `${tenantLinkOrigin(originRow?.subdomain)}/status?ref=${enrollment.enrollment_ref}`;

        // Resolve class level
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
            // The payer was charged the fee-inclusive amount recorded on the
            // payment row, so the notification quotes that rather than
            // re-summing the tickets, which would understate what they paid.
            const total = payment.amount ?? items.reduce((s, i) => s + i.fee_amount * i.quantity, 0);
            feeFormatted = String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
            feeFormatted = String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
          }
        }

        // Fetch tenant info for email branding
        const { data: tenantInfo } = (await supabase
          .from("tenants")
          .select("name, org_type, logo_url, currency")
          .eq("id", enrollment.tenant_id)
          .single()) as {
          data: { name: string; org_type: string; logo_url: string | null; currency: string } | null;
          error: unknown;
        };
        const tenantCurrency = tenantInfo?.currency ?? "MMK";
        if (feeFormatted) feeFormatted = `${feeFormatted} ${tenantCurrency}`;

        // Collect notification promises — must await before returning
        // so Vercel serverless doesn't kill the function prematurely
        const notifyTasks: Promise<unknown>[] = [];

        // Telegram notification
        if (enrollment.telegram_chat_id) {
          notifyTasks.push(
            sendTelegramStatusNotification({
              tenantId: enrollment.tenant_id,
              telegramChatId: enrollment.telegram_chat_id,
              action: "approve",
              studentName: enrollment.student_name_en || "Student",
              enrollmentRef: enrollment.enrollment_ref,
              classLevel,
              statusUrl,
              paymentUrl: statusUrl,
              currency: tenantCurrency,
            }).catch((err) => {
              console.error("[abank-status] Telegram notification failed:", err);
            }),
          );
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
          const attachment = await buildEticketEmailAttachment(payment.enrollment_id).catch((err) => {
            console.error("[abank-status] e-ticket attachment failed:", err);
            return null;
          });
          notifyTasks.push(
            sendEmail({
              to: enrollEmail,
              ...emailData,
              ...(attachment ? { attachments: [attachment] } : {}),
            }).catch((err) => {
              console.error("[abank-status] Approval email failed:", err);
            }),
          );
        }

        // Channel invite (language_school only, gated inside)
        if (enrollment.telegram_chat_id) {
          notifyTasks.push(
            sendChannelInviteIfEligible({
              tenantId: enrollment.tenant_id,
              enrollmentId: payment.enrollment_id,
              classId: enrollment.class_id,
              telegramChatId: enrollment.telegram_chat_id,
              studentName: enrollment.student_name_en || "Student",
            }).catch((err) => {
              console.error("[abank-status] Channel invite failed:", err);
            }),
          );
        }

        await Promise.allSettled(notifyTasks);
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
