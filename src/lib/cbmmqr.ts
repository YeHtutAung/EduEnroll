// ─── CB Bank QR Gateway (MMQR) client ───────────────────────────────────────
// Design: docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md
// CB API: QR Gateway API Specification v1.0.10 (CB's PDF; not in the repo).
//
// Pure module: no Supabase, no Next.js imports. Mirrors src/lib/kbzpay.ts.

import { randomBytes, timingSafeEqual } from "crypto";

// ── Merchants ──────────────────────────────────────────────────────────────

/**
 * One CB merchant's credentials, read from `CBMMQR_<ID>_*` (spec §6). A
 * tenant's merchant id comes from cbmmqr_merchant_assignments and is pinned on
 * each payment row; every call for an order uses the merchant pinned on it.
 */
export type CbMerchant = {
  id: string;
  userId: string;
  password: string;
  sourceId: string;
  merchantId: string;
  terminalId: string;
  /** The static key CB sends on callbacks. */
  apiKey: string;
};
// No notify origin: CB's /dynamicqr takes no callback URL. The URL is
// registered with CB out of band, per merchant and environment.

const MERCHANT_ID_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * Resolves a merchant, failing closed. There is deliberately NO fallback to
 * another merchant: that is how one tenant's buyers would pay another's
 * account. Errors name the variable, never its value.
 */
export function getCbMerchant(id: string | null | undefined): CbMerchant {
  if (!id || !MERCHANT_ID_PATTERN.test(id)) {
    throw new Error("CB merchant id is missing or malformed");
  }

  const read = (suffix: string): string => {
    const name = `CBMMQR_${id}_${suffix}`;
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };

  return {
    id,
    userId: read("USER_ID"),
    password: read("PASSWORD"),
    sourceId: read("SOURCE_ID"),
    merchantId: read("MERCHANT_ID"),
    terminalId: read("TERMINAL_ID"),
    apiKey: read("API_KEY"),
  };
}

// ── Reference ──────────────────────────────────────────────────────────────

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** `CB` + 23 base32 characters: 25, CB's referenceNo maximum. */
export const REFERENCE_PATTERN = /^CB[A-Z2-7]{23}$/;

/**
 * Our referenceNo, stored as payments.payment_ref. 115 bits of randomness, so
 * collisions are not a practical concern, and the `CB` prefix keeps it apart
 * from every other provider's format (KBZPay's start `KBZ_`). The unique index
 * on payment_ref is still the backstop (spec §5.0).
 */
export function buildReferenceNo(): string {
  const bytes = randomBytes(15); // 120 bits → 24 base32 characters
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `CB${out.slice(0, 23)}`;
}

// ── Time ───────────────────────────────────────────────────────────────────

const CB_TIMESTAMP = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const OFFSET_PATTERN = /^[+-]\d{2}:\d{2}$/;

/**
 * CB's timestamps carry no zone. Myanmar has one fixed offset and no DST, so a
 * configured offset (default +06:30) is enough; it is gate G2 to confirm it.
 */
function utcOffset(): string {
  const raw = (process.env.CBMMQR_UTC_OFFSET ?? "+06:30").trim();
  if (!OFFSET_PATTERN.test(raw)) {
    throw new Error('CBMMQR_UTC_OFFSET must look like "+06:30"');
  }
  return raw;
}

/**
 * `20261031 10:14:14` → epoch ms, or null when it is not in that exact shape
 * or not a real date. Callers treat null as "do not display this QR".
 */
export function parseCbTimestamp(value: unknown): number | null {
  const offset = utcOffset();
  if (typeof value !== "string") return null;
  const m = CB_TIMESTAMP.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  // Date.parse rolls 2026-13-31 over instead of failing; refuse it.
  const check = new Date(ms + offsetMs(offset));
  if (check.getUTCMonth() + 1 !== Number(mo) || check.getUTCDate() !== Number(d)) return null;
  return ms;
}

function offsetMs(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  return sign * (h * 60 + m) * 60_000;
}

// ── Return codes ───────────────────────────────────────────────────────────
// CB's §4.2 gives several codes two meanings (0006, 0017, 0018), so a code is
// never interpreted alone where money is concerned (spec §3).

export const CB_SUCCESS = "0000";

/** CB's returnCode arrives as a number or a string; normalise to 4 digits. */
export function normaliseCode(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 9999 ? String(value).padStart(4, "0") : null;
  }
  if (typeof value === "string" && /^\d{1,4}$/.test(value.trim())) {
    return value.trim().padStart(4, "0");
  }
  return null;
}

/** Waiting for payment (0006) / in progress (0008). */
export function isPendingCode(code: string | null): boolean {
  return code === "0006" || code === "0008";
}

/**
 * Codes on /dynamicqr after which CB has created NOTHING, so the row may be
 * marked FAILED (spec §5.1 step 6). Every other code is ambiguous.
 */
export const CREATE_REJECTIONS: Readonly<Record<string, "below_minimum" | "above_maximum" | "config">> = {
  "0051": "below_minimum",
  "0052": "above_maximum",
  "0001": "config", // invalid merchant id
  "0002": "config", // invalid terminal id
  "0016": "config", // please change password
  "0021": "config", // invalid user id or password
};

// ── Callback key ───────────────────────────────────────────────────────────

/** Constant-time comparison of the callback's apiKey with the expected key. */
export function apiKeyMatches(received: unknown, expected: string): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Currency ───────────────────────────────────────────────────────────────

/** CB sends ISO 4217 numeric. 104 is MMK; nothing else is accepted. */
export function currencyFromCb(value: unknown): "MMK" | null {
  return String(value ?? "").trim() === "104" ? "MMK" : null;
}
