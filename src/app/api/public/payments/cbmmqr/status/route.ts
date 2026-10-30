import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CB_SUCCESS, REFERENCE_PATTERN, checkStatus, getCbMerchant, type CallBudget, type CbMerchant, type StatusResult } from "@/lib/cbmmqr";
import { settleCbmmqrPayment } from "@/server/payments/settleCbmmqrPayment";

export const maxDuration = 10;
/** Smaller than the create route's: settlement runs after the call (as KBZPay). */
const GATEWAY_BUDGET_MS = 6_000;

// ─── GET /api/public/payments/cbmmqr/status?ref= ────────────────────────────
// Spec §5.4. Answers { mmqr_status: 'PENDING' | 'SUCCESS', expiresAt? }.
// There is no EXPIRED or FAILED: local time never says a CB QR is dead, and a
// retired row simply stays PENDING here while the modal's retry path takes over.

type PaymentRow = {
  payment_ref: string;
  payment_method: string | null;
  cbmmqr_merchant: string | null;
  status: string;
  mmqr_status: string | null;
  provider_order_ref: string | null;
  provider_order_expires_at: string | null;
};

function gatewayBudget(): CallBudget | undefined {
  if (!process.env.VERCEL) return undefined;
  return { deadlineMs: Date.now() + GATEWAY_BUDGET_MS };
}

export async function GET(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get("ref");
  if (!ref || !REFERENCE_PATTERN.test(ref)) {
    return NextResponse.json({ error: "Bad Request", message: "ref is required." }, { status: 400 });
  }

  const { data: payment, error } = (await createAdminClient()
    .from("payments")
    .select("payment_ref, payment_method, cbmmqr_merchant, status, mmqr_status, provider_order_ref, provider_order_expires_at")
    .eq("payment_ref", ref)
    .eq("payment_method", "cb_mmqr")
    .maybeSingle()) as { data: PaymentRow | null; error: { message: string } | null };

  if (error) console.error(`[cbmmqr-status] lookup failed for ${ref}: ${error.message}`);
  if (!payment) return NextResponse.json({ mmqr_status: "PENDING" });

  if (payment.status === "verified") return NextResponse.json({ mmqr_status: "SUCCESS" });

  const pending = () =>
    NextResponse.json({ mmqr_status: "PENDING", expiresAt: payment.provider_order_expires_at });

  if (payment.status !== "awaiting_payment" || payment.mmqr_status !== "PENDING" || !payment.provider_order_ref) {
    return pending();
  }

  let merchant: CbMerchant;
  try {
    merchant = getCbMerchant(payment.cbmmqr_merchant);
  } catch (err) {
    console.error(`[cbmmqr-status] merchant config error for ${ref}: ${err instanceof Error ? err.message : err}`);
    return pending();
  }

  let status: StatusResult;
  try {
    status = await checkStatus(merchant, payment.provider_order_ref, gatewayBudget());
  } catch (err) {
    // checkStatus throws only for our own configuration (e.g. CBMMQR_MODE).
    console.error(`[cbmmqr-status] config error for ${ref}: ${err instanceof Error ? err.message : err}`);
    return pending();
  }
  if (status.kind !== "answer" || status.code !== CB_SUCCESS) return pending();

  const outcome = await settleCbmmqrPayment({
    payment: { payment_ref: payment.payment_ref, payment_method: payment.payment_method, cbmmqr_merchant: payment.cbmmqr_merchant },
    merchant,
    status,
    source: "status",
  });

  if (outcome.kind === "settled" || outcome.kind === "already_settled") {
    return NextResponse.json({ mmqr_status: "SUCCESS" });
  }
  console.error(`[cbmmqr-status] ${ref} settlement returned ${outcome.kind}`);
  return pending();
}
