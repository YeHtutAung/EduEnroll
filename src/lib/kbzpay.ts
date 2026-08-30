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

// ── Transport ──────────────────────────────────────────────────────────────

const APPID = () => process.env.KBZPAY_APPID!;
const MERCH_CODE = () => process.env.KBZPAY_MERCH_CODE!;
const APP_KEY = () => process.env.KBZPAY_APP_KEY!;

// Always HTTPS. The UAT docs print http:// for precreate and queryorder, but
// merchant credentials and signatures must not cross the wire in the clear.
// Spec §3.1, gate G2.
const BASE = () =>
  process.env.KBZPAY_MODE === "production"
    ? "https://api.kbzpay.com/payment/gateway"
    : "https://api-uat.kbzpay.com/payment/gateway/uat";

function nonce(): string {
  return randomBytes(16).toString("hex").toUpperCase();
}

type CallResult = {
  ok: boolean;
  body?: Record<string, KbzField>;
  code?: string;
  msg?: string;
};

async function call(
  path: string,
  method: string,
  version: string,
  bizContent: Record<string, KbzField>,
  extraCommon: Record<string, KbzField> = {},
): Promise<CallResult> {
  const request: Record<string, KbzField> = {
    timestamp: Math.floor(Date.now() / 1000).toString(),
    method,
    nonce_str: nonce(),
    sign_type: "SHA256",
    version,
    biz_content: bizContent,
    ...extraCommon,
  };
  request.sign = sign(request, APP_KEY());

  let res: Response;
  try {
    res = await fetch(`${BASE()}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Request: request }),
    });
  } catch (err) {
    // Never log the signing input — it ends with the app key.
    console.error(`[kbzpay] ${method} transport error:`, err instanceof Error ? err.message : err);
    return { ok: false };
  }

  if (!res.ok) {
    console.error(`[kbzpay] ${method} HTTP ${res.status}`);
    return { ok: false };
  }

  const json = (await res.json()) as { Response?: Record<string, KbzField> };
  const body = json?.Response;
  if (!body) return { ok: false };

  // Spec §3.5: check `result` first, then `code`, then the business fields.
  const code = typeof body.code === "string" ? body.code : undefined;
  const msg = typeof body.msg === "string" ? body.msg : undefined;

  if (body.result !== "SUCCESS" || code !== "0") {
    console.error(`[kbzpay] ${method} failed: code=${code} msg=${msg}`);
    return { ok: false, body, code, msg };
  }

  return { ok: true, body, code, msg };
}

// ── 1. Create order ────────────────────────────────────────────────────────

export type PrecreateParams = {
  merchOrderId: string;
  amount: number;
  title: string;
  notifyUrl: string;
  /**
   * How long the QR stays payable, in minutes. KBZPay accepts 1-120.
   *
   * Must not outlive the enrollment: the tenant's auto-cancel timer rejects an
   * unpaid enrollment independently, and a QR that is still payable after that
   * lets a student pay for an enrollment that no longer exists. The caller
   * derives this from the tenant's own window.
   */
  timeoutMinutes: number;
};

export type PrecreateResult = { ok: false } | { ok: true; qrCode: string; prepayId: string };

/**
 * Last-resort sanity clamp on timeout_express.
 *
 * The POLICY — matching the QR window to the tenant's auto-cancel timer — lives
 * in the creation route, which is the only thing that knows the tenant. This
 * guard exists purely so a missing or nonsensical value cannot reach KBZPay as
 * a malformed string: `${undefined}m` is "undefinedm", which they would reject
 * or, worse, interpret.
 */
function safeTimeoutMinutes(value: number): number {
  if (!Number.isFinite(value)) return 120;
  return Math.min(Math.max(Math.floor(value), 1), 120);
}

export async function precreate(p: PrecreateParams): Promise<PrecreateResult> {
  const r = await call(
    "precreate",
    "kbz.payment.precreate",
    "1.0",
    {
      appid: APPID(),
      merch_code: MERCH_CODE(),
      merch_order_id: p.merchOrderId,
      trade_type: "PAY_BY_QRCODE",
      title: p.title,
      total_amount: String(p.amount),
      trans_currency: "MMK",
      timeout_express: `${safeTimeoutMinutes(p.timeoutMinutes)}m`,
    },
    { notify_url: p.notifyUrl },
  );

  if (!r.ok || typeof r.body?.qrCode !== "string") return { ok: false };

  return {
    ok: true,
    qrCode: r.body.qrCode,
    prepayId: typeof r.body.prepay_id === "string" ? r.body.prepay_id : "",
  };
}

// ── 2. Query order ─────────────────────────────────────────────────────────

export type TradeStatus =
  | "PAY_SUCCESS"
  | "PAY_FAILED"
  | "WAIT_PAY"
  | "PAYING"
  | "ORDER_EXPIRED"
  | "ORDER_CLOSED"
  | "ORDER_NOT_FOUND";

export type QueryResult =
  | { ok: false }
  | {
      ok: true;
      tradeStatus: TradeStatus;
      totalAmount?: string;
      transCurrency?: string;
      mmOrderId?: string;
      walletIdentifier?: string;
    };

/**
 * The single source of truth for whether an order is payable. Spec §7 —
 * no terminal mmqr_status transition and no order-slot release may be decided
 * from local state; only from this call's answer.
 */
export async function queryOrder(merchOrderId: string): Promise<QueryResult> {
  const r = await call("queryorder", "kbz.payment.queryorder", "3.0", {
    appid: APPID(),
    merch_code: MERCH_CODE(),
    merch_order_id: merchOrderId,
  });

  // "The order does not exist" is an ANSWER, not a failure: it is the only
  // thing that proves KBZPay holds no order under this reference, which is
  // what lets a row become FAILED. Spec R13.
  if (!r.ok && r.code === "QUERYORDER_FAIL") {
    return { ok: true, tradeStatus: "ORDER_NOT_FOUND" };
  }

  if (!r.ok || typeof r.body?.trade_status !== "string") return { ok: false };

  return {
    ok: true,
    // The docs' own success example prints " PAY_SUCCESS" with a leading space.
    tradeStatus: r.body.trade_status.trim() as TradeStatus,
    totalAmount: typeof r.body.total_amount === "string" ? r.body.total_amount : undefined,
    transCurrency: typeof r.body.trans_currency === "string" ? r.body.trans_currency : undefined,
    mmOrderId: typeof r.body.mm_order_id === "string" ? r.body.mm_order_id : undefined,
    walletIdentifier:
      typeof r.body.Wallet_identifier === "string" ? r.body.Wallet_identifier : undefined,
  };
}

// ── 3. Close order ─────────────────────────────────────────────────────────

/**
 * `ok: true` means ONLY "the close call did not error". It is NOT proof the
 * order went unpaid: ORDER_ALREADY_CLOSED and QUERYORDER_FAIL say the order is
 * not payable *now*, without saying whether it was cancelled or completed.
 * The caller MUST re-query afterwards. Spec §5.1 step 7b, R12.
 */
export async function closeOrder(merchOrderId: string): Promise<{ ok: boolean }> {
  const r = await call("closeorder", "kbz.payment.closeorder", "3.0", {
    appid: APPID(),
    merch_code: MERCH_CODE(),
    merch_order_id: merchOrderId,
  });

  if (r.ok) return { ok: true };
  if (r.code === "ORDER_ALREADY_CLOSED" || r.code === "QUERYORDER_FAIL") return { ok: true };
  return { ok: false };
}

// ── Export ─────────────────────────────────────────────────────────────────

const kbzpay = { precreate, queryOrder, closeOrder, sign, verifySign, buildMerchOrderId };
export default kbzpay;
