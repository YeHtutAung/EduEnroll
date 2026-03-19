// ─── Meta Webhook Signature Verification ────────────────────────────────────
// Verifies X-Hub-Signature-256 header using HMAC-SHA256 with the app secret.
// https://developers.facebook.com/docs/messenger-platform/webhooks#validate-payloads

import { createHmac } from "crypto";

const APP_SECRET = process.env.MESSENGER_APP_SECRET;

export function verifyMetaSignature(rawBody: string, signature: string | null): boolean {
  if (!APP_SECRET) {
    // Skip verification if secret not configured — avoids breaking the bot
    console.warn("[messenger] MESSENGER_APP_SECRET not set, skipping signature verification");
    return true;
  }

  if (!signature) return false;

  // Header format: "sha256=<hex>"
  const expected = "sha256=" + createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  return signature === expected;
}
