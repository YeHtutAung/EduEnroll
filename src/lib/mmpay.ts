// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MMPaySDK } = require("mmpay-node-sdk");

/**
 * MyanMyanPay SDK singleton — server-side only.
 * Uses sandbox credentials in development, live in production.
 */
const mmpay = new MMPaySDK({
  appId: process.env.MMPAY_APP_ID!,
  publishableKey: process.env.MMPAY_PUBLISHABLE_KEY!,
  secretKey: process.env.MMPAY_SECRET_KEY!,
  apiBaseUrl: process.env.MMPAY_API_URL!,
});

export default mmpay as {
  pay: (opts: {
    orderId: string;
    amount: number;
    currency?: string;
    callbackUrl?: string;
    items?: { name: string; amount: number; quantity: number }[];
    customMessage?: string;
  }) => Promise<{ orderId: string; amount: number; currency: string; qr: string; status: string; transactionRefId?: string }>;
  sandboxPay: (opts: {
    orderId: string;
    amount: number;
    currency?: string;
    callbackUrl?: string;
    items?: { name: string; amount: number; quantity: number }[];
    customMessage?: string;
  }) => Promise<{ orderId: string; amount: number; currency: string; qr: string; status: string; transactionRefId?: string }>;
  verifyCb: (payloadString: string, nonce: string, signature: string) => Promise<boolean>;
};
