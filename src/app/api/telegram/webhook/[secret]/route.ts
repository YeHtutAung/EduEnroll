import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processMessage } from "@/lib/telegram/processor";
import {
  processLanguageSchoolMessage,
  processLanguageSchoolContact,
} from "@/lib/telegram/language-school-processor";
import { handleChatJoinRequest } from "@/lib/telegram/join-request-handler";
import { decryptToken } from "@/lib/messenger/crypto";

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

  // Look up tenant by webhook secret
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("id, telegram_bot_token, telegram_enabled, org_type")
    .eq("telegram_webhook_secret", secret)
    .eq("telegram_enabled", true)
    .single()) as {
    data: {
      id: string;
      telegram_bot_token: string | null;
      telegram_enabled: boolean;
      org_type: string;
    } | null;
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

  const isLanguageSchool = tenant.org_type === "language_school";

  // ─── Handle chat_join_request (language_school only) ─────────────────────
  if (isLanguageSchool && update.chat_join_request) {
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
    // Language school: handle contact (phone verification)
    if (isLanguageSchool && message.contact) {
      await processLanguageSchoolContact(tenant.id, chatId, message.contact, botToken);
    }
    // Language school: handle text with phone verification flow
    else if (isLanguageSchool && message.text) {
      await processLanguageSchoolMessage(tenant.id, chatId, message.text, botToken);
    }
    // All other org_types: original processor (untouched)
    else if (message.text) {
      await processMessage(tenant.id, chatId, message.text, botToken);
    }
  } catch (err) {
    console.error("[telegram-webhook] Error processing message:", err);
  }

  // Always return 200 — Telegram retries on non-200
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
