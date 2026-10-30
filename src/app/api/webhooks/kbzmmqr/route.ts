import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  verifySign,
  queryOrder,
  getKbzMerchant,
  type KbzField,
  type CallBudget,
  type KbzMerchant,
} from "@/lib/kbzpay";
import { settleMmqrPayment } from "@/server/payments/settleMmqrPayment";

// Same 10s platform cap as the creation route. Declared rather than
// inherited so the limit is visible next to the gateway call it bounds.
export const maxDuration = 10;

/**
 * How much of the function budget the gateway call may consume.
 *
 * Deliberately smaller than the creation route's. Settlement runs AFTER the
 * call here and it is the write path — it marks the payment verified,
 * decrements seats and issues the ticket. Letting queryorder run its full
 * timeout regardless of time already spent could leave under a second for
 * that, and being interrupted mid-settlement is far worse than failing before
 * the gateway call. The remainder of the 10s cap is reserved for it.
 */
const GATEWAY_BUDGET_MS = 6_000;

// ─── POST /api/webhooks/kbzmmqr ─────────────────────────────────────────────
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

/**
 * The request budget, or none when nothing is capping the request.
 *
 * The budget exists solely to respect a serverless function limit. Running
 * locally there is no such limit, and clamping to an imaginary one is actively
 * harmful: the first gateway call of a session pays a ~9.5s connection cost,
 * and an 8s budget aborts it. That broke local UAT until it was measured.
 *
 * VERCEL is set on every Vercel runtime and unset locally, which is exactly
 * the distinction that matters here.
 */
function gatewayBudget(): CallBudget | undefined {
  if (!process.env.VERCEL) return undefined;
  return { deadlineMs: Date.now() + GATEWAY_BUDGET_MS };
}

export async function POST(request: NextRequest) {
  const budget = gatewayBudget();

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

  // The payment lookup below runs BEFORE authentication, so this value is
  // attacker-controlled. Bound it to the shape buildMerchOrderId produces: it
  // caps unauthenticated DB reads and keeps CR/LF out of the log lines.
  if (!/^[A-Za-z0-9_]{1,64}$/.test(merchOrderId)) {
    return NextResponse.json({ error: "Bad Request" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── 2. Locate the payment ──────────────────────────────────
  // Before authentication, because the key depends on the order (spec
  // 2026-10-30 §5.3). Read-only. KBZPay rows only, and the CHECK on payments
  // guarantees every match carries a pin.
  // 404 rather than success: a genuine race between order creation and this
  // callback resolves on KBZPay's retry.
  const { data: payment, error: lookupError } = (await supabase
    .from("payments")
    .select("id, enrollment_id, status, kbzpay_merchant")
    .eq("payment_ref", merchOrderId)
    .eq("payment_method", "kbzpay_mmqr")
    .maybeSingle()) as {
    data: { id: string; kbzpay_merchant: string | null } | null;
    error: { message: string } | null;
  };

  // A failed read is not "no such payment". 500 so KBZPay retries, rather than
  // a 404 that would read as a creation race.
  if (lookupError) {
    console.error(`[kbzpay-webhook] payment lookup failed for ${merchOrderId}: ${lookupError.message}`);
    return NextResponse.json({ error: "Lookup Failed" }, { status: 500 });
  }

  if (!payment) {
    console.warn(`[kbzpay-webhook] no payment row for ${merchOrderId}`);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  // ── 3. Resolve the pinned merchant ─────────────────────────
  // Missing config is OUR fault, not the caller's: the callback may be
  // genuine, and a retry after the operator fixes it should settle. So 500,
  // which KBZPay retries, not 403.
  let merchant: KbzMerchant;
  try {
    merchant = getKbzMerchant(payment.kbzpay_merchant);
  } catch (err) {
    console.error(
      `[kbzpay-webhook] merchant config error for ${merchOrderId}: ${err instanceof Error ? err.message : err}`,
    );
    return NextResponse.json({ error: "Configuration Error" }, { status: 500 });
  }

  // ── 4. Verify the signature ────────────────────────────────
  // Against EXACTLY ONE key, the pinned merchant's. Never "try each merchant's
  // key until one verifies": that would make every merchant's key valid for
  // every order. Over whatever keys arrived, never a fixed list, so a future
  // KBZPay field cannot silently break verification.
  if (!verifySign(fields, merchant.appKey) || fields.merch_code !== merchant.merchCode) {
    console.warn(`[kbzpay-webhook] invalid signature or merchant for ${merchOrderId}`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── 5. Confirm server-to-server (§7) ───────────────────────
  // A valid signature proves the message is authentic, not that money arrived.
  // The signature check is our own code and the flatten/sort/exclude rules have
  // several ways to be subtly wrong; confirming through an authenticated
  // outbound call makes a signature bug a nuisance rather than a route to free
  // enrollments. Settlement therefore uses the QUERY's values, never the
  // callback's.
  const confirmed = await queryOrder(merchant, merchOrderId, budget);

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

  // ── 6. Settle ──────────────────────────────────────────────
  const outcome = await settleMmqrPayment({
    paymentRef: merchOrderId,
    observedAmount: confirmed.totalAmount === undefined ? null : Number(confirmed.totalAmount),
    observedCurrency: confirmed.transCurrency ?? null,
    mmOrderId: confirmed.mmOrderId ?? null,
    walletIdentifier: confirmed.walletIdentifier ?? null,
    source: "callback",
  });

  // ── 7. Respond per §8 ──────────────────────────────────────
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
