// ─── PayPay Web Payment API client ──────────────────────────────────────────
// Docs: https://developer.paypay.ne.jp/products/docs/webpayment
// API:  https://www.paypay.ne.jp/opa/doc/v1.0/webcashier
//
// Sandbox: https://stg-api.sandbox.paypay.ne.jp
// Prod:    https://api.paypay.ne.jp

import crypto from "crypto";

const API_KEY = () => process.env.PAYPAY_API_KEY!;
const API_SECRET = () => process.env.PAYPAY_API_SECRET!;
const MERCHANT_ID = () => process.env.PAYPAY_MERCHANT_ID!;
const WEBHOOK_SECRET = () => process.env.PAYPAY_WEBHOOK_SECRET ?? API_SECRET();
const BASE_URL = () =>
  process.env.PAYPAY_MODE === "production"
    ? "https://api.paypay.ne.jp"
    : "https://stg-api.sandbox.paypay.ne.jp";

// ── HMAC-SHA256 Auth Headers ────────────────────────────────────────────────
// PayPay OPA HMAC format (from official SDK):
// String to sign: {path}\n{method}\n{nonce}\n{epoch}\n{contentType}\n{payloadDigest}
// For GET/no-body: contentType="empty", payloadDigest="empty"
// For POST: contentType="application/json", payloadDigest=base64(MD5(contentType+body))
// Authorization: hmac OPA-Auth:{apiKey}:{hmac}:{nonce}:{epoch}:{payloadDigest}

function authHeaders(
  method: string,
  path: string,
  body?: string,
): Record<string, string> {
  const nonce = crypto.randomUUID();
  const epoch = Math.floor(Date.now() / 1000).toString();

  let contentType: string;
  let payloadDigest: string;

  if (body) {
    contentType = "application/json";
    payloadDigest = crypto
      .createHash("md5")
      .update(contentType + body, "utf8")
      .digest("base64");
  } else {
    contentType = "empty";
    payloadDigest = "empty";
  }

  // String to sign
  const message = `${path}\n${method}\n${nonce}\n${epoch}\n${contentType}\n${payloadDigest}`;
  const hmac = crypto
    .createHmac("sha256", API_SECRET())
    .update(message)
    .digest("base64");

  const headers: Record<string, string> = {
    Authorization: `hmac OPA-Auth:${API_KEY()}:${hmac}:${nonce}:${epoch}:${payloadDigest}`,
    "X-ASSUME-MERCHANT": MERCHANT_ID(),
  };

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface CreateQRParams {
  merchantPaymentId: string; // unique per transaction, <=64 chars
  amount: number; // in JPY (integer, no decimals)
  orderDescription?: string; // <=255 chars
  redirectUrl: string; // where to redirect after payment
}

export interface CreateQRResponse {
  resultInfo: { code: string; message: string };
  data: {
    codeId: string;
    url: string; // PayPay payment page URL
    deeplink: string; // PayPay app deeplink
    expiryDate: number; // epoch ms
    merchantPaymentId: string;
    amount: { amount: number; currency: string };
    [key: string]: unknown;
  };
}

export interface PaymentStatusResponse {
  resultInfo: { code: string; message: string };
  data: {
    paymentId: string;
    status: "CREATED" | "COMPLETED" | "CANCELED" | "EXPIRED" | "FAILED";
    merchantPaymentId: string;
    amount: { amount: number; currency: string };
    [key: string]: unknown;
  };
}

export interface WebhookPayload {
  notification_type: string; // "Transaction"
  merchant_id: string;
  store_id?: string;
  notification_id: string;
  notification_data: string; // JSON string containing payment details
  notification_timestamp: number;
}

export interface WebhookNotificationData {
  merchantPaymentId: string;
  paymentId: string;
  state: "COMPLETED" | "AUTHORIZED" | "CANCELED" | "EXPIRED" | "FAILED";
  amount: { amount: number; currency: string };
  paidAt?: string;
  [key: string]: unknown;
}

// ── 1. Create QR Code ───────────────────────────────────────────────────────

async function createQR(params: CreateQRParams): Promise<CreateQRResponse> {
  const path = "/v2/codes";
  const body = JSON.stringify({
    merchantPaymentId: params.merchantPaymentId,
    amount: { amount: params.amount, currency: "JPY" },
    codeType: "ORDER_QR",
    orderDescription: params.orderDescription ?? "",
    redirectUrl: params.redirectUrl,
    redirectType: "WEB_LINK",
  });

  const headers = authHeaders("POST", path, body);

  const res = await fetch(`${BASE_URL()}${path}`, {
    method: "POST",
    headers,
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPay createQR failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── 2. Get Payment Status ───────────────────────────────────────────────────

async function getPaymentStatus(merchantPaymentId: string): Promise<PaymentStatusResponse> {
  const path = `/v2/codes/payments/${encodeURIComponent(merchantPaymentId)}`;
  const headers = authHeaders("GET", path);

  const res = await fetch(`${BASE_URL()}${path}`, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPay getPaymentStatus failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── 3. Parse & Verify Webhook ───────────────────────────────────────────────
// PayPay webhook verification: HMAC-SHA256 of raw body using webhook secret.

function verifyWebhook(bodyText: string, signature: string): boolean {
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET())
    .update(bodyText, "utf8")
    .digest("hex");
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

function parseWebhookPayload(bodyText: string): {
  webhook: WebhookPayload;
  data: WebhookNotificationData;
} {
  const webhook: WebhookPayload = JSON.parse(bodyText);
  const data: WebhookNotificationData = JSON.parse(webhook.notification_data);
  return { webhook, data };
}

// ── Export ──────────────────────────────────────────────────────────────────

const paypay = {
  createQR,
  getPaymentStatus,
  verifyWebhook,
  parseWebhookPayload,
};

export default paypay;
