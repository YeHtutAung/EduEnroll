import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { sendEmail } from "@/lib/email";
import { verifyStandardWebhook } from "@/lib/auth/standardWebhook";
import { authEmailMessages, type AuthHookPayload } from "@/lib/auth/authEmailCopy";
import { CAPS, DEADLINE_MS, GROUP, emailKey, isAuthEmailType } from "@/lib/auth/authEmailLimits";
import { createTimedAdminClient } from "@/server/buyers/adminClient";

// ─── Supabase Send Email Hook ───────────────────────────────────────────────
//
// Supabase Auth calls this instead of sending its own email. It is signed
// (Standard Webhooks) with SUPABASE_SEND_EMAIL_HOOK_SECRET, so the raw body is
// read before anything parses it. Each recipient is capped per group through
// consume_rate_limit, keyed by an HMAC of the address. A non-2xx answer makes
// Auth fail the request, so: never answer 200 without sending, and an RPC error
// is 503, never "allowed".
//
// Deadline: GoTrue gives an HTTP hook 5 s per attempt and retries a transport
// timeout with a fresh webhook-id, which would send a second email. So the
// whole request gets DEADLINE_MS from arrival; past it we answer 503, and the
// Resend request is aborted. We never send a retry-after header, so GoTrue
// doesn't retry our 429 or 503 either.
//
// Logs carry the email type and fixed strings only: never a code, a token, a
// token_hash or an address.

export const dynamic = "force-dynamic";

type Fns = Database["public"]["Functions"];
type RateLimitResult = { data: Fns["consume_rate_limit"]["Returns"] | null; error: unknown };

const LOG = "[auth-send-email]";
const TIMED_OUT = Symbol("timed out");

function fail(http_code: number, message: string): NextResponse {
  return NextResponse.json({ error: { http_code, message } }, { status: http_code });
}

/** supabase-js can't infer RPC types from the hand-written Database type. */
async function consumeRateLimit(
  admin: SupabaseClient<Database>,
  args: Fns["consume_rate_limit"]["Args"],
): Promise<RateLimitResult> {
  return (await admin.rpc("consume_rate_limit" as never, args as never)) as unknown as RateLimitResult;
}

/** A short, fixed-alphabet version of the type for logs. */
function logType(t: unknown): string {
  return typeof t === "string" ? t.replace(/[^a-z_]/g, "").slice(0, 40) : "(none)";
}

/** Resolves to TIMED_OUT once the signal aborts, whichever comes first. */
function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof TIMED_OUT> {
  if (signal.aborted) return Promise.resolve(TIMED_OUT);
  return Promise.race([
    work,
    new Promise<typeof TIMED_OUT>((resolve) => signal.addEventListener("abort", () => resolve(TIMED_OUT), { once: true })),
  ]);
}

export async function POST(request: Request): Promise<NextResponse> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS);
  try {
    return await handle(request, deadline.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function handle(request: Request, signal: AbortSignal): Promise<NextResponse> {
  const body = await request.text();

  const hookSecret = process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET;
  if (!hookSecret) {
    console.error(`${LOG} SUPABASE_SEND_EMAIL_HOOK_SECRET not set`);
    return fail(503, "Hook not configured");
  }
  const signed = verifyStandardWebhook({
    secret: hookSecret,
    id: request.headers.get("webhook-id"),
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
    body,
  });
  if (!signed) {
    console.warn(`${LOG} bad signature`);
    return fail(401, "Invalid signature");
  }

  const rlSecret = process.env.RATE_LIMIT_HMAC_SECRET;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!rlSecret || !supabaseUrl) {
    console.error(`${LOG} RATE_LIMIT_HMAC_SECRET or NEXT_PUBLIC_SUPABASE_URL not set`);
    return fail(503, "Hook not configured");
  }

  let payload: AuthHookPayload;
  try {
    payload = JSON.parse(body) as AuthHookPayload;
  } catch {
    console.warn(`${LOG} body is not JSON`);
    return fail(400, "Invalid payload");
  }

  const type = payload?.email_data?.email_action_type;
  if (!isAuthEmailType(type)) {
    console.warn(`${LOG} unsupported type`, logType(type));
    return fail(400, "Unsupported email type");
  }

  const messages = authEmailMessages(payload, supabaseUrl);
  if (!messages) {
    console.warn(`${LOG} payload missing fields for type`, type);
    return fail(400, "Invalid payload");
  }

  // Every cap of every recipient at once: email_change's two addresses don't
  // wait on each other. All are settled before anything is sent, so one
  // address over its cap means no email to either.
  const group = GROUP[type];
  const admin = createTimedAdminClient();
  const checks = messages.flatMap((msg) => {
    const hex = emailKey(msg.to, rlSecret);
    return CAPS[group].map(([windowSeconds, limit, label]) =>
      consumeRateLimit(admin, {
        p_key: `authmail:${group}:${label}:${hex}`,
        p_window_seconds: windowSeconds,
        p_limit: limit,
      }).then(
        (r): "ok" | "refused" | "error" => (r.error || typeof r.data !== "boolean" ? "error" : r.data ? "ok" : "refused"),
        () => "error" as const,
      ),
    );
  });
  const outcomes = await beforeDeadline(Promise.all(checks), signal);
  if (outcomes === TIMED_OUT) {
    console.error(`${LOG} rate limit check timed out for type`, type);
    return fail(503, "Rate limit check timed out");
  }
  if (outcomes.includes("error")) {
    console.error(`${LOG} rate limit check failed for type`, type);
    return fail(503, "Rate limit check failed");
  }
  if (outcomes.includes("refused")) {
    console.warn(`${LOG} rate limited for type`, type);
    return fail(429, "Too many emails, try again later");
  }

  // A partial email_change send (one address ok, the other failed) answers
  // 500, and a retry (the user asking again) re-sends the first address's
  // email. Accepted: the alternative is answering success with one unsent.
  const sends = Promise.all(
    messages.map((msg) => sendEmail({ to: msg.to, subject: msg.subject, html: msg.html, signal })),
  );
  const sent = await beforeDeadline(sends, signal);
  if (sent === TIMED_OUT || (sent.includes(false) && signal.aborted)) {
    // The abort may land after Resend accepted the email, so it may still go out.
    console.error(`${LOG} send timed out for type`, type);
    return fail(503, "Email send timed out");
  }
  if (sent.includes(false)) {
    console.error(`${LOG} send failed for type`, type);
    return fail(500, "Email could not be sent");
  }

  return NextResponse.json({});
}
