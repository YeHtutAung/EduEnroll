// ─── KBZPay Payment Gateway (PGW) MMQR client ───────────────────────────────
// Docs: https://wap.kbzpay.com/pgw/uat/api/  (MMQR Payment)
// Design: docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md
//
// Pure module: no Supabase, no Next.js imports. Everything here is unit-testable
// against the vectors the provider publishes.

import { createHash, randomBytes, timingSafeEqual } from "crypto";

export type KbzField = string | number | null | undefined | unknown;

// ── Signature: stringA construction ────────────────────────────────────────

/**
 * Step 1 of the KBZPay signature algorithm (spec §3.3).
 *
 * Flattens biz_content into the common params, drops sign/sign_type, drops
 * empty values, drops JSONArray/object fields (e.g. refund_info), sorts the
 * keys, and joins them as k=v&k=v.
 *
 * The sort MUST use the default comparator, which orders by UTF-16 code unit —
 * i.e. ASCII for these keys. localeCompare() is wrong here: the callback's
 * `Wallet_identifier` has a capital W and must sort ahead of every lowercase
 * key, which a locale-aware collation would not guarantee.
 */
export function buildStringA(input: Record<string, KbzField>): string {
  const flat: Record<string, string> = {};

  const absorb = (obj: Record<string, KbzField>) => {
    for (const [key, value] of Object.entries(obj)) {
      if (key === "sign" || key === "sign_type") continue;

      // biz_content is flattened INTO the same map rather than serialised —
      // the published vector proves its fields sit alongside the common ones.
      if (key === "biz_content" && value && typeof value === "object" && !Array.isArray(value)) {
        absorb(value as Record<string, KbzField>);
        continue;
      }

      if (value === null || value === undefined) continue;
      if (typeof value === "object") continue; // JSONArray / nested object

      const str = String(value);
      if (str === "") continue;

      flat[key] = str;
    }
  };

  absorb(input);

  return Object.keys(flat)
    .sort() // ASCII / UTF-16 code unit order — NEVER localeCompare
    .map((k) => `${k}=${flat[k]}`)
    .join("&");
}

// ── Signature: sign and verify ─────────────────────────────────────────────

/**
 * SHA256 — NOT HMAC — of stringA + "&key=" + appKey, as uppercase hex.
 *
 * The signing input ends with the app key, so it must never be logged.
 */
export function sign(input: Record<string, KbzField>, appKey: string): string {
  const stringToSign = `${buildStringA(input)}&key=${appKey}`;
  return createHash("sha256").update(stringToSign, "utf8").digest("hex").toUpperCase();
}

/**
 * Verifies a signature over WHATEVER keys arrived — never a fixed field list.
 *
 * The docs warn that the API may add fields and that extension fields must be
 * supported when verifying, so a hardcoded list would break every callback the
 * day KBZPay adds one. Spec §3.3.
 */
export function verifySign(payload: Record<string, KbzField>, appKey: string): boolean {
  const received = payload.sign;
  if (typeof received !== "string" || received.length !== 64) return false;

  const expected = sign(payload, appKey);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received.toUpperCase(), "utf8");
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

// ── Merchant order reference ───────────────────────────────────────────────

/**
 * KBZ_{8 hex of enrollment id}_{16 hex random} — 29 chars, 64 bits of entropy.
 *
 * Randomness rather than a timestamp: two concurrent requests for the same
 * enrollment in the same millisecond would otherwise produce the same
 * reference, and because the webhooks and status routes resolve payment_ref
 * with .single(), a duplicate breaks settlement for BOTH payments rather than
 * merely creating a stray row. Spec R1.
 *
 * The enrollment prefix is kept purely so a reference is recognisable during
 * support and log triage.
 */
export function buildMerchOrderId(enrollmentId: string): string {
  const short = enrollmentId.replace(/-/g, "").slice(0, 8);
  return `KBZ_${short}_${randomBytes(8).toString("hex")}`;
}
