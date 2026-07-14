import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { tenantOrigin } from "@/lib/origin";
import paypay from "@/lib/paypay";
import { dispatchPaymentApproved } from "@/server/notifications/dispatchPaymentApproved";
import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";

// ─── GET /api/public/payments/paypay/status?ref=PY-xxx ──────────────────────
// Polls PayPay API and updates local payment record.
// Returns: { paypay_status: "CREATED" | "COMPLETED" | "EXPIRED" | "CANCELED" | "FAILED" }

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
    .select("id, enrollment_id, amount, paypay_status, status")
    .eq("payment_ref", paymentRef)
    .single()) as {
    data: { id: string; enrollment_id: string; amount: number; paypay_status: string; status: string } | null;
    error: unknown;
  };

  if (!payment) {
    return NextResponse.json({ paypay_status: "CREATED" });
  }

  // Already finalized locally
  if (payment.paypay_status === "COMPLETED" || payment.status === "verified") {
    return NextResponse.json({ paypay_status: "COMPLETED" });
  }
  if (payment.paypay_status === "FAILED" || payment.paypay_status === "CANCELED") {
    return NextResponse.json({ paypay_status: payment.paypay_status });
  }
  if (payment.paypay_status === "EXPIRED") {
    return NextResponse.json({ paypay_status: "EXPIRED" });
  }

  // Poll PayPay API
  try {
    const result = await paypay.getPaymentStatus(paymentRef);
    const status = result.data?.status ?? "CREATED";

    if (status === "COMPLETED") {
      // Update payment + enrollment (conditional to prevent duplicate notifications)
      const { data: updated } = (await supabase
        .from("payments")
        .update({
          paypay_status: "COMPLETED",
          status: "verified",
          paid_at: new Date().toISOString(),
          bank_reference: result.data?.paymentId ?? null,
          received_amount: payment.amount,
        } as never)
        .eq("id", payment.id)
        .neq("status", "verified")
        .select("id")) as { data: { id: string }[] | null; error: unknown };

      // Only update enrollment + send notifications if we actually changed the payment
      if (updated && updated.length > 0) {
        await supabase
          .from("enrollments")
          .update({ status: "confirmed" } as never)
          .eq("id", payment.enrollment_id);

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
          const { data: originRow } = (await supabase
            .from("tenants")
            .select("subdomain")
            .eq("id", enrollment.tenant_id)
            .single()) as { data: { subdomain: string | null } | null; error: unknown };
          const statusUrl = `${tenantOrigin(originRow?.subdomain)}/status?ref=${enrollment.enrollment_ref}`;

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
      }
    } else if (status === "FAILED") {
      await supabase
        .from("payments")
        .update({ paypay_status: "FAILED" } as never)
        .eq("id", payment.id);
    } else if (status === "EXPIRED") {
      await supabase
        .from("payments")
        .update({ paypay_status: "EXPIRED" } as never)
        .eq("id", payment.id);
    } else if (status === "CANCELED") {
      await supabase
        .from("payments")
        .update({ paypay_status: "CANCELED", status: "rejected" } as never)
        .eq("id", payment.id);
    }

    return NextResponse.json({ paypay_status: status });
  } catch (err) {
    console.error("[paypay-status] poll error:", err);
    return NextResponse.json({ paypay_status: payment.paypay_status ?? "CREATED" });
  }
}
