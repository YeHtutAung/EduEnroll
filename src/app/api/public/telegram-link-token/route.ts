import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import crypto from "crypto";

// ─── POST /api/public/telegram-link-token ────────────────────────────────────
// Generates a one-time token for secure Telegram deep linking.
// Input: { enrollment_ref }
// Returns: { deepLink, expiresIn } or error.

const TOKEN_EXPIRY_MINUTES = 15;

export async function POST(request: NextRequest) {
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

  // ── Find enrollment (enrollment_ref is globally unique) ───────
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, tenant_id, status, telegram_chat_id")
    .eq("enrollment_ref", enrollment_ref)
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
    return NextResponse.json({ error: "Enrollment not found." }, { status: 404 });
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

  // ── Fetch bot username from tenant ────────────────────────────
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("telegram_enabled, telegram_bot_username")
    .eq("id", enrollment.tenant_id)
    .single()) as {
    data: {
      telegram_enabled: boolean;
      telegram_bot_username: string | null;
    } | null;
    error: unknown;
  };

  if (!tenant?.telegram_enabled || !tenant.telegram_bot_username) {
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

  const deepLink = `https://t.me/${tenant.telegram_bot_username}?start=${token}`;

  return NextResponse.json({ deepLink, expiresIn: TOKEN_EXPIRY_MINUTES * 60 });
}
