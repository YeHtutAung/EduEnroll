import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processMessage } from "@/lib/telegram/processor";
import {
  processLanguageSchoolMessage,
  processLanguageSchoolContact,
} from "@/lib/telegram/language-school-processor";
import { handleChatJoinRequest } from "@/lib/telegram/join-request-handler";
import { decryptToken } from "@/lib/telegram/crypto";

// ─── POST /api/telegram/webhook/[secret] ────────────────────────────────────
// Receives updates from Telegram. The [secret] path segment identifies the tenant.

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
    from?: { id: number; first_name?: string; username?: string };
    contact?: {
      phone_number: string;
      first_name?: string;
      user_id?: number;
    };
  };
  chat_join_request?: {
    chat: { id: number; title?: string };
    from: { id: number; first_name?: string; username?: string };
    date: number;
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ secret: string }> },
) {
  const { secret } = await params;

  const supabase = createAdminClient();

  // Look up telegram config by webhook secret, then join tenant for org_type
  const { data: config } = (await supabase
    .from("tenant_telegram_configs")
    .select("tenant_id, bot_token, enabled, enable_join_requests, enable_phone_flow")
    .eq("webhook_secret", secret)
    .eq("enabled", true)
    .single()) as {
    data: {
      tenant_id: string;
      bot_token: string | null;
      enabled: boolean;
      enable_join_requests: boolean;
      enable_phone_flow: boolean;
    } | null;
    error: unknown;
  };

  if (!config?.bot_token) {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const { data: tenant } = (await supabase
    .from("tenants")
    .select("id")
    .eq("id", config.tenant_id)
    .single()) as {
    data: { id: string } | null;
    error: unknown;
  };

  if (!tenant) {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  let botToken: string;
  try {
    botToken = decryptToken(config.bot_token);
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

  // ─── Handle chat_join_request ────────────────────────────────────────────
  if (config.enable_join_requests && update.chat_join_request) {
    try {
      await handleChatJoinRequest(tenant.id, update.chat_join_request, botToken);
    } catch (err) {
      console.error("[telegram-webhook] Error handling join request:", err);
    }
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  // ─── Handle message ────────────────────────────────────────────────────
  const message = update.message;
  if (!message?.chat?.id) {
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  const chatId = String(message.chat.id);

  try {
    if (config.enable_phone_flow && message.contact) {
      await processLanguageSchoolContact(tenant.id, chatId, message.contact, botToken);
    } else if (config.enable_phone_flow && message.text) {
      await processLanguageSchoolMessage(tenant.id, chatId, message.text, botToken);
    } else if (message.text) {
      await processMessage(tenant.id, chatId, message.text, botToken);
    }
  } catch (err) {
    console.error("[telegram-webhook] Error processing message:", err);
  }

  // Always return 200 — Telegram retries on non-200
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
