// ─── ABank APlus Wallet MMQR API client ─────────────────────────────────────
// Docs: ABank Merchant Third-Party Acquiring QR Service
// UAT:  https://merchant-thirdparty-api-uat.abdev.net/acquiring-qr-service
// PROD: https://merchant-thirdparty-api.apluswallet.com.mm/acquiring-qr-service

const SECRET_KEY = () => process.env.ABANK_SECRET_KEY!;
const EC_CODE = () => process.env.ABANK_EC_CODE!;
const MERCHANT_ID = () => process.env.ABANK_MERCHANT_ID!;
const CHANNEL_CODE = () => process.env.ABANK_CHANNEL_CODE ?? "";
const BASE_URL = () =>
  process.env.ABANK_MODE === "production"
    ? "https://merchant-thirdparty-api.apluswallet.com.mm/acquiring-qr-service"
    : "https://merchant-thirdparty-api-uat.abdev.net/acquiring-qr-service";

// ── Auth headers (required on every call) ──────────────────────────────────

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    secretKey: SECRET_KEY(),
    eccode: EC_CODE(),
  };
}

// ── Helper: format date as yyyy-MM-dd HH:mm:ss ────────────────────────────

function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface CreateOrderParams {
  orderId: string; // ≤ 20 chars, maps to enrollment ref or short ID
  amount: number; // in MMK
  description: string;
}

export interface CreateOrderResponse {
  qr: string; // QR string to render
  [key: string]: unknown;
}

// paymentTxnStatus codes
// 200 = Success, 100 = Pending, 500 = Fail, 400 = Refunded, 403 = Not Found
export type ABankTxnStatus = 200 | 100 | 500 | 400 | 403;

export interface EnquiryResponse {
  paymentTxnStatus: ABankTxnStatus;
  orderId?: string;
  amount?: number;
  transactionId?: string;
  [key: string]: unknown;
}

export interface CallbackParams {
  orderId: string;
  amount: string;
  status: string;
  transactionId: string;
  billNo: string;
  endToEndId: string;
  transactionDateTime: string;
  institutionName: string;
  // Fail-only
  errorCode?: string;
  errorDesc?: string;
}

// ── 1. Create Order ────────────────────────────────────────────────────────

async function createOrder(params: CreateOrderParams): Promise<CreateOrderResponse> {
  const requestNo = `REQ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = formatDate(new Date());

  const body: Record<string, unknown> = {
    requestNo,
    orderId: params.orderId,
    merchantId: MERCHANT_ID(),
    amount: params.amount,
    currency: "MMK",
    rewardPoint: 0,
    description: params.description,
    createdDate: now,
  };

  const channelCode = CHANNEL_CODE();
  if (channelCode) {
    body.channelCode = channelCode;
  }

  const res = await fetch(`${BASE_URL()}/v1/order/create`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ABank createOrder failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── 2. Enquiry Order ───────────────────────────────────────────────────────

async function enquiryOrder(orderId: string): Promise<EnquiryResponse> {
  const res = await fetch(`${BASE_URL()}/v1/order/posEnquiry/${encodeURIComponent(orderId)}`, {
    method: "GET",
    headers: authHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ABank enquiry failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── 3. Parse callback query params ─────────────────────────────────────────

function parseCallback(searchParams: URLSearchParams): CallbackParams {
  return {
    orderId: searchParams.get("orderId") ?? "",
    amount: searchParams.get("amount") ?? "",
    status: searchParams.get("status") ?? "",
    transactionId: searchParams.get("transactionId") ?? "",
    billNo: searchParams.get("billNo") ?? "",
    endToEndId: searchParams.get("endToEndId") ?? "",
    transactionDateTime: searchParams.get("transactionDateTime") ?? "",
    institutionName: searchParams.get("institutionName") ?? "",
    errorCode: searchParams.get("errorCode") ?? undefined,
    errorDesc: searchParams.get("errorDesc") ?? undefined,
  };
}

// ── Export ──────────────────────────────────────────────────────────────────

const abank = {
  createOrder,
  enquiryOrder,
  parseCallback,
};

export default abank;
