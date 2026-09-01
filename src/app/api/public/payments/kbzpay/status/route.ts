import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { queryOrder, type TradeStatus } from "@/lib/kbzpay";
import { settleMmqrPayment } from "@/server/payments/settleMmqrPayment";

// Same 10s platform cap as the creation route. Declared rather than
// inherited so the limit is visible next to the gateway call it bounds.
export const maxDuration = 10;

// ─── GET /api/public/payments/kbzpay/status?ref=KBZ_xxx ─────────────────────
// Browser poller for QRPaymentModal, which reads `mmqr_status`.
// Design: docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md §5.3
//
// This is a genuine recovery path, not a read-only display: KBZPay retries a
// callback only twice (60s, 600s) and then stops, so if both are missed this
// poller is what settles the payment.

/** Onto the vocabulary QRPaymentModal already understands. */
const STATUS_MAP: Partial<Record<TradeStatus, string>> = {
  PAY_SUCCESS: "SUCCESS",
  PAY_FAILED: "FAILED",
  ORDER_EXPIRED: "EXPIRED",
  ORDER_CLOSED: "EXPIRED",
  WAIT_PAY: "PENDING",
  PAYING: "PENDING",
  // Deliberately PENDING, not FAILED: the order may simply not be visible yet,
  // and the modal's own 10-minute timeout is the right thing to end the wait.
  ORDER_NOT_FOUND: "PENDING",
};

export async function GET(request: NextRequest) {
  const paymentRef = request.nextUrl.searchParams.get("ref");
  if (!paymentRef) {
    return NextResponse.json({ error: "Bad Request", message: "ref is required." }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: payment } = (await supabase
    .from("payments")
    .select("id, enrollment_id, mmqr_status, status")
    .eq("payment_ref", paymentRef)
    .maybeSingle()) as {
    data: { id: string; enrollment_id: string; mmqr_status: string; status: string } | null;
    error: unknown;
  };

  // Unknown ref: keep the modal polling rather than showing an error. A row
  // created moments ago may not be visible to this read yet.
  if (!payment) return NextResponse.json({ mmqr_status: "PENDING" });

  // ── Already final locally — no provider call needed ────────
  if (payment.status === "verified" || payment.mmqr_status === "SUCCESS") {
    return NextResponse.json({ mmqr_status: "SUCCESS" });
  }
  if (payment.mmqr_status === "FAILED") {
    return NextResponse.json({ mmqr_status: "FAILED" });
  }

  // ── Ask KBZPay ─────────────────────────────────────────────
  const result = await queryOrder(paymentRef);
  if (!result.ok) {
    // Unreachable is not failed. Keep polling.
    return NextResponse.json({ mmqr_status: "PENDING" });
  }

  // ── Self-heal a missed callback ────────────────────────────
  if (result.tradeStatus === "PAY_SUCCESS") {
    const outcome = await settleMmqrPayment({
      paymentRef,
      observedAmount: result.totalAmount === undefined ? null : Number(result.totalAmount),
      observedCurrency: result.transCurrency ?? null,
      mmOrderId: result.mmOrderId ?? null,
      walletIdentifier: result.walletIdentifier ?? null,
      source: "status",
    });

    if (outcome.kind === "settled" || outcome.kind === "already_settled") {
      return NextResponse.json({ mmqr_status: "SUCCESS" });
    }

    // The money arrived but our own guards refused it, or fulfilment failed.
    // Reporting SUCCESS here would tell the student they are enrolled when an
    // operator has to intervene first.
    console.error(`[kbzpay-status] ${paymentRef} settlement returned ${outcome.kind}`);
    return NextResponse.json({ mmqr_status: "PENDING" });
  }

  return NextResponse.json({ mmqr_status: STATUS_MAP[result.tradeStatus] ?? "PENDING" });
}
