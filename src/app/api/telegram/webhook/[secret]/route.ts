import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processMessage } from "@/lib/telegram/processor";
import {
  processLanguageSchoolMessage,
  processLanguageSchoolContact,
} from "@/lib/telegram/language-school-processor";
import { handleChatJoinRequest } from "@/lib/telegram/join-request-handler";
import { decryptToken } from "@/lib/telegram/crypto";

// ─── POST /api/telegram/webhook/[secret] ─────────────────────────────────────
// Enrollment bot webhook. The [secret] path segment identifies the tenant bot.

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

  // Look up enrollment bot by webhook_secret
  const { data: bot } = (await supabase
    .from("tenant_bots")
    .select("tenant_id, bot_token, enabled")
    .eq("webhook_secret", secret)
    .eq("bot_type", "enrollment")
    .eq("enabled", true)
    .single()) as {
    data: { tenant_id: string; bot_token: string | null; enabled: boolean } | null;
    error: unknown;
  };

  if (!bot?.bot_token) {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  // Get feature flags from tenant_telegram_configs
  const { data: config } = (await supabase
    .from("tenant_telegram_configs")
    .select("enable_join_requests, enable_phone_flow")
    .eq("tenant_id", bot.tenant_id)
    .single()) as {
    data: { enable_join_requests: boolean; enable_phone_flow: boolean } | null;
    error: unknown;
  };

  let botToken: string;
  try {
    botToken = decryptToken(bot.bot_token);
  } catch {
    console.error("[enrollment-webhook] Failed to decrypt bot token");
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  const enableJoinRequests = config?.enable_join_requests ?? false;
  const enablePhoneFlow = config?.enable_phone_flow ?? false;

  // ─── Handle chat_join_request ─────────────────────────────────────────────
  if (enableJoinRequests && update.chat_join_request) {
    try {
      await handleChatJoinRequest(bot.tenant_id, update.chat_join_request, botToken);
    } catch (err) {
      console.error("[enrollment-webhook] Error handling join request:", err);
    }
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  // ─── Handle message ───────────────────────────────────────────────────────
  const message = update.message;
  if (!message?.chat?.id) {
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  const chatId = String(message.chat.id);

  try {
    if (enablePhoneFlow && message.contact) {
      await processLanguageSchoolContact(bot.tenant_id, chatId, message.contact, botToken);
    } else if (enablePhoneFlow && message.text) {
      await processLanguageSchoolMessage(bot.tenant_id, chatId, message.text, botToken);
    } else if (message.text) {
      await processMessage(bot.tenant_id, chatId, message.text, botToken);
    }
  } catch (err) {
    console.error("[enrollment-webhook] Error processing message:", err);
  }

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
