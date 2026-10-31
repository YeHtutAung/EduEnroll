// ─── CB Bank QR Gateway (MMQR) client ───────────────────────────────────────
// Design: docs/superpowers/specs/2026-10-31-cb-mmqr-integration-design.md
// CB API: QR Gateway API Specification v1.0.10 (CB's PDF; not in the repo).
//
// Pure module: no Supabase, no Next.js imports. Mirrors src/lib/kbzpay.ts.

import { randomBytes, timingSafeEqual } from "crypto";
import { Agent, ProxyAgent } from "undici";

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
const OFFSET_PATTERN = /^[+-](0\d|1[0-4]):[0-5]\d$/;

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

// ── Mode and base URL ──────────────────────────────────────────────────────

/**
 * Same fail-closed rules as KBZPay's resolveMode(): an unrecognised value is
 * always an error, and on VERCEL_ENV=production only "production" is accepted.
 */
function resolveMode(): "production" | "uat" {
  const raw = (process.env.CBMMQR_MODE ?? "").trim().toLowerCase();
  if (raw === "production") return "production";
  if (process.env.VERCEL_ENV === "production") {
    throw new Error('CBMMQR_MODE must be "production" on a production deployment.');
  }
  if (raw !== "" && raw !== "uat") {
    throw new Error('CBMMQR_MODE is set to an unrecognised value — expected "production" or "uat".');
  }
  return "uat";
}

/**
 * CB will send the UAT and Live gateway URLs (spec §6). Production must be
 * https; UAT may be whatever CB gives us, since its scheme is not ours to pick.
 */
function baseUrl(): string {
  const mode = resolveMode();
  const raw = process.env.CBMMQR_BASE_URL?.trim();
  if (!raw) throw new Error("CBMMQR_BASE_URL is not set");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CBMMQR_BASE_URL is not a valid URL");
  }
  if (mode === "production" && parsed.protocol !== "https:") {
    throw new Error("CBMMQR_BASE_URL must use https in production");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("CBMMQR_BASE_URL must not have a query or fragment");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

// ── Egress and timeout (as src/lib/kbzpay.ts) ──────────────────────────────

// CB allowlists caller IPs (spec §3). CBMMQR_PROXY_URL routes ONLY this client
// through a fixed-IP host; unset means direct egress (UAT runs on the office
// IP). Per-request dispatcher, never setGlobalDispatcher().
const ipv4Agent = new Agent({ connect: { family: 4 } } as unknown as Agent.Options);
let cachedProxy: ProxyAgent | null | undefined;

function egressDispatcher(): ProxyAgent | Agent {
  if (cachedProxy === undefined) {
    const url = process.env.CBMMQR_PROXY_URL;
    if (url) {
      try {
        cachedProxy = new ProxyAgent(url);
      } catch {
        // undici's TypeError carries the whole URL, credentials included.
        throw new Error("CBMMQR_PROXY_URL is not a valid proxy URL");
      }
    } else {
      cachedProxy = null;
    }
  }
  return cachedProxy ?? ipv4Agent;
}

const CALL_TIMEOUT_MS = 20_000;
const MIN_CALL_MS = 1_000;

export type CallBudget = { deadlineMs: number };

function timeoutFor(budget: CallBudget | undefined, now: number): number | null {
  if (!budget) return CALL_TIMEOUT_MS;
  const remaining = budget.deadlineMs - now;
  if (remaining < MIN_CALL_MS) return null;
  return Math.min(CALL_TIMEOUT_MS, remaining);
}

type SendResult =
  | { ok: false }
  | { ok: true; status: number; code: string | null; body: Record<string, unknown> };

/**
 * One HTTP call. `ok: false` means we did not get a parseable answer. A non-2xx
 * with a JSON body is still an answer: CB may put a returnCode on a 400.
 * Bodies are never logged — the token request carries the password.
 */
async function send(
  label: string,
  method: "POST" | "PATCH",
  path: string,
  body: Record<string, unknown>,
  budget?: CallBudget,
): Promise<SendResult> {
  const timeout = timeoutFor(budget, Date.now());
  if (timeout === null) {
    console.error(`[cbmmqr] ${label} skipped: request budget exhausted`);
    return { ok: false };
  }

  // Outside the try: a configuration error must surface, not read as "CB down".
  const url = `${baseUrl()}${path}`;
  // Resolved here too: a bad CBMMQR_PROXY_URL is a configuration error, not "CB down".
  const dispatcher = egressDispatcher();

  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      dispatcher,
    } as RequestInit & { dispatcher?: ProxyAgent | Agent });

    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json || typeof json !== "object") {
      console.error(`[cbmmqr] ${label} HTTP ${res.status} without a JSON body`);
      return { ok: false };
    }
    const code = normaliseCode(json.returnCode);
    if (!res.ok && code === null) {
      console.error(`[cbmmqr] ${label} HTTP ${res.status}`);
      return { ok: false };
    }
    return { ok: true, status: res.status, code, body: json };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    console.error(
      `[cbmmqr] ${label} transport error${timedOut ? " (timeout — check IP allowlisting)" : ""}:`,
      err instanceof Error ? err.message : "unknown",
    );
    return { ok: false };
  }
}

// ── Token cache ────────────────────────────────────────────────────────────

/** Token codes: expired / invalid. Refresh and retry once. */
const TOKEN_CODES = new Set(["0012", "0017"]);
const TOKEN_EARLY_MS = 60_000;

const tokens = new Map<string, { token: string; expiresAtMs: number }>();
type TokenOutcome = { token: string } | { failCode: string | null };
const inflight = new Map<string, Promise<TokenOutcome>>();

export function __resetTokenCacheForTests(): void {
  tokens.clear();
  inflight.clear();
}

/**
 * The merchant's token, cached per instance until 60s before CB's expiry.
 * Concurrent callers share one request (single-flight). `failCode` is CB's
 * code when the token request was answered with a definite (non-5xx) failure.
 */
async function getToken(merchant: CbMerchant, budget: CallBudget | undefined, force: boolean): Promise<TokenOutcome> {
  const cached = tokens.get(merchant.id);
  if (!force && cached && cached.expiresAtMs - TOKEN_EARLY_MS > Date.now()) return { token: cached.token };

  // Joiners share the starter's budget.
  const pending = inflight.get(merchant.id);
  if (pending) return pending;

  const request = (async (): Promise<TokenOutcome> => {
    tokens.delete(merchant.id);
    const r = await send("auth/token", "POST", "/auth/token",
      { userId: merchant.userId, password: merchant.password }, budget);
    if (!r.ok || r.code !== CB_SUCCESS || typeof r.body.token !== "string" || !r.body.token) {
      console.error(`[cbmmqr] token request failed for ${merchant.id}: code=${r.ok ? r.code : "none"}`);
      return { failCode: r.ok && r.status < 500 ? r.code : null };
    }
    const expiresAtMs = parseCbTimestamp(r.body.expiredDateTime) ?? Date.now() + 5 * 60_000;
    tokens.set(merchant.id, { token: r.body.token, expiresAtMs });
    return { token: r.body.token };
  })();

  inflight.set(merchant.id, request);
  try {
    return await request;
  } finally {
    if (inflight.get(merchant.id) === request) inflight.delete(merchant.id);
  }
}

/** Runs `call` with a token; on a token code, refreshes once and retries once. */
async function withToken(
  merchant: CbMerchant,
  budget: CallBudget | undefined,
  call: (token: string) => Promise<SendResult>,
): Promise<SendResult | { tokenFailCode: string | null }> {
  const first = await getToken(merchant, budget, false);
  if (!("token" in first)) return { tokenFailCode: first.failCode };
  const r = await call(first.token);
  if (!r.ok || !TOKEN_CODES.has(r.code ?? "")) return r;

  const second = await getToken(merchant, budget, true);
  // CB already answered the first call, so a failed refresh is never a definite
  // rejection: it stays ambiguous.
  if (!("token" in second)) return { ok: false };
  return call(second.token);
}

// ── Create QR ──────────────────────────────────────────────────────────────

export type CreateQrParams = { referenceNo: string; amount: number; purpose: string };

export type CreateQrResult =
  | { kind: "created"; qr: string; qrReferenceNo: string; expiresAtMs: number | null }
  /** CB created nothing (spec §5.1 step 6): the row may be marked FAILED. */
  | { kind: "rejected"; reason: "below_minimum" | "above_maximum" | "config"; code: string }
  /** We cannot tell whether CB created a QR: the row stays PENDING (R13). */
  | { kind: "ambiguous"; code: string | null };

export async function createDynamicQr(
  merchant: CbMerchant,
  p: CreateQrParams,
  budget?: CallBudget,
): Promise<CreateQrResult> {
  const r = await withToken(merchant, budget, (token) =>
    send("dynamicqr", "POST", "/dynamicqr", {
      token,
      sourceId: merchant.sourceId,
      // CB's spec shows "104"; whether it wants a string or a number is a UAT check.
      transCurrency: "104",
      transAmount: p.amount,
      purposeOfTransaction: p.purpose.slice(0, 25),
      referenceNo: p.referenceNo,
      merchantId: merchant.merchantId,
      terminalId: merchant.terminalId,
    }, budget),
  );

  if ("tokenFailCode" in r) {
    // Only reached from the first token fetch, before any call to CB: no token
    // means CB was never asked to create anything.
    if (r.tokenFailCode === "0016" || r.tokenFailCode === "0021") {
      return { kind: "rejected", reason: "config", code: r.tokenFailCode };
    }
    return { kind: "ambiguous", code: null };
  }
  if (!r.ok) return { kind: "ambiguous", code: null };

  if (r.code === CB_SUCCESS) {
    const qr = r.body.qrCodeInfo;
    const qrRef = r.body.qrReferenceNo;
    if (typeof qr !== "string" || !qr || typeof qrRef !== "string" || !qrRef) {
      console.error(`[cbmmqr] dynamicqr 0000 without a QR or reference for ${p.referenceNo}`);
      return { kind: "ambiguous", code: r.code };
    }
    return { kind: "created", qr, qrReferenceNo: qrRef, expiresAtMs: parseCbTimestamp(r.body.qrExpiredDateTime) };
  }

  // A 5xx never counts as a definite rejection, whatever its body says.
  const reason = r.code && r.status < 500 ? CREATE_REJECTIONS[r.code] : undefined;
  if (reason) return { kind: "rejected", reason, code: r.code! };

  console.error(`[cbmmqr] dynamicqr returned ${r.code ?? "no code"} for ${p.referenceNo}; treating as ambiguous`);
  return { kind: "ambiguous", code: r.code };
}

// ── Status check ───────────────────────────────────────────────────────────

export type StatusResult =
  | { kind: "unreachable" }
  | {
      kind: "answer";
      code: string;
      referenceNo?: string;
      qrReferenceNo?: string;
      transactionId?: string;
      currency: "MMK" | null;
      amount: number | null;
      merchantId?: string;
      institutionName?: string;
    };

function parseAmount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}

/**
 * The settlement authority (spec §5.5). Its answer is only ever used together
 * with every field check in settleCbmmqrPayment(); a code alone means little,
 * since CB gives several codes two meanings.
 */
export async function checkStatus(
  merchant: CbMerchant,
  qrReferenceNo: string,
  budget?: CallBudget,
): Promise<StatusResult> {
  const r = await withToken(merchant, budget, (token) =>
    send("status", "PATCH", `/dynamicqr/${encodeURIComponent(qrReferenceNo)}/status`,
      { token, sourceId: merchant.sourceId }, budget),
  );

  if ("tokenFailCode" in r || !r.ok || r.code === null) return { kind: "unreachable" };

  const b = r.body;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

  const answer: StatusResult = {
    kind: "answer",
    code: r.code,
    currency: currencyFromCb(b.transCurrency),
    amount: parseAmount(b.transAmount),
  };
  if (str(b.referenceNo)) answer.referenceNo = str(b.referenceNo);
  if (str(b.qrReferenceNo)) answer.qrReferenceNo = str(b.qrReferenceNo);
  if (str(b.transactionId)) answer.transactionId = str(b.transactionId);
  if (str(b.merchantId)) answer.merchantId = str(b.merchantId);
  if (str(b.institutionName)) answer.institutionName = str(b.institutionName);
  return answer;
}
