import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processMessage } from "@/lib/telegram/processor";
import { decryptToken } from "@/lib/messenger/crypto";

// ─── POST /api/telegram/webhook/[secret] ────────────────────────────────────
// Receives updates from Telegram. The [secret] path segment identifies the tenant.

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
    from?: { id: number; first_name?: string; username?: string };
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ secret: string }> },
) {
  const { secret } = await params;

  const supabase = createAdminClient();

  // Look up tenant by webhook secret
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("id, telegram_bot_token, telegram_enabled")
    .eq("telegram_webhook_secret", secret)
    .eq("telegram_enabled", true)
    .single()) as {
    data: { id: string; telegram_bot_token: string | null; telegram_enabled: boolean } | null;
    error: unknown;
  };

  if (!tenant?.telegram_bot_token) {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  let botToken: string;
  try {
    botToken = decryptToken(tenant.telegram_bot_token);
  } catch {
    console.error("[telegram-webhook] Failed to decrypt bot token");
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  const message = update.message;
  if (!message?.chat?.id || !message.text) {
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  try {
    await processMessage(
      tenant.id,
      String(message.chat.id),
      message.text,
      botToken,
    );
  } catch (err) {
    console.error("[telegram-webhook] Error processing message:", err);
  }

  // Always return 200 — Telegram retries on non-200
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
