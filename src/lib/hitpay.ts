// ─── HitPay Embedded Payments client ────────────────────────────────────────
// Docs: https://docs.hitpayapp.com/apis/guide/embedded-qr-code-payments
// Auth: X-BUSINESS-API-KEY header
// Sandbox: https://api.sandbox.hit-pay.com/v1
// Prod:    https://api.hit-pay.com/v1

import crypto from "crypto";

const API_KEY  = () => process.env.HITPAY_API_KEY!;
const SALT     = () => process.env.HITPAY_SALT!;
const BASE_URL = () =>
  process.env.HITPAY_MODE === "production"
    ? "https://api.hit-pay.com/v1"
    : "https://api.sandbox.hit-pay.com/v1";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CreatePaymentRequestParams {
  amount: string;           // decimal string e.g. "50.00"
  currency: string;         // "SGD"
  method: "paynow_online" | "card";
  referenceNumber: string;  // enrollmentRef
  redirectUrl?: string;     // required for card
  name?: string;
  email?: string;
}

export interface HitPayPaymentRequest {
  id: string;
  status: string;
  url: string;              // HitPay hosted checkout URL (always present)
  qr_code_data?: {
    qr_code: string;        // raw PayNow EMV string — convert to QR image client-side
  };
  [key: string]: unknown;
}

// HitPay sends webhooks as application/x-www-form-urlencoded (not JSON).
// Fields: payment_id, payment_request_id, amount, currency, status, reference_number, hmac
export interface HitPayWebhookPayload {
  payment_id: string;
  payment_request_id: string;  // matches hitpay_payment_id stored in payments table
  amount: string;
  currency: string;
  status: "completed" | "pending" | "failed";
  reference_number: string;
  hmac: string;
  [key: string]: string;
}

// ── 1. Create Payment Request ──────────────────────────────────────────────

async function createPaymentRequest(
  params: CreatePaymentRequestParams,
): Promise<HitPayPaymentRequest> {
  const body: Record<string, unknown> = {
    amount: params.amount,
    currency: params.currency,
    payment_methods: [params.method],
    reference_number: params.referenceNumber,
  };

  if (params.method === "paynow_online") {
    body.generate_qr = true;
  } else {
    body.redirect_url = params.redirectUrl;
  }

  if (params.name)  body.name  = params.name;
  if (params.email) body.email = params.email;

  const bodyStr = new URLSearchParams(
    Object.entries(body).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map((item) => [k + "[]", String(item)]) : [[k, String(v)]]
    )
  ).toString();

  const res = await fetch(`${BASE_URL()}/payment-requests`, {
    method: "POST",
    headers: {
      "X-BUSINESS-API-KEY": API_KEY(),
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyStr,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HitPay createPaymentRequest failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── 2. Verify Webhook Signature ────────────────────────────────────────────
// HitPay sends webhooks as application/x-www-form-urlencoded.
// The HMAC is included as an `hmac` field in the body (not a header).
// Verification: sort all fields except `hmac` alphabetically by key,
// concatenate as `key + value` (no separator between pairs),
// then compute HMAC-SHA256 with the salt and compare.

function verifyWebhook(bodyText: string, hmac: string): boolean {
  const params = new URLSearchParams(bodyText);
  const str = Array.from(params.entries())
    .filter(([k]) => k !== "hmac")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => k + v)
    .join("");
  const computed = crypto.createHmac("sha256", SALT()).update(str).digest("hex");
  const computedBuf = Buffer.from(computed);
  const hmacBuf = Buffer.from(hmac);
  if (computedBuf.length !== hmacBuf.length) return false;
  return crypto.timingSafeEqual(computedBuf, hmacBuf);
}

// ── 3. Parse Webhook Payload ───────────────────────────────────────────────
// Body is application/x-www-form-urlencoded — parse with URLSearchParams.

function parseWebhookPayload(bodyText: string): HitPayWebhookPayload {
  const params = new URLSearchParams(bodyText);
  return Object.fromEntries(params.entries()) as unknown as HitPayWebhookPayload;
}

// ── Export ──────────────────────────────────────────────────────────────────

const hitpay = { createPaymentRequest, verifyWebhook, parseWebhookPayload };
export default hitpay;
