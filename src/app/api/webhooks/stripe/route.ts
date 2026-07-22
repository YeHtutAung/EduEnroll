import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { settlePaidPayment, type SettleOutcome } from "@/server/payments/settlePaidPayment";
import { handleStripePaymentFailure } from "@/server/payments/handleStripePaymentFailure";
import { recordConflict } from "@/server/payments/settlementConflicts";
import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";
import { resolveEmailFromFormData, resolvePhoneFromFormData } from "@/lib/utils";
import { sendSms } from "@/lib/sms";
import type Stripe from "stripe";

// ─── POST /api/webhooks/stripe ───────────────────────────────────────────────
// Browser-independent settlement (Plan v18). One settlement operation behind
// the three PAID events; the failed event has its own operation. Response
// policy (§7) deliberately diverges from the house "always 200 and log":
// Stripe's retry schedule is the durability mechanism, so retryable failures
// return 500.
//
// IMPORTANT: request.text(), not request.json() — signature verification
// needs the unmodified body.

export async function POST(request: NextRequest) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const source = { type: "webhook_event" as const, id: event.id };

  try {
    // ── Session paid events: completed / async_payment_succeeded ────────────
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const session = event.data.object as Stripe.Checkout.Session;

      // completed can fire unpaid for delayed methods — that is 'processing',
      // not a settlement and not a conflict; async_payment_succeeded (or a
      // paid completed replay) settles it later.
      if (session.payment_status !== "paid") {
        console.warn(
          "[stripe-webhook] session not paid:",
          session.id,
          session.payment_status,
        );
        return NextResponse.json({ received: true });
      }

      const outcome = await settlePaidPayment({
        sessionId: session.id,
        observedAmountMinor: session.amount_total,
        observedCurrency: session.currency,
        source,
        backfillPaymentIntentId:
          typeof session.payment_intent === "string" ? session.payment_intent : null,
      });
      return respond(outcome);
    }

    // ── Session failed event: its OWN operation (§5b), never the paid path ──
    if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const outcome = await handleStripePaymentFailure({ sessionId: session.id, source });
      switch (outcome.kind) {
        case "rejected":
        case "replay":
        case "conflict":
          return NextResponse.json({ received: true });
        case "retryable":
          console.error("[stripe-webhook] failure handling retryable:", outcome.reason);
          return NextResponse.json({ error: "retry" }, { status: 500 });
      }
    }

    // ── Session expired: retire the attempt if still active ─────────────────
    if (event.type === "checkout.session.expired") {
      const session = event.data.object as Stripe.Checkout.Session;
      const supabase = createAdminClient();
      const { error } = await supabase
        .from("payments")
        .update({ status: "rejected" } as never)
        .eq("stripe_session_id", session.id)
        .in("status", ["awaiting_payment", "pending"]);
      if (error) {
        console.error("[stripe-webhook] expiry update failed:", error.message);
        return NextResponse.json({ error: "retry" }, { status: 500 });
      }
      return NextResponse.json({ received: true });
    }

    // ── Direct PaymentIntent success: ownership dispatch (§4) ────────────────
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object as Stripe.PaymentIntent;
      const flow = pi.metadata?.integration_flow;

      if (flow === "hosted_checkout") {
        // The Session events own this object. 200, no settlement.
        return NextResponse.json({ received: true });
      }

      if (flow !== "direct_payment_intent") {
        // Missing or unrecognised is never assumed-direct: historical objects
        // carry no marker, and guessing wrong is a double settlement or a
        // permanent retry loop. Visible instead. recordConflict throws on
        // write failure → outer catch → 500.
        await recordConflict({
          objectId: pi.id,
          conflictType: "unknown_integration_flow",
          source,
          actualAmountMinor: pi.amount_received ?? null,
          actualCurrency: pi.currency ?? null,
        });
        return NextResponse.json({ received: true });
      }

      // Card metadata when the event payload carries charge data; PayNow and
      // other non-card methods (and slim event shapes) leave these null — the
      // browser status route backfills if the buyer returns.
      const card = (pi as unknown as {
        charges?: { data?: { payment_method_details?: { card?: { brand?: string; last4?: string } } }[] };
      }).charges?.data?.[0]?.payment_method_details?.card;

      const outcome = await settlePaidPayment({
        paymentIntentId: pi.id,
        observedAmountMinor: pi.amount_received,
        observedCurrency: pi.currency,
        source,
        cardBrand: card?.brand ?? null,
        cardLast4: card?.last4 ?? null,
      });
      return respond(outcome);
    }

    // Unhandled event types are acknowledged.
    return NextResponse.json({ received: true });
  } catch (err) {
    // Conflict-write failures and fulfilment failures land here: the money
    // decision is durable or retried, never silently dropped.
    console.error("[stripe-webhook] retryable failure:", err);
    return NextResponse.json({ error: "retry" }, { status: 500 });
  }
}

// ── Outcome → HTTP (§7), plus the notification boundary (§6) ────────────────
// Only the transition WINNER notifies: settled may notify, already_settled
// never does — under 500-and-retry, notifying on replay would resend on every
// redelivery. Notification failures are caught and never change the status.
async function respond(outcome: SettleOutcome): Promise<NextResponse> {
  switch (outcome.kind) {
    case "settled":
      try {
        await notifyEnrollmentConfirmed(outcome.enrollmentId);
      } catch (err) {
        console.error("[stripe-webhook] notification failed:", err);
      }
      return NextResponse.json({ received: true });
    case "already_settled":
    case "conflict":
      return NextResponse.json({ received: true });
    case "retryable":
      console.error("[stripe-webhook] settlement retryable:", outcome.reason);
      return NextResponse.json({ error: "retry" }, { status: 500 });
  }
}

// ── Notifications (behaviour unchanged, moved behind the winner gate) ────────
async function notifyEnrollmentConfirmed(enrollmentId: string): Promise<void> {
  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select(
      "tenant_id, telegram_chat_id, email, phone, enrollment_ref, student_name_en, class_id, quantity, form_data",
    )
    .eq("id", enrollmentId)
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
  if (!enrollment) return;

  const enrollEmail =
    enrollment.email ||
    resolveEmailFromFormData(enrollment.form_data as Record<string, string> | null);
  // Use the configured app origin, not the inbound Host header (spoofable).
  const appOrigin = process.env.NEXT_PUBLIC_APP_URL ?? "https://kuunyi.com";
  const statusUrl = `${appOrigin}/status?ref=${enrollment.enrollment_ref}`;

  let classLevel = "Class";
  let feeFormatted: string | undefined;
  const isCart = enrollment.class_id === null;

  if (isCart) {
    const { data: items } = (await supabase
      .from("enrollment_items")
      .select("quantity, fee_amount, classes(level)")
      .eq("enrollment_id", enrollmentId)) as {
      data: { quantity: number; fee_amount: number; classes: { level: string } | null }[] | null;
      error: unknown;
    };
    if (items && items.length > 0) {
      classLevel = items
        .map((i) =>
          i.quantity > 1 ? `${i.classes?.level ?? "?"} x${i.quantity}` : (i.classes?.level ?? "?"),
        )
        .join(", ");
      const total = items.reduce((s, i) => s + i.fee_amount * i.quantity, 0);
      feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
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
      feeFormatted = `${String(total).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
    }
  }

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

  if (feeFormatted && tenantInfo?.currency) {
    feeFormatted = `${feeFormatted} ${tenantInfo.currency}`;
  }

  const notifyTasks: Promise<unknown>[] = [];

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
        currency: tenantInfo?.currency ?? "MMK",
      }).catch((err) => {
        console.error("[stripe-webhook] Telegram notification failed:", err);
      }),
    );
  }

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
    notifyTasks.push(
      sendEmail({ to: enrollEmail, ...emailData }).catch((err) => {
        console.error("[stripe-webhook] Approval email failed:", err);
      }),
    );
  }

  const enrollPhone =
    enrollment.phone ||
    resolvePhoneFromFormData(enrollment.form_data as Record<string, string> | null);
  if (enrollPhone && tenantInfo?.sms_on_payment !== false) {
    const name = enrollment.student_name_en || "Student";
    notifyTasks.push(
      sendSms({
        to: enrollPhone,
        message: `Hi ${name}, your payment for ${enrollment.enrollment_ref} has been confirmed. Welcome to class!`,
        clientReference: enrollment.enrollment_ref,
      }).catch((err) => {
        console.error("[stripe-webhook] Approval SMS failed:", err);
      }),
    );
  }

  if (enrollment.telegram_chat_id) {
    notifyTasks.push(
      sendChannelInviteIfEligible({
        tenantId: enrollment.tenant_id,
        enrollmentId,
        classId: enrollment.class_id,
        telegramChatId: enrollment.telegram_chat_id,
        studentName: enrollment.student_name_en || "Student",
      }).catch((err) => {
        console.error("[stripe-webhook] Channel invite failed:", err);
      }),
    );
  }

  await Promise.allSettled(notifyTasks);
}
