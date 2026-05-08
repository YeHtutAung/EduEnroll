// ─── SmsPoh SMS sender ─────────────────────────────────────────────────────

const SMSPOH_BASE_URL = "https://v3.smspoh.com/api/rest";

function getBearerToken(): string | null {
  const key = process.env.SMSPOH_API_KEY;
  const secret = process.env.SMSPOH_API_SECRET;
  if (!key || !secret) return null;
  return Buffer.from(`${key}:${secret}`).toString("base64");
}

export interface SendSmsOptions {
  to: string;
  message: string;
  clientReference?: string;
  from?: string;
}

export interface SmsMessage {
  messageId: string;
  status: string;
  to: string;
  createdAt: string;
}

// ─── Send SMS ───────────────────────────────────────────────────────────────

export async function sendSms({
  to,
  message,
  clientReference,
  from,
}: SendSmsOptions): Promise<boolean> {
  const token = getBearerToken();
  if (!token) {
    console.warn("[sms] SMSPOH_API_KEY or SMSPOH_API_SECRET not set — skipping SMS.");
    return false;
  }

  const senderId = from ?? process.env.SMSPOH_SENDER_ID ?? "NihonMoment";
  const isTest = process.env.NODE_ENV !== "production";

  try {
    const res = await fetch(`${SMSPOH_BASE_URL}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to,
        message,
        from: senderId,
        clientReference,
        test: isTest,
        unicode: false,
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "unknown");
      console.error(`[sms] Send failed ${res.status}:`, err);
      return false;
    }

    const data = (await res.json()) as { messages: SmsMessage[] };
    const msg = data.messages?.[0];
    if (msg) {
      console.log(`[sms] Sent to ${msg.to} — status: ${msg.status}, id: ${msg.messageId}`);
    }
    return true;
  } catch (err) {
    console.error("[sms] Send error:", err);
    return false;
  }
}

// ─── Account balance ────────────────────────────────────────────────────────

export interface SmsBalance {
  balance: number;
  currency: string;
}

export async function getSmsBalance(): Promise<SmsBalance | null> {
  const token = getBearerToken();
  if (!token) return null;

  try {
    const res = await fetch(`${SMSPOH_BASE_URL}/account/get-balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as SmsBalance;
  } catch {
    return null;
  }
}
