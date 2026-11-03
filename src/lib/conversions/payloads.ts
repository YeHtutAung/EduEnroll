// ─── Purchase event payloads: pure rules ────────────────────────────────────
//
// Each builder copies named fields only, so buyer data cannot reach a payload by
// accident. No name or order ref at all, and email, phone and country only hashed
// and only to Meta: the owner's decisions, 2026-11-03 and 2026-11-04. See
// docs/superpowers/specs/2026-11-02-purchase-conversion-design.md.

import { createHash } from "node:crypto";

export type ConversionPlatform = "meta" | "tiktok";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Meta's format: trimmed and lowercase before hashing. Null if not an address. */
export function hashEmail(raw: string | null | undefined): string | null {
  const email = raw?.trim().toLowerCase();
  return email && /^[^@\s]+@[^@\s]+$/.test(email) ? sha256(email) : null;
}

/**
 * Meta's format: digits only, with the country code, before hashing. A national
 * number is taken as Myanmar's, which is what the order form asks for by default.
 * Null if it can't be a phone number.
 */
export function hashPhone(raw: string | null | undefined): string | null {
  const digits = phoneDigits(raw);
  return digits ? sha256(digits) : null;
}

function phoneDigits(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  let digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (!trimmed.startsWith("+") && digits.startsWith("0")) digits = `95${digits.slice(1)}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/**
 * The hash of "mm" for a Myanmar phone number, and null for anything else: the
 * order holds no country, and a wrong one is worse than none. Owner's decision,
 * 2026-11-04.
 */
export function hashCountryFromPhone(raw: string | null | undefined): string | null {
  return phoneDigits(raw)?.startsWith("95") ? sha256("mm") : null;
}

export interface PurchaseEvent {
  hashedEmail: string | null;
  hashedPhone: string | null;
  hashedCountry: string | null;
  eventId: string;
  occurredAt: string;
  value: number;
  currency: string;
  sourceUrl: string;
  clientIp: string | null;
  userAgent: string | null;
  fbp: string | null;
  fbc: string | null;
  ttp: string | null;
  ttclid: string | null;
}

export interface PlatformRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const META_API_VERSION = "v26.0";
const TIKTOK_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const TIKTOK_EVENT = "Purchase";

// These stay pending, so a replaced token or a passing limit recovers within the
// 7-day window. Meta's 200-299 permission range is handled in classifyResponse.
const META_RETRY_CODES = new Set([1, 2, 4, 10, 17, 102, 190, 341, 613, 80004]);
const TIKTOK_RETRY_CODES = new Set([
  40100, 40016, 40132, 40133, // rate limit
  40101, 40102, 40104, 40105, 40106, // auth
  40001, 40118, 40125, // permission
]);

const eventTime = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

export function buildMetaRequest(args: {
  pixelId: string;
  token: string;
  testCode: string | null;
  event: PurchaseEvent;
}): PlatformRequest {
  const { event } = args;
  return {
    url: `https://graph.facebook.com/${META_API_VERSION}/${encodeURIComponent(args.pixelId)}/events`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: args.token,
      ...(args.testCode ? { test_event_code: args.testCode } : {}),
      data: [
        {
          event_name: "Purchase",
          event_time: eventTime(event.occurredAt),
          event_id: event.eventId,
          action_source: "website",
          event_source_url: event.sourceUrl,
          user_data: {
            client_ip_address: event.clientIp ?? undefined,
            client_user_agent: event.userAgent ?? undefined,
            fbp: event.fbp ?? undefined,
            fbc: event.fbc ?? undefined,
            em: event.hashedEmail ? [event.hashedEmail] : undefined,
            ph: event.hashedPhone ? [event.hashedPhone] : undefined,
            country: event.hashedCountry ? [event.hashedCountry] : undefined,
          },
          custom_data: { value: event.value, currency: event.currency },
        },
      ],
    }),
  };
}

export function buildTiktokRequest(args: {
  pixelCode: string;
  token: string;
  testCode: string | null;
  event: PurchaseEvent;
}): PlatformRequest {
  const { event } = args;
  return {
    url: TIKTOK_URL,
    headers: { "Content-Type": "application/json", "Access-Token": args.token },
    body: JSON.stringify({
      event_source: "web",
      event_source_id: args.pixelCode,
      ...(args.testCode ? { test_event_code: args.testCode } : {}),
      data: [
        {
          event: TIKTOK_EVENT,
          event_time: eventTime(event.occurredAt),
          event_id: event.eventId,
          user: {
            ttclid: event.ttclid ?? undefined,
            ttp: event.ttp ?? undefined,
            ip: event.clientIp ?? undefined,
            user_agent: event.userAgent ?? undefined,
          },
          page: { url: event.sourceUrl },
          properties: { value: event.value, currency: event.currency },
        },
      ],
    }),
  };
}

/** For logs: the names of the buyer fields a request carries. Never their values. */
export function describeRequest(request: PlatformRequest): string {
  const body = JSON.parse(request.body) as {
    test_event_code?: string;
    data: { user_data?: object; user?: object }[];
  };
  const fields = Object.keys(body.data[0].user_data ?? body.data[0].user ?? {});
  return `fields=${fields.join(",")} test_code=${body.test_event_code ? "yes" : "no"}`;
}

export interface SendOutcome {
  status: "sent" | "pending" | "failed";
  /** A status or platform code only. Never a response body. */
  code: string | null;
}

// With no code to read, these statuses are about the caller or the moment, not
// the event, so they recover: auth, timeout, rate limit, and any server error.
const isRetryableStatus = (httpStatus: number) =>
  httpStatus >= 500 || httpStatus === 401 || httpStatus === 403 || httpStatus === 408 || httpStatus === 429;

export function classifyResponse(platform: ConversionPlatform, httpStatus: number, body: unknown): SendOutcome {
  const b = (typeof body === "object" && body !== null ? body : {}) as {
    code?: unknown;
    error?: { code?: unknown; error_subcode?: unknown };
  };
  const noCode: SendOutcome = {
    status: isRetryableStatus(httpStatus) ? "pending" : "failed",
    code: `http_${httpStatus}`,
  };

  if (platform === "tiktok") {
    // Judged by the body code first. TikTok's docs conflict on HTTP status, and
    // its rate limit can arrive as a 401. A 2xx with no code is never "sent".
    if (typeof b.code === "number") {
      if (b.code === 0) return { status: "sent", code: null };
      const retry = TIKTOK_RETRY_CODES.has(b.code) || b.code >= 50000;
      return { status: retry ? "pending" : "failed", code: `tiktok_${b.code}` };
    }
    return noCode;
  }

  if (httpStatus >= 200 && httpStatus < 300 && !b.error) return { status: "sent", code: null };
  const code = typeof b.error?.code === "number" ? b.error.code : null;
  if (code === null) return noCode;
  // Code 100 / subcode 33: the token cannot see the pixel. A setup mistake the
  // owner can fix, so it stays pending. Plain 100 is a bad request and fails.
  if (code === 100 && b.error?.error_subcode === 33) return { status: "pending", code: "meta_100_33" };
  const retry = META_RETRY_CODES.has(code) || (code >= 200 && code <= 299);
  return { status: retry ? "pending" : "failed", code: `meta_${code}` };
}
