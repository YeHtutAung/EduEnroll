import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken, decryptToken } from "@/lib/telegram/crypto";
import { getMe, setWebhook, deleteWebhook } from "@/lib/telegram/send";
import { randomUUID } from "crypto";
import type { BotType } from "@/types/database";

// ─── GET /api/telegram/settings ──────────────────────────────────────────────
// Returns config for both enrollment and support bots.

export async function GET() {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  const supabase = createAdminClient();

  const { data: bots } = (await supabase
    .from("tenant_bots")
    .select("bot_type, bot_username, enabled, webhook_secret")
    .eq("tenant_id", tenantId)) as {
    data: {
      bot_type: BotType;
      bot_username: string | null;
      enabled: boolean;
      webhook_secret: string | null;
    }[] | null;
    error: unknown;
  };

  const { data: tenant } = (await supabase
    .from("tenants")
    .select("telegram_auto_send_invite")
    .eq("id", tenantId)
    .single()) as {
    data: { telegram_auto_send_invite: boolean } | null;
    error: unknown;
  };

  const enrollment = bots?.find((b) => b.bot_type === "enrollment");
  const support = bots?.find((b) => b.bot_type === "support");

  return NextResponse.json({
    enrollment: {
      connected: !!enrollment?.bot_username,
      enabled: enrollment?.enabled ?? false,
      botUsername: enrollment?.bot_username ?? null,
      webhookConfigured: !!enrollment?.webhook_secret,
    },
    support: {
      connected: !!support?.bot_username,
      enabled: support?.enabled ?? false,
      botUsername: support?.bot_username ?? null,
    },
    autoSendInvite: tenant?.telegram_auto_send_invite ?? false,
  });
}

// ─── PATCH /api/telegram/settings ────────────────────────────────────────────
// Connect/disconnect/toggle a bot. botType identifies which bot.
// Body: { botType: "enrollment" | "support", botToken?, enabled?, disconnect?, autoSendInvite? }

export async function PATCH(request: NextRequest) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  let body: {
    botType?: BotType;
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

  // ── Toggle autoSendInvite (tenant-level, no botType needed) ────────────────
  if (body.autoSendInvite !== undefined) {
    await supabase
      .from("tenants")
      .update({ telegram_auto_send_invite: body.autoSendInvite } as never)
      .eq("id", tenantId);
    return NextResponse.json({ success: true, autoSendInvite: body.autoSendInvite });
  }

  const botType = body.botType;
  if (!botType || !["enrollment", "support"].includes(botType)) {
    return NextResponse.json({ error: "botType must be 'enrollment' or 'support'." }, { status: 400 });
  }

  // ── Disconnect ─────────────────────────────────────────────────────────────
  if (body.disconnect) {
    const { data: bot } = (await supabase
      .from("tenant_bots")
      .select("bot_token")
      .eq("tenant_id", tenantId)
      .eq("bot_type", botType)
      .single()) as { data: { bot_token: string | null } | null; error: unknown };

    if (bot?.bot_token) {
      try {
        await deleteWebhook(decryptToken(bot.bot_token));
      } catch {
        // Ignore — token may already be invalid
      }
    }

    await supabase
      .from("tenant_bots")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("bot_type", botType);

    return NextResponse.json({ success: true, message: `${botType} bot disconnected.` });
  }

  // ── Connect with bot token ─────────────────────────────────────────────────
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

    let webhookSecret: string | undefined;

    const host = request.headers.get("host") ?? "localhost:3005";
    const proto = host.startsWith("localhost") ? "http" : "https";

    if (botType === "enrollment") {
      // Enrollment bot: identified by UUID secret in the URL path
      webhookSecret = randomUUID();
      const webhookUrl = `${proto}://${host}/api/telegram/webhook/${webhookSecret}`;

      const webhookResult = await setWebhook(body.botToken, webhookUrl);
      if (!webhookResult.ok) {
        return NextResponse.json(
          { error: `Failed to register webhook: ${webhookResult.description}` },
          { status: 502 },
        );
      }
    } else if (botType === "support") {
      // Support bot: identified by X-Telegram-Bot-Api-Secret-Token header
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (!secret) {
        return NextResponse.json(
          { error: "TELEGRAM_WEBHOOK_SECRET is not configured on the server." },
          { status: 500 },
        );
      }

      const webhookUrl = `${proto}://${host}/api/webhooks/telegram`;
      const webhookResult = await setWebhook(body.botToken, webhookUrl, secret);
      if (!webhookResult.ok) {
        return NextResponse.json(
          { error: `Failed to register webhook: ${webhookResult.description}` },
          { status: 502 },
        );
      }
    }

    await supabase
      .from("tenant_bots")
      .upsert({
        tenant_id: tenantId,
        bot_type: botType,
        enabled: true,
        bot_token: encryptedToken,
        bot_username: botUsername,
        ...(webhookSecret ? { webhook_secret: webhookSecret } : {}),
      } as never);

    return NextResponse.json({
      success: true,
      botUsername,
      message: `Connected to @${botUsername}`,
    });
  }

  // ── Toggle enabled ─────────────────────────────────────────────────────────
  if (body.enabled !== undefined) {
    await supabase
      .from("tenant_bots")
      .update({ enabled: body.enabled } as never)
      .eq("tenant_id", tenantId)
      .eq("bot_type", botType);

    return NextResponse.json({ success: true, enabled: body.enabled });
  }

  return NextResponse.json({ error: "No action specified." }, { status: 400 });
}
