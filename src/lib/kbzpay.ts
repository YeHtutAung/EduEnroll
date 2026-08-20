// ─── KBZPay Payment Gateway (PGW) MMQR client ───────────────────────────────
// Docs: https://wap.kbzpay.com/pgw/uat/api/  (MMQR Payment)
// Design: docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md
//
// Pure module: no Supabase, no Next.js imports. Everything here is unit-testable
// against the vectors the provider publishes.

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
