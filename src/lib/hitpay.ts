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

// HitPay sends webhooks as application/json.
export interface HitPayWebhookPayload {
  id: string;                  // payment request ID — matches hitpay_payment_id in payments table
  status: "completed" | "pending" | "failed";
  payments?: Array<{
    payment_type: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
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
    // The response body can carry customer data, internal tokens and provider
    // diagnostics. It is never attached to the error, because an error message
    // ends up in persistent logs and truncating it is not sanitizing it. The
    // HTTP status is the only safe diagnostic, and it travels as a structured
    // field so callers do not have to parse the message.
    const err = new Error(
      `HitPay createPaymentRequest failed (HTTP ${res.status})`,
    ) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// ── 2. Verify Webhook Signature ────────────────────────────────────────────
// HitPay sends webhooks as application/json.
// Signature header: Hitpay-Signature (HMAC-SHA256 of raw body using salt).

function verifyWebhook(bodyText: string, signature: string): boolean {
  const computed = crypto.createHmac("sha256", SALT()).update(bodyText).digest("hex");
  const computedBuf = Buffer.from(computed);
  const signatureBuf = Buffer.from(signature);
  if (computedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(computedBuf, signatureBuf);
}

// ── 3. Parse Webhook Payload ───────────────────────────────────────────────
// Body is application/json.

function parseWebhookPayload(bodyText: string): HitPayWebhookPayload {
  return JSON.parse(bodyText) as HitPayWebhookPayload;
}

// ── Export ──────────────────────────────────────────────────────────────────

const hitpay = { createPaymentRequest, verifyWebhook, parseWebhookPayload };
export default hitpay;
