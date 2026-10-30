import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CB_SUCCESS,
  REFERENCE_PATTERN,
  apiKeyMatches,
  checkStatus,
  getCbMerchant,
  type CallBudget,
  type CbMerchant,
} from "@/lib/cbmmqr";
import { settleCbmmqrPayment } from "@/server/payments/settleCbmmqrPayment";

export const maxDuration = 10;
const GATEWAY_BUDGET_MS = 6_000;
const MAX_BODY_BYTES = 8 * 1024;
const QR_REF_PATTERN = /^[\x21-\x7E]{1,25}$/;

/**
 * CB's other callback fields (spec §3), bounded to CB's documented lengths.
 * Absent is allowed — a FAIL callback need not carry a transaction, and none
 * of these ever moves money — but present-and-malformed is a 400.
 */
const OPTIONAL_STRINGS: Record<string, number> = {
  transactionId: 35, transCurrency: 3, transDateTime: 17, transStatusCode: 4,
  institutionId: 4, institutionName: 150, merchantId: 15, remark: 140, terminalId: 8,
};

function optionalFieldsValid(fields: Record<string, unknown>): boolean {
  for (const [name, max] of Object.entries(OPTIONAL_STRINGS)) {
    const v = fields[name];
    if (v === undefined || v === null) continue;
    if (typeof v === "number" && (name === "transCurrency" || name === "transStatusCode")) continue;
    if (typeof v !== "string" || v.length > max) return false;
  }
  const amount = fields.transAmount;
  if (amount !== undefined && amount !== null) {
    const n = typeof amount === "string" ? Number(amount) : amount;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return false;
  }
  return true;
}

// ─── POST /api/webhooks/cbmmqr ──────────────────────────────────────────────
// Spec §5.3. CB authenticates the callback only with a static apiKey and signs
// nothing, so the callback is a wake-up: it names a payment, and we then ask
// CB ourselves (status check with the pinned merchant's credentials) and settle
// on THAT answer through settleCbmmqrPayment(). No callback field moves money.
//
// Replies: 200 { qrReferenceNo, returnCode: "0000", message } when there is
// nothing more CB could usefully do; 500 when a retry might succeed.

const ack = (qrReferenceNo: string) =>
  NextResponse.json({ qrReferenceNo, returnCode: "0000", message: "Success" }, { status: 200 });
const err = (status: number, error: string) => NextResponse.json({ error }, { status });

function gatewayBudget(): CallBudget | undefined {
  if (!process.env.VERCEL) return undefined;
  return { deadlineMs: Date.now() + GATEWAY_BUDGET_MS };
}

export async function POST(request: NextRequest) {
  // ── 1. Size and shape, before anything touches the database ─
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return err(400, "Bad Request");

  let fields: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return err(400, "Bad Request");
    fields = parsed as Record<string, unknown>;
  } catch {
    return err(400, "Bad Request");
  }

  const referenceNo = fields.referenceNo;
  const qrReferenceNo = fields.qrReferenceNo;
  const description = fields.transStatusDescription;
  if (
    typeof referenceNo !== "string" || !REFERENCE_PATTERN.test(referenceNo) ||
    typeof qrReferenceNo !== "string" || !QR_REF_PATTERN.test(qrReferenceNo) ||
    typeof fields.apiKey !== "string" || fields.apiKey.length === 0 || fields.apiKey.length > 150 ||
    typeof description !== "string" || description.length > 250 ||
    !optionalFieldsValid(fields)
  ) {
    return err(400, "Bad Request");
  }

  // ── 2. The payment (its pin decides which key is valid) ────
  const { data: payment, error: lookupError } = (await createAdminClient()
    .from("payments")
    .select("payment_ref, payment_method, cbmmqr_merchant, status, provider_order_ref")
    .eq("payment_ref", referenceNo)
    .eq("payment_method", "cb_mmqr")
    .maybeSingle()) as {
    data: {
      payment_ref: string;
      payment_method: string | null;
      cbmmqr_merchant: string | null;
      status: string;
      provider_order_ref: string | null;
    } | null;
    error: { message: string } | null;
  };

  if (lookupError) {
    console.error(`[cbmmqr-webhook] lookup failed for ${referenceNo}: ${lookupError.message}`);
    return err(500, "Lookup Failed");
  }
  if (!payment) {
    console.warn(`[cbmmqr-webhook] no payment row for ${referenceNo}`);
    return err(404, "Not Found");
  }

  // ── 3. The pinned merchant — our config fault is a 500, not a 403 ─
  let merchant: CbMerchant;
  try {
    merchant = getCbMerchant(payment.cbmmqr_merchant);
  } catch (e) {
    console.error(`[cbmmqr-webhook] merchant config error for ${referenceNo}: ${e instanceof Error ? e.message : e}`);
    return err(500, "Configuration Error");
  }

  // ── 4. The key: exactly ONE, the pinned merchant's ─────────
  if (!apiKeyMatches(fields.apiKey, merchant.apiKey)) {
    console.warn(`[cbmmqr-webhook] invalid apiKey for ${referenceNo}`);
    return err(403, "Forbidden");
  }

  // ── 4b. The QR must be the one we stored for this payment ─
  // Only when the create response was lost (nothing stored) do we query the
  // callback's QR reference; the bind then records it once.
  const storedQrRef = payment.provider_order_ref;
  if (storedQrRef && storedQrRef !== qrReferenceNo) {
    console.warn(`[cbmmqr-webhook] ${referenceNo}: callback QR ${qrReferenceNo} is not the stored ${storedQrRef}`);
    return err(403, "Forbidden");
  }
  const queryQrRef = storedQrRef ?? qrReferenceNo;

  // ── 5. FAIL changes nothing: the QR may still be paid ──────
  if (description.trim().toUpperCase() !== "SUCCESS") {
    console.warn(`[cbmmqr-webhook] ${referenceNo} reported ${description.slice(0, 40)}; nothing changed`);
    return ack(qrReferenceNo);
  }

  // ── 6. Ask CB ourselves ────────────────────────────────────
  const status = await checkStatus(merchant, queryQrRef, gatewayBudget());
  if (status.kind !== "answer") return err(500, "Query Failed");
  if (status.code !== CB_SUCCESS) {
    console.warn(`[cbmmqr-webhook] ${referenceNo}: callback said SUCCESS, status says ${status.code}`);
    return err(500, "Not Settled");
  }

  // ── 7. Settle on the status answer ─────────────────────────
  const outcome = await settleCbmmqrPayment({
    payment: { payment_ref: payment.payment_ref, payment_method: payment.payment_method, cbmmqr_merchant: payment.cbmmqr_merchant },
    merchant,
    status,
    source: "callback",
  });

  switch (outcome.kind) {
    case "settled":
    case "already_settled":
      return ack(qrReferenceNo);
    case "refused":
      // Logged loudly by the wrapper and left for an operator. A retry sends
      // the same facts and cannot change the answer.
      return ack(qrReferenceNo);
    default:
      console.error(`[cbmmqr-webhook] ${referenceNo} settlement retryable: ${outcome.reason}`);
      return err(500, "Retry");
  }
}
