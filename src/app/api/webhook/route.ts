import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/telegram/crypto";
import { extractSubdomainFromHost } from "@/lib/tenant";
import { askAgent } from "@/lib/agent-client";
import { sendTelegramMessage } from "@/lib/telegram";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
    from?: { id: number; first_name?: string; username?: string };
  };
}

// ─── GET /api/webhook ─────────────────────────────────────────────────────────
// Telegram webhook verification ping.

export async function GET() {
  return NextResponse.json({ ok: true });
}

// ─── POST /api/webhook ────────────────────────────────────────────────────────
// Receives Telegram updates. Always returns 200 — Telegram retries on non-200.

export async function POST(request: NextRequest) {
  // ── 1. Verify webhook secret header ────────────────────────────────────────
  const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!expectedSecret || secretHeader !== expectedSecret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── 2. Resolve tenant slug from subdomain ──────────────────────────────────
  const host = request.headers.get("host") ?? "";
  const tenantSlug =
    request.headers.get("x-tenant-slug") ?? extractSubdomainFromHost(host);

  if (!tenantSlug) {
    console.warn("[webhook] Could not resolve tenant slug from host:", host);
    return NextResponse.json({ ok: true });
  }

  // ── 3. Look up tenant + telegram config ────────────────────────────────────
  const supabase = createAdminClient();

  const { data: tenant } = (await supabase
    .from("tenants")
    .select("id, subdomain")
    .eq("subdomain", tenantSlug)
    .single()) as {
    data: { id: string; subdomain: string } | null;
    error: unknown;
  };

  if (!tenant) {
    console.warn("[webhook] Tenant not found:", tenantSlug);
    return NextResponse.json({ ok: true });
  }

  const { data: config } = (await supabase
    .from("tenant_telegram_configs")
    .select("bot_token, allowed_chat_ids, enabled")
    .eq("tenant_id", tenant.id)
    .eq("enabled", true)
    .single()) as {
    data: {
      bot_token: string | null;
      allowed_chat_ids: number[] | null;
      enabled: boolean;
    } | null;
    error: unknown;
  };

  if (!config?.bot_token) {
    console.warn("[webhook] Telegram not configured or disabled for tenant:", tenantSlug);
    return NextResponse.json({ ok: true });
  }

  let botToken: string;
  try {
    botToken = decryptToken(config.bot_token);
  } catch (err) {
    console.error("[webhook] Failed to decrypt bot token for tenant:", tenantSlug, err);
    return NextResponse.json({ ok: true });
  }

  // ── 4. Parse Telegram update ───────────────────────────────────────────────
  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message?.chat?.id || !message.text) {
    return NextResponse.json({ ok: true });
  }

  const chatId = message.chat.id;
  const text = message.text.trim();
  const from = message.from;

  // ── 5. Handle /start ───────────────────────────────────────────────────────
  if (text === "/start") {
    const allowed = (config.allowed_chat_ids ?? []).map(Number);

    // Already approved
    if (allowed.includes(chatId)) {
      await sendTelegramMessage(chatId, "✅ You already have access. Just send me a message!", botToken);
      return NextResponse.json({ ok: true });
    }

    const name = from?.first_name ?? "User";
    const username = from?.username ?? null;

    // Upsert request — UNIQUE(tenant_id, chat_id) handles duplicates
    const { error } = await supabase
      .from("telegram_admin_requests")
      .upsert(
        { tenant_id: tenant.id, chat_id: chatId, name, username, status: "pending" } as never,
        { onConflict: "tenant_id,chat_id", ignoreDuplicates: false },
      );

    if (error) {
      // Already has an existing request (pending or otherwise)
      await sendTelegramMessage(
        chatId,
        "⏳ Your request is already pending. Please wait for admin approval.",
        botToken,
      );
    } else {
      await sendTelegramMessage(
        chatId,
        "📩 Your access request has been sent to the admin. You'll be notified once approved.",
        botToken,
      );
    }

    return NextResponse.json({ ok: true });
  }

  // ── 6. Check allowed_chat_ids whitelist ────────────────────────────────────
  const allowed = (config.allowed_chat_ids ?? []).map(Number);
  if (!allowed.includes(chatId)) {
    // Not authorised — acknowledge silently, never 403
    return NextResponse.json({ ok: true });
  }

  // ── 7. Forward to agent + send reply ──────────────────────────────────────
  try {
    const reply = await askAgent(text, String(chatId), tenant.subdomain);
    await sendTelegramMessage(chatId, reply, botToken);
  } catch (err) {
    console.error("[webhook] Error processing message for tenant:", tenantSlug, err);
    await sendTelegramMessage(chatId, "Sorry, something went wrong. Please try again.", botToken);
  }

  return NextResponse.json({ ok: true });
}
