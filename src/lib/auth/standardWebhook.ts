import { createHmac, timingSafeEqual } from "crypto";

// ─── Standard Webhooks signature check ──────────────────────────────────────
//
// Supabase signs Auth hook requests per https://www.standardwebhooks.com:
// headers webhook-id, webhook-timestamp (Unix seconds) and webhook-signature
// (space-separated `v1,<base64>` entries). The signed content is
// `${id}.${timestamp}.${rawBody}`, HMAC-SHA256, keyed with the base64-decoded
// secret after stripping a leading `v1,` and `whsec_`. No dependency needed.

const TOLERANCE_S = 300;

export function verifyStandardWebhook(opts: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowSeconds?: number;
}): boolean {
  const { id, timestamp, signature, body } = opts;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_S) return false;

  const key = Buffer.from(opts.secret.replace(/^v1,/, "").replace(/^whsec_/, ""), "base64");
  // An empty key is a key anyone can sign with.
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();

  return signature.split(" ").some((entry) => {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
