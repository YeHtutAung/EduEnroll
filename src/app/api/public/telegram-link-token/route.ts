import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { clientIpFrom, publicEnrollmentLookupLimiter } from "@/lib/rateLimit";
import crypto from "crypto";

// ─── POST /api/public/telegram-link-token ────────────────────────────────────
// Generates a one-time token for secure Telegram deep linking.
// Input: { enrollment_ref }
// Returns: { deepLink, expiresIn } or error.
//
// The reference is the only credential, so the lookup is scoped to the tenant
// the request arrived on, and failed lookups spend the shared per-address
// enrollment-lookup budget, the same one as the status and enrollment routes.

const TOKEN_EXPIRY_MINUTES = 15;

const NO_STORE = { "Cache-Control": "no-store" };

function throttled(clientIp: string) {
  return NextResponse.json(
    // `error` is the text the payment page shows.
    { error: "Too many failed lookups. Try again later." },
    {
      status: 429,
      headers: { ...NO_STORE, "Retry-After": String(publicEnrollmentLookupLimiter.retryAfter(clientIp)) },
    },
  );
}

export async function POST(request: NextRequest) {
  const clientIp = clientIpFrom(request.headers);
  if (publicEnrollmentLookupLimiter.isBlocked(clientIp)) {
    return throttled(clientIp);
  }

  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  let body: { enrollment_ref?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request" }, { status: 400 });
  }

  const { enrollment_ref } = body;
  if (!enrollment_ref) {
    return NextResponse.json(
      { error: "enrollment_ref is required." },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // ── Find enrollment on this tenant only ─────────────────────────
  const { data: enrollment, error: lookupError } = (await supabase
    .from("enrollments")
    .select("id, tenant_id, status, telegram_chat_id")
    .eq("enrollment_ref", String(enrollment_ref).trim())
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      id: string;
      tenant_id: string;
      status: string;
      telegram_chat_id: string | null;
    } | null;
    error: unknown;
  };

  if (!enrollment) {
    // A database fault is not a miss, or an outage would spend the budget of
    // callers whose references are valid. PGRST116 is .single()'s "no rows".
    const code = (lookupError as { code?: string } | null)?.code;
    if (!lookupError || code === "PGRST116") {
      publicEnrollmentLookupLimiter.recordMiss(clientIp);
    } else {
      console.error("[telegram-link-token] enrollment lookup failed, not counted as a miss:", code ?? "unknown");
    }
    // Same answer whether the reference is absent or belongs to another tenant.
    return NextResponse.json({ error: "Enrollment not found." }, { status: 404, headers: NO_STORE });
  }

  // Block if payment not yet submitted
  if (enrollment.status === "pending_payment") {
    return NextResponse.json(
      { error: "Please submit payment before connecting Telegram." },
      { status: 400 },
    );
  }

  // Block if already linked
  if (enrollment.telegram_chat_id) {
    return NextResponse.json(
      { error: "Telegram is already connected for this enrollment." },
      { status: 400 },
    );
  }

  // ── Fetch the enrollment bot's username from tenant_bots ───────
  const { data: enrollmentBot, error: botError } = (await supabase
    .from("tenant_bots")
    .select("enabled, bot_username")
    .eq("tenant_id", enrollment.tenant_id)
    .eq("bot_type", "enrollment")
    .maybeSingle()) as {
    data: {
      enabled: boolean;
      bot_username: string | null;
    } | null;
    error: unknown;
  };

  if (botError) {
    console.error("[telegram-link-token] enrollment bot lookup failed for", enrollment.tenant_id, botError);
  }

  if (!enrollmentBot?.enabled || !enrollmentBot.bot_username) {
    return NextResponse.json(
      { error: "Telegram is not configured for this school." },
      { status: 400 },
    );
  }

  // ── Generate token and save ───────────────────────────────────
  const token = crypto.randomBytes(18).toString("base64url"); // 24 chars, URL-safe
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000).toISOString();

  await supabase
    .from("enrollments")
    .update({
      telegram_link_token: token,
      telegram_link_token_expires_at: expiresAt,
    } as never)
    .eq("id", enrollment.id);

  const deepLink = `https://t.me/${enrollmentBot.bot_username}?start=${token}`;

  return NextResponse.json({ deepLink, expiresIn: TOKEN_EXPIRY_MINUTES * 60 }, { headers: NO_STORE });
}
