import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySign, queryOrder, type KbzField } from "@/lib/kbzpay";
import { settleMmqrPayment } from "@/server/payments/settleMmqrPayment";

// ─── POST /api/webhooks/kbzpay ──────────────────────────────────────────────
// KBZPay asynchronous payment notification.
// Design: docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md §5.2
//
// Response contract (§8): the literal body `success` is returned ONLY when
// there is nothing further KBZPay could usefully do. Everything transient
// stays non-success to buy the two retries (60s and 600s).

/** The literal body KBZPay requires. Not JSON — anything else means retry. */
const ack = () =>
  new NextResponse("success", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

export async function POST(request: NextRequest) {
  // ── 1. Parse ───────────────────────────────────────────────
  let fields: Record<string, KbzField>;
  try {
    const body = (await request.json()) as { Request?: Record<string, KbzField> };
    if (!body?.Request || typeof body.Request !== "object") {
      return NextResponse.json({ error: "Bad Request" }, { status: 400 });
    }
    fields = body.Request;
  } catch {
    return NextResponse.json({ error: "Bad Request" }, { status: 400 });
  }

  const merchOrderId = typeof fields.merch_order_id === "string" ? fields.merch_order_id : "";

  // ── 2. Verify the signature ────────────────────────────────
  // Over whatever keys arrived, never a fixed list, so a future KBZPay field
  // cannot silently break verification.
  const appKey = process.env.KBZPAY_APP_KEY;
  if (!appKey || !verifySign(fields, appKey)) {
    console.warn(`[kbzpay-webhook] invalid signature for ${merchOrderId || "<no ref>"}`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!merchOrderId) {
    return NextResponse.json({ error: "Bad Request" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── 3. Locate the payment ──────────────────────────────────
  // 404 rather than success: a genuine race between order creation and this
  // callback resolves on KBZPay's retry.
  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, status")
    .eq("payment_ref", merchOrderId)
    .maybeSingle()) as { data: { id: string } | null; error: unknown };

  if (!payment) {
    console.warn(`[kbzpay-webhook] no payment row for ${merchOrderId}`);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  // ── 4. Confirm server-to-server (§7) ───────────────────────
  // A valid signature proves the message is authentic, not that money arrived.
  // The signature check is our own code and the flatten/sort/exclude rules have
  // several ways to be subtly wrong; confirming through an authenticated
  // outbound call makes a signature bug a nuisance rather than a route to free
  // enrollments. Settlement therefore uses the QUERY's values, never the
  // callback's.
  const confirmed = await queryOrder(merchOrderId);

  if (!confirmed.ok) {
    console.error(`[kbzpay-webhook] queryOrder unreachable for ${merchOrderId}`);
    return NextResponse.json({ error: "Query Failed" }, { status: 500 });
  }

  if (confirmed.tradeStatus !== "PAY_SUCCESS") {
    // Not settled at the provider. A retry may catch it once it is.
    console.warn(
      `[kbzpay-webhook] ${merchOrderId} reported ${confirmed.tradeStatus}, not PAY_SUCCESS`,
    );
    return NextResponse.json({ error: "Not Settled" }, { status: 500 });
  }

  // ── 5. Settle ──────────────────────────────────────────────
  const outcome = await settleMmqrPayment({
    paymentRef: merchOrderId,
    observedAmount: confirmed.totalAmount === undefined ? null : Number(confirmed.totalAmount),
    observedCurrency: confirmed.transCurrency ?? null,
    mmOrderId: confirmed.mmOrderId ?? null,
    walletIdentifier: confirmed.walletIdentifier ?? null,
    source: "callback",
  });

  // ── 6. Respond per §8 ──────────────────────────────────────
  switch (outcome.kind) {
    case "settled":
    case "already_settled":
      return ack();

    case "amount_mismatch":
    case "currency_mismatch":
      // Logged loudly by settleMmqrPayment and left for admin review. Retrying
      // sends the identical figures, so it can never reconcile — stop the
      // retries rather than burning them.
      console.error(
        `[kbzpay-webhook] ${outcome.kind} for ${merchOrderId}; left for admin review`,
      );
      return ack();

    default:
      // not_found / retryable — the money may be real. Keep the retries.
      console.error(`[kbzpay-webhook] ${merchOrderId} settlement returned ${outcome.kind}`);
      return NextResponse.json({ error: "Retry" }, { status: 500 });
  }
}
