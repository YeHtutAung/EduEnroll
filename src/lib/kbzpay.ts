// ─── KBZPay Payment Gateway (PGW) MMQR client ───────────────────────────────
// Docs: https://wap.kbzpay.com/pgw/uat/api/  (MMQR Payment)
// Design: docs/superpowers/specs/2026-08-20-kbzpay-mmqr-integration-design.md
//
// Pure module: no Supabase, no Next.js imports. Everything here is unit-testable
// against the vectors the provider publishes.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { ProxyAgent } from "undici";

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

// KBZPay's UAT gateway is split by scheme, and not by any choice of ours.
// Probing all six host/scheme pairs on 2026-09-01 gave:
//
//   precreate    http 200 (gateway)   https 404 (bare nginx)
//   queryorder   http 200 (gateway)   https 404 (bare nginx)
//   closeorder   http 404             https 200 (gateway)
//
// exactly as the published docs print. Port 443 on api-uat.kbzpay.com exists
// but routes closeorder alone, so an all-HTTPS client cannot create an order
// at all. Production (api.kbzpay.com) answered 200 over HTTPS on all three.
//
// The plaintext hop is therefore accepted for UAT and ONLY for UAT. The app
// key itself never travels — it is the trailing term of a SHA256 preimage, so
// only the derived signature is sent — but appid, merch_code, the order
// reference and the amount do, in the clear and without integrity. Against
// test money that is a considered trade; production never asks for it.
//
// The production branch is taken first and unconditionally: no entry in the
// UAT table can downgrade it. Spec §3.1, gate G2.
const UAT_HTTPS_ENDPOINTS = new Set(["closeorder"]);

/**
 * Resolves KBZPAY_MODE, failing closed.
 *
 * Treating "anything that isn't production" as UAT is safe on a laptop and
 * catastrophic on a production deployment. Two UAT endpoints are plaintext,
 * call() never verifies a response signature, and queryorder is what this
 * design treats as the settlement authority (§5.1, R13) — so an on-path actor
 * answering a forged PAY_SUCCESS over HTTP would settle an order nobody paid.
 * A missing or misspelled KBZPAY_MODE must therefore refuse to run, not
 * quietly pick the plaintext table.
 *
 * Two rules, both required:
 *   - an unrecognised value is always an error, so `prod` surfaces as a typo
 *     rather than silently selecting UAT;
 *   - on VERCEL_ENV=production, only "production" is accepted at all.
 *
 * Preview and local are unaffected: they legitimately run UAT, and an unset
 * value stays the documented way to say so.
 */
function resolveMode(): "production" | "uat" {
  const raw = (process.env.KBZPAY_MODE ?? "").trim().toLowerCase();
  const isProductionDeployment = process.env.VERCEL_ENV === "production";

  if (raw === "production") return "production";

  if (isProductionDeployment) {
    throw new Error(
      'KBZPAY_MODE must be "production" on a production deployment — refusing to call the plaintext UAT gateway with production credentials.',
    );
  }

  // Deliberately not echoed: whatever is in there is operator-controlled and
  // has no business in a log line.
  if (raw !== "" && raw !== "uat") {
    throw new Error('KBZPAY_MODE is set to an unrecognised value — expected "production" or "uat".');
  }

  return "uat";
}

function endpointUrl(path: string): string {
  if (resolveMode() === "production") {
    return `https://api.kbzpay.com/payment/gateway/${path}`;
  }

  const scheme = UAT_HTTPS_ENDPOINTS.has(path) ? "https" : "http";
  return `${scheme}://api-uat.kbzpay.com/payment/gateway/uat/${path}`;
}

// ── Egress proxy and timeout ───────────────────────────────────────────────

// KBZPay allowlists caller IP addresses and silently drops everything else —
// an unregistered source sees a connection timeout, not a rejection. Vercel
// functions egress from a shared, rotating pool, so there is no address we can
// register. KBZPAY_PROXY_URL points at a host holding a reserved static IP,
// through which this client's traffic — and only this client's traffic — is
// routed. Unset means direct egress, exactly as before.
//
// The dispatcher is passed per request on purpose. Node ignores HTTP(S)_PROXY,
// and setGlobalDispatcher() would drag Supabase and every other integration
// through the proxy too.
let cachedProxy: ProxyAgent | null | undefined;

function egressDispatcher(): ProxyAgent | undefined {
  if (cachedProxy === undefined) {
    const url = process.env.KBZPAY_PROXY_URL;
    cachedProxy = url ? new ProxyAgent(url) : null;
  }
  return cachedProxy ?? undefined;
}

// A blackholed request would otherwise hang until the platform kills the
// function, leaving the payer watching a spinner.
//
// 6s, not 15s. The old value was longer than the serverless function limit it
// runs inside, which made it unreachable: on a blocked connection the platform
// killed the function at ~10s and returned a raw 502, so the handled
// { ok: false } path — and the friendly error built on it — could never run.
// Observed twice on staging at 10.87s and 10.82s.
const CALL_TIMEOUT_MS = 6_000;

/**
 * Below this, a call is not worth starting: it cannot plausibly complete, and
 * beginning one risks the platform killing the function mid-flight instead of
 * letting us answer.
 */
const MIN_CALL_MS = 1_000;

export type CallBudget = {
  /** Absolute epoch ms by which the whole request must be done. */
  deadlineMs: number;
};

/**
 * How long this call may take: its own timeout, or whatever is left of the
 * request budget, whichever is smaller. Returns null when there is not enough
 * left to bother.
 *
 * This exists because one request can make up to FOUR sequential gateway calls
 * (queryorder, closeorder, queryorder, precreate) and the function budget is
 * shared across all of them. Timing each call in isolation is what let the
 * total overrun the platform limit.
 */
function timeoutFor(budget: CallBudget | undefined, now: number): number | null {
  if (!budget) return CALL_TIMEOUT_MS;

  const remaining = budget.deadlineMs - now;
  if (remaining < MIN_CALL_MS) return null;

  return Math.min(CALL_TIMEOUT_MS, remaining);
}

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
  budget?: CallBudget,
): Promise<CallResult> {
  const timeout = timeoutFor(budget, Date.now());
  if (timeout === null) {
    // Answer rather than start something the platform will interrupt.
    console.error(`[kbzpay] ${method} skipped: request budget exhausted`);
    return { ok: false };
  }

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

  // Resolved outside the try on purpose. A bad KBZPAY_MODE is an operator
  // error, not a transport failure, and must not be laundered into a handled
  // { ok: false } that reads as KBZPay being unreachable.
  const url = endpointUrl(path);

  // The status check and the body read stay inside the guard. The timeout
  // signal remains armed until the body is consumed, so a response whose
  // headers arrive and whose body then stalls rejects here — outside it, that
  // rejection would escape call() and surface as a 500 at the payment route
  // instead of a handled { ok: false }. Malformed JSON lands here too.
  let json: { Response?: Record<string, KbzField> } | undefined;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Request: request }),
      signal: AbortSignal.timeout(timeout),
      dispatcher: egressDispatcher(),
    } as RequestInit & { dispatcher?: ProxyAgent });

    if (!res.ok) {
      console.error(`[kbzpay] ${method} HTTP ${res.status}`);
      return { ok: false };
    }

    json = (await res.json()) as { Response?: Record<string, KbzField> };
  } catch (err) {
    // Never log the signing input — it ends with the app key.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    console.error(
      `[kbzpay] ${method} transport error${timedOut ? " (timeout — check IP allowlisting)" : ""}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false };
  }

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

export async function precreate(p: PrecreateParams, budget?: CallBudget): Promise<PrecreateResult> {
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
    budget,
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
export async function queryOrder(merchOrderId: string, budget?: CallBudget): Promise<QueryResult> {
  const r = await call("queryorder", "kbz.payment.queryorder", "3.0", {
    appid: APPID(),
    merch_code: MERCH_CODE(),
    merch_order_id: merchOrderId,
  }, {}, budget);

  // "The order does not exist" is an ANSWER, not a failure: it is the only
  // thing that proves KBZPay holds no order under this reference, which is
  // what lets a row become FAILED and releases the seat. Spec R13.
  //
  // Two codes carry that meaning and only QUERYORDER_FAIL is in KBZPay's error
  // table. AOP14505 is what the live gateway actually returns, and it appears
  // in the docs solely as an example headed "auth_code is expired /Customer
  // close the pin pad" — which reads like a customer mid-payment, so it was
  // deliberately left unmapped until KBZPay confirmed the semantics.
  //
  // They confirmed in writing on 2026-09-01: an order that has been created and
  // is still payable returns WAIT_PAY, and "Could not find the order." comes
  // back when the order was never created. Every other created-order state has
  // its own trade_status (PAYING, ORDER_EXPIRED, ORDER_CLOSED), so no live
  // order can hide behind either code.
  //
  // Nothing else belongs in this list. SYSTEM_ERROR, FLOW_CONTROL and friends
  // mean "we could not tell you", which is not the same as "there is nothing
  // there", and treating them as an answer would release a paid-for seat.
  if (!r.ok && (r.code === "QUERYORDER_FAIL" || r.code === "AOP14505")) {
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
export async function closeOrder(merchOrderId: string, budget?: CallBudget): Promise<{ ok: boolean }> {
  const r = await call("closeorder", "kbz.payment.closeorder", "3.0", {
    appid: APPID(),
    merch_code: MERCH_CODE(),
    merch_order_id: merchOrderId,
  }, {}, budget);

  if (r.ok) return { ok: true };
  if (r.code === "ORDER_ALREADY_CLOSED" || r.code === "QUERYORDER_FAIL") return { ok: true };
  return { ok: false };
}

// ── Export ─────────────────────────────────────────────────────────────────

const kbzpay = { precreate, queryOrder, closeOrder, sign, verifySign, buildMerchOrderId };
export default kbzpay;
