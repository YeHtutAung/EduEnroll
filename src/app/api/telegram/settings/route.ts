import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken, decryptToken } from "@/lib/messenger/crypto";
import { getMe, setWebhook, deleteWebhook } from "@/lib/telegram/send";
import { randomUUID } from "crypto";

// ─── GET /api/telegram/settings ─────────────────────────────────────────────
// Returns current Telegram config (no token exposed).

export async function GET() {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  const supabase = createAdminClient();
  const { data } = (await supabase
    .from("tenants")
    .select("telegram_enabled, telegram_bot_username, telegram_webhook_secret")
    .eq("id", tenantId)
    .single()) as {
    data: {
      telegram_enabled: boolean;
      telegram_bot_username: string | null;
      telegram_webhook_secret: string | null;
    } | null;
    error: unknown;
  };

  return NextResponse.json({
    enabled: data?.telegram_enabled ?? false,
    botUsername: data?.telegram_bot_username ?? null,
    connected: !!data?.telegram_bot_username,
    webhookConfigured: !!data?.telegram_webhook_secret,
  });
}

// ─── PATCH /api/telegram/settings ───────────────────────────────────────────
// Connect/disconnect Telegram bot, toggle enabled.
// Body: { botToken?: string, enabled?: boolean, disconnect?: boolean }

export async function PATCH(request: NextRequest) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  let body: { botToken?: string; enabled?: boolean; disconnect?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── Disconnect ──────────────────────────────────────────
  if (body.disconnect) {
    // Try to delete webhook if token exists
    const { data: tenant } = (await supabase
      .from("tenants")
      .select("telegram_bot_token")
      .eq("id", tenantId)
      .single()) as { data: { telegram_bot_token: string | null } | null; error: unknown };

    if (tenant?.telegram_bot_token) {
      try {
        const token = decryptToken(tenant.telegram_bot_token);
        await deleteWebhook(token);
      } catch {
        // Ignore — token might be invalid
      }
    }

    await supabase
      .from("tenants")
      .update({
        telegram_enabled: false,
        telegram_bot_token: null,
        telegram_bot_username: null,
        telegram_webhook_secret: null,
      } as never)
      .eq("id", tenantId);

    return NextResponse.json({ success: true, message: "Telegram disconnected." });
  }

  // ── Connect with bot token ──────────────────────────────
  if (body.botToken) {
    // Validate token
    const me = await getMe(body.botToken);
    if (!me.ok || !me.result?.username) {
      return NextResponse.json(
        { error: "Invalid bot token. Please check and try again." },
        { status: 400 },
      );
    }

    const botUsername = me.result.username;
    const encryptedToken = encryptToken(body.botToken);
    const webhookSecret = randomUUID();

    // Build webhook URL
    const host = request.headers.get("host") ?? "localhost:3005";
    const proto = host.startsWith("localhost") ? "http" : "https";
    const webhookUrl = `${proto}://${host}/api/telegram/webhook/${webhookSecret}`;

    // Register webhook with Telegram
    const webhookResult = await setWebhook(body.botToken, webhookUrl);
    if (!webhookResult.ok) {
      return NextResponse.json(
        { error: `Failed to register webhook: ${webhookResult.description}` },
        { status: 502 },
      );
    }

    await supabase
      .from("tenants")
      .update({
        telegram_enabled: true,
        telegram_bot_token: encryptedToken,
        telegram_bot_username: botUsername,
        telegram_webhook_secret: webhookSecret,
      } as never)
      .eq("id", tenantId);

    return NextResponse.json({
      success: true,
      botUsername,
      message: `Connected to @${botUsername}`,
    });
  }

  // ── Toggle enabled ──────────────────────────────────────
  if (body.enabled !== undefined) {
    await supabase
      .from("tenants")
      .update({ telegram_enabled: body.enabled } as never)
      .eq("id", tenantId);

    return NextResponse.json({ success: true, enabled: body.enabled });
  }

  return NextResponse.json({ error: "No action specified." }, { status: 400 });
}
