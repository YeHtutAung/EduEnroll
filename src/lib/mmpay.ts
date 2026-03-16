import crypto from "crypto";

// ─── MyanMyanPay client ─────────────────────────────────────────────────────
// Custom implementation matching docs at https://docs.myanmyanpay.com/api/
// The npm SDK uses outdated endpoint paths (/sandbox-create vs /test-create).

const APP_ID = () => process.env.MMPAY_APP_ID!;
const PK = () => process.env.MMPAY_PUBLISHABLE_KEY!;
const SK = () => process.env.MMPAY_SECRET_KEY!;
const BASE = () => process.env.MMPAY_API_URL!;

function generateSignature(bodyString: string, nonce: string): string {
  const stringToSign = `${nonce}.${bodyString}`;
  return crypto.createHmac("sha256", SK()).update(stringToSign).digest("hex");
}

interface PayRequest {
  orderId: string;
  amount: number;
  currency?: string;
  callbackUrl?: string;
  items?: { name: string; amount: number; quantity: number }[];
  customMessage?: string;
}

interface PayResponse {
  orderId: string;
  amount: number;
  currency: string;
  qr: string;
  status: string;
  transactionRefId?: string;
}

async function handshake(
  orderId: string,
  nonce: string,
  sandbox: boolean,
): Promise<string> {
  const path = sandbox ? "/payments/test-handshake" : "/payments/handshake";
  const payload = { orderId, nonce };
  const bodyString = JSON.stringify(payload);
  const signature = generateSignature(bodyString, nonce);

  const res = await fetch(`${BASE()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PK()}`,
      "X-Mmpay-Nonce": nonce,
      "X-Mmpay-Signature": signature,
    },
    body: bodyString,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Handshake failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.token;
}

async function createPayment(
  params: PayRequest,
  sandbox: boolean,
): Promise<PayResponse> {
  const nonce = Date.now().toString();
  const path = sandbox ? "/payments/test-create" : "/payments/create";

  const payload = {
    appId: APP_ID(),
    nonce,
    amount: params.amount,
    orderId: params.orderId,
    callbackUrl: params.callbackUrl,
    customMessage: params.customMessage,
    currency: params.currency ?? "MMK",
    items: params.items,
  };

  const bodyString = JSON.stringify(payload);
  const signature = generateSignature(bodyString, nonce);

  // Step 1: Handshake to get btoken
  const btoken = await handshake(params.orderId, nonce, sandbox);

  // Step 2: Create payment
  const res = await fetch(`${BASE()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PK()}`,
      "X-Mmpay-Btoken": btoken,
      "X-Mmpay-Nonce": nonce,
      "X-Mmpay-Signature": signature,
    },
    body: bodyString,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Payment create failed (${res.status}): ${text}`);
  }

  return res.json();
}

const mmpay = {
  sandboxPay: (params: PayRequest) => createPayment(params, true),
  pay: (params: PayRequest) => createPayment(params, false),

  async verifyCb(
    payloadString: string,
    nonce: string,
    expectedSignature: string,
  ): Promise<boolean> {
    const stringToSign = `${nonce}.${payloadString}`;
    const generated = crypto
      .createHmac("sha256", SK())
      .update(stringToSign)
      .digest("hex");
    return generated === expectedSignature;
  },
};

export default mmpay;
