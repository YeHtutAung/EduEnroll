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
  type StatusResult,
} from "@/lib/cbmmqr";
import { settleCbmmqrPayment } from "@/server/payments/settleCbmmqrPayment";

export const maxDuration = 10;
const GATEWAY_BUDGET_MS = 6_000;
const MAX_BODY_BYTES = 8 * 1024;
const QR_REF_PATTERN = /^[\x21-\x7E]{1,25}$/;

// Only referenceNo, qrReferenceNo, transStatusDescription and apiKey are read.
// CB's other fields are not checked: strict limits on them refused CB's real
// callbacks on production, and none of them can move money.

const LOGGED_NAME = /^[A-Za-z0-9_]{1,40}$/;
const MAX_LOGGED_NAMES = 40;

/**
 * Why a callback was refused, so a format mismatch can be seen. Lengths, types
 * and field names only: this route is public, and a value could be anything.
 */
function logRejected(reason: string, fields?: Record<string, unknown>, field?: string): void {
  const parts = [`[cbmmqr-webhook] rejected: ${reason}`];
  if (fields && field) {
    const v = fields[field];
    const length = typeof v === "string" ? ` length=${v.length}` : "";
    parts.push(`field=${field} type=${v === null ? "null" : typeof v}${length}`);
  }
  if (fields) {
    const names = Object.keys(fields).filter((n) => LOGGED_NAME.test(n)).slice(0, MAX_LOGGED_NAMES);
    parts.push(`fields=${names.join(",")}`);
  }
  console.warn(parts.join(" "));
}

// ─── POST /api/webhooks/cbmmqr ──────────────────────────────────────────────
// Spec §5.3. CB signs nothing, and its apiKey may be null or empty (CB,
// 2026-11-03), so the callback is a wake-up: it names a payment, and we then ask
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
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    logRejected("body too large");
    return err(400, "Bad Request");
  }

  let fields: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logRejected("body is not an object");
      return err(400, "Bad Request");
    }
    fields = parsed as Record<string, unknown>;
  } catch {
    logRejected("body is not JSON");
    return err(400, "Bad Request");
  }

  const referenceNo = fields.referenceNo;
  const qrReferenceNo = fields.qrReferenceNo;
  const description = fields.transStatusDescription;
  if (typeof referenceNo !== "string" || !REFERENCE_PATTERN.test(referenceNo)) {
    logRejected("bad required field", fields, "referenceNo");
    return err(400, "Bad Request");
  }
  if (typeof qrReferenceNo !== "string" || !QR_REF_PATTERN.test(qrReferenceNo)) {
    logRejected("bad required field", fields, "qrReferenceNo");
    return err(400, "Bad Request");
  }
  if (typeof description !== "string" || description.length > 250) {
    logRejected("bad required field", fields, "transStatusDescription");
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

  // ── 4. The key: exactly ONE, the pinned merchant's, when it has one ─
  if (merchant.apiKey !== null && !apiKeyMatches(fields.apiKey, merchant.apiKey)) {
    console.warn(`[cbmmqr-webhook] invalid apiKey for ${referenceNo}`);
    return err(403, "Forbidden");
  }

  // ── 4b. The QR must be the one we stored for this payment ─
  // Only when the create response was lost (nothing stored) do we query the
  // callback's QR reference; the bind then records it once.
  const storedQrRef = payment.provider_order_ref;
  if (storedQrRef && storedQrRef !== qrReferenceNo) {
    console.error(
      `[cbmmqr-webhook] ${referenceNo} (merchant ${merchant.id}): callback QR ${qrReferenceNo} is not the stored ${storedQrRef}`,
    );
    return err(403, "Forbidden");
  }
  const queryQrRef = storedQrRef ?? qrReferenceNo;

  // ── 5. Ask CB ourselves, whatever the callback's wording ──
  // CB's real text is "Transaction is succeeded.", not the spec's "SUCCESS". The
  // wording can't move money, so it must not decide whether we look either.
  let status: StatusResult;
  try {
    status = await checkStatus(merchant, queryQrRef, gatewayBudget());
  } catch (e) {
    // checkStatus throws only for our own configuration (e.g. CBMMQR_MODE).
    console.error(`[cbmmqr-webhook] config error for ${referenceNo}: ${e instanceof Error ? e.message : e}`);
    return err(500, "Configuration Error");
  }
  if (status.kind !== "answer") return err(500, "Query Failed");
  if (status.code !== CB_SUCCESS) {
    console.warn(`[cbmmqr-webhook] ${referenceNo}: status says ${status.code}; not settled`);
    // The wording decides only whether CB should try again: a reported failure
    // has nothing more to tell us, and anything else may just be early.
    return /fail/i.test(description) ? ack(qrReferenceNo) : err(500, "Not Settled");
  }
  // CB's answer must be about the QR we asked for. A refusal, like a
  // settlement refusal: a retry sends the same facts and cannot change it.
  if (status.qrReferenceNo !== queryQrRef) {
    console.error(
      `[cbmmqr-webhook] refused ${referenceNo} (merchant ${merchant.id}): status answered QR ${status.qrReferenceNo ?? "none"}, asked ${queryQrRef}`,
    );
    return ack(qrReferenceNo);
  }

  // ── 6. Settle on the status answer ─────────────────────────
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
