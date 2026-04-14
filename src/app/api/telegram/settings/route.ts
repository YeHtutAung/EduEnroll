import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken, decryptToken } from "@/lib/telegram/crypto";
import { getMe, setWebhook, deleteWebhook } from "@/lib/telegram/send";
import { randomUUID } from "crypto";

// ─── GET /api/telegram/settings ─────────────────────────────────────────────
// Returns current Telegram config (bot token is never exposed).

export async function GET() {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  const supabase = createAdminClient();

  const { data: config } = (await supabase
    .from("tenant_telegram_configs")
    .select("enabled, bot_username, webhook_secret")
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      enabled: boolean;
      bot_username: string | null;
      webhook_secret: string | null;
    } | null;
    error: unknown;
  };

  // autoSendInvite stays on tenants
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("telegram_auto_send_invite")
    .eq("id", tenantId)
    .single()) as {
    data: { telegram_auto_send_invite: boolean } | null;
    error: unknown;
  };

  return NextResponse.json({
    enabled: config?.enabled ?? false,
    botUsername: config?.bot_username ?? null,
    connected: !!config?.bot_username,
    webhookConfigured: !!config?.webhook_secret,
    autoSendInvite: tenant?.telegram_auto_send_invite ?? false,
  });
}

// ─── PATCH /api/telegram/settings ───────────────────────────────────────────
// Connect/disconnect Telegram bot, toggle enabled / autoSendInvite.
// Body: { botToken?: string, enabled?: boolean, disconnect?: boolean, autoSendInvite?: boolean }

export async function PATCH(request: NextRequest) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  let body: {
    botToken?: string;
    enabled?: boolean;
    disconnect?: boolean;
    autoSendInvite?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // ── Disconnect ──────────────────────────────────────────────────────────────
  if (body.disconnect) {
    const { data: config } = (await supabase
      .from("tenant_telegram_configs")
      .select("bot_token")
      .eq("tenant_id", tenantId)
      .single()) as { data: { bot_token: string | null } | null; error: unknown };

    if (config?.bot_token) {
      try {
        await deleteWebhook(decryptToken(config.bot_token));
      } catch {
        // Ignore — token may already be invalid
      }
    }

    await supabase
      .from("tenant_telegram_configs")
      .update({
        enabled: false,
        bot_token: null,
        bot_username: null,
        webhook_secret: null,
      } as never)
      .eq("tenant_id", tenantId);

    return NextResponse.json({ success: true, message: "Telegram disconnected." });
  }

  // ── Connect with bot token ──────────────────────────────────────────────────
  if (body.botToken) {
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

    const host = request.headers.get("host") ?? "localhost:3005";
    const proto = host.startsWith("localhost") ? "http" : "https";
    const webhookUrl = `${proto}://${host}/api/telegram/webhook/${webhookSecret}`;

    const webhookResult = await setWebhook(body.botToken, webhookUrl);
    if (!webhookResult.ok) {
      return NextResponse.json(
        { error: `Failed to register webhook: ${webhookResult.description}` },
        { status: 502 },
      );
    }

    await supabase
      .from("tenant_telegram_configs")
      .upsert({
        tenant_id: tenantId,
        enabled: true,
        bot_token: encryptedToken,
        bot_username: botUsername,
        webhook_secret: webhookSecret,
      } as never);

    return NextResponse.json({
      success: true,
      botUsername,
      message: `Connected to @${botUsername}`,
    });
  }

  // ── Toggle enabled ──────────────────────────────────────────────────────────
  if (body.enabled !== undefined) {
    await supabase
      .from("tenant_telegram_configs")
      .update({ enabled: body.enabled } as never)
      .eq("tenant_id", tenantId);

    return NextResponse.json({ success: true, enabled: body.enabled });
  }

  // ── Toggle autoSendInvite (stays on tenants) ────────────────────────────────
  if (body.autoSendInvite !== undefined) {
    await supabase
      .from("tenants")
      .update({ telegram_auto_send_invite: body.autoSendInvite } as never)
      .eq("id", tenantId);

    return NextResponse.json({ success: true, autoSendInvite: body.autoSendInvite });
  }

  return NextResponse.json({ error: "No action specified." }, { status: 400 });
}
