import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { sendEmail } from "@/lib/email";
import { verifyStandardWebhook } from "@/lib/auth/standardWebhook";
import { authEmailMessages, type AuthHookPayload } from "@/lib/auth/authEmailCopy";
import { CAPS, GROUP, emailKey, isAuthEmailType } from "@/lib/auth/authEmailLimits";
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
// Logs carry the email type and fixed strings only: never a code, a token, a
// token_hash or an address.

export const dynamic = "force-dynamic";

type Fns = Database["public"]["Functions"];

const LOG = "[auth-send-email]";

function fail(http_code: number, message: string): NextResponse {
  return NextResponse.json({ error: { http_code, message } }, { status: http_code });
}

/** supabase-js can't infer RPC types from the hand-written Database type. */
async function consumeRateLimit(
  admin: SupabaseClient<Database>,
  args: Fns["consume_rate_limit"]["Args"],
): Promise<{ data: Fns["consume_rate_limit"]["Returns"] | null; error: unknown }> {
  return (await admin.rpc("consume_rate_limit" as never, args as never)) as unknown as {
    data: Fns["consume_rate_limit"]["Returns"] | null;
    error: unknown;
  };
}

/** A short, fixed-alphabet version of the type for logs. */
function logType(t: unknown): string {
  return typeof t === "string" ? t.replace(/[^a-z_]/g, "").slice(0, 40) : "(none)";
}

export async function POST(request: Request): Promise<NextResponse> {
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
  if (!rlSecret) {
    console.error(`${LOG} RATE_LIMIT_HMAC_SECRET not set`);
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

  const messages = authEmailMessages(payload, process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (!messages) {
    console.warn(`${LOG} payload missing fields for type`, type);
    return fail(400, "Invalid payload");
  }

  const group = GROUP[type];
  const admin = createTimedAdminClient();
  for (const msg of messages) {
    const hex = emailKey(msg.to, rlSecret);
    for (const [windowSeconds, limit, label] of CAPS[group]) {
      let result: Awaited<ReturnType<typeof consumeRateLimit>>;
      try {
        result = await consumeRateLimit(admin, {
          p_key: `authmail:${group}:${label}:${hex}`,
          p_window_seconds: windowSeconds,
          p_limit: limit,
        });
      } catch {
        console.error(`${LOG} rate limit check threw for type`, type);
        return fail(503, "Rate limit check failed");
      }
      if (result.error || typeof result.data !== "boolean") {
        console.error(`${LOG} rate limit check failed for type`, type);
        return fail(503, "Rate limit check failed");
      }
      if (!result.data) {
        console.warn(`${LOG} rate limited for type`, type, label);
        return fail(429, "Too many emails, try again later");
      }
    }
  }

  for (const msg of messages) {
    const sent = await sendEmail({ to: msg.to, subject: msg.subject, html: msg.html });
    if (!sent) {
      console.error(`${LOG} send failed for type`, type);
      return fail(500, "Email could not be sent");
    }
  }

  return NextResponse.json({});
}
