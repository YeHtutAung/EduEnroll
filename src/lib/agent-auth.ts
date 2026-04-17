// ─── Agent HMAC signature verification ────────────────────────────────────────
// Mirrors Messenger's X-Hub-Signature-256 approach.
//
// The Agent (KuuNyi bot service) signs every request with:
//   HMAC-SHA256(chatId + "." + rawBody, AGENT_SECRET)
//
// Including chatId in the signed payload means it cannot be swapped without
// breaking the signature — even though chatId travels in a header.
//
// For GET requests rawBody is "". For POST/PATCH rawBody is the request body.

import { createHmac, timingSafeEqual } from "crypto";

export function verifyAgentSignature(
  chatId: string,
  rawBody: string,
  signature: string,
): boolean {
  const agentSecret = process.env.AGENT_SECRET;
  if (!agentSecret) {
    console.warn("[agent-auth] AGENT_SECRET not configured");
    return false;
  }

  const payload = `${chatId}.${rawBody}`;
  const expected = "sha256=" + createHmac("sha256", agentSecret).update(payload).digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

// ─── Build student-facing URLs for notifications ───────────────────────────────

export function buildStudentUrls(tenantSlug: string, enrollmentRef: string) {
  const domain = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "kuunyi.com";
  const base = `https://${tenantSlug}.${domain}`;
  return {
    statusUrl: `${base}/status?ref=${enrollmentRef}`,
    paymentUrl: `${base}/enroll/payment/${enrollmentRef}`,
  };
}
