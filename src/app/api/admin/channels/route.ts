import { NextRequest, NextResponse } from "next/server";
import { requireOwner, badRequest } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/messenger/crypto";
import {
  getChat,
  getMe,
  getChatMember,
  createChatInviteLink,
} from "@/lib/telegram/send";

// ─── GET /api/admin/channels ────────────────────────────────────────────────
// List class channels for tenant. Optional ?intake_id= filter.

export async function GET(request: NextRequest) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  const intakeId = request.nextUrl.searchParams.get("intake_id");

  const supabase = createAdminClient();

  const baseQuery = intakeId
    ? supabase
        .from("class_channels")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("intake_id", intakeId)
        .order("created_at", { ascending: false })
    : supabase
        .from("class_channels")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false });

  const { data, error } = (await baseQuery) as {
    data: Record<string, unknown>[] | null;
    error: { message: string } | null;
  };

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ channels: data ?? [] });
}

// ─── POST /api/admin/channels ───────────────────────────────────────────────
// Link a Telegram channel to a class.
// Body: { class_id, intake_id, telegram_channel_id }

export async function POST(request: NextRequest) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;

  let body: { class_id?: string; intake_id?: string; telegram_channel_id?: string };
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON");
  }

  const { class_id, intake_id, telegram_channel_id: rawChannelId } = body;
  if (!class_id || !intake_id || !rawChannelId) {
    return badRequest("class_id, intake_id, and telegram_channel_id are required.");
  }

  // Validate channel ID format — must be numeric (e.g. -1001234567890)
  const telegram_channel_id = rawChannelId.trim();
  if (!/^-?\d+$/.test(telegram_channel_id)) {
    return badRequest(
      "Please enter the numeric Channel ID (e.g. -1001234567890), not an invite link. " +
        "To find it: forward any message from the channel to @RawDataBot on Telegram.",
    );
  }

  const supabase = createAdminClient();

  // Get tenant's bot token
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("telegram_bot_token, telegram_enabled, org_type")
    .eq("id", tenantId)
    .single()) as {
    data: {
      telegram_bot_token: string | null;
      telegram_enabled: boolean;
      org_type: string;
    } | null;
    error: unknown;
  };

  if (!tenant?.telegram_bot_token || !tenant.telegram_enabled) {
    return badRequest("Telegram bot is not connected or not enabled.");
  }

  if (tenant.org_type !== "language_school") {
    return badRequest("Channel management is only available for language schools.");
  }

  let botToken: string;
  try {
    botToken = decryptToken(tenant.telegram_bot_token);
  } catch {
    return NextResponse.json({ error: "Failed to decrypt bot token." }, { status: 500 });
  }

  // Validate bot is admin of the channel
  const meResult = await getMe(botToken);
  if (!meResult.ok || !meResult.result) {
    return NextResponse.json({ error: "Bot token is invalid." }, { status: 502 });
  }

  const botUserId = (meResult.result as { id: number; username: string }).id;

  const memberResult = await getChatMember(botToken, telegram_channel_id, botUserId);
  if (!memberResult.ok || !memberResult.result) {
    return badRequest(
      "Bot is not a member of this channel. Please add the bot as an admin first.",
    );
  }

  if (memberResult.result.status !== "administrator" && memberResult.result.status !== "creator") {
    return badRequest(
      "Bot must be an admin of the channel. Please promote the bot to admin.",
    );
  }

  // Get channel info
  const chatResult = await getChat(botToken, telegram_channel_id);
  if (!chatResult.ok || !chatResult.result) {
    return badRequest("Could not fetch channel info. Check the channel ID.");
  }

  const channelName = chatResult.result.title ?? "Unknown Channel";

  // Create invite link with join request approval
  const inviteResult = await createChatInviteLink(botToken, telegram_channel_id, {
    creates_join_request: true,
    name: `EduEnroll - ${channelName}`,
  });

  const inviteLink = inviteResult.ok ? inviteResult.result?.invite_link ?? null : null;

  // Check for duplicate (class already linked)
  const { data: existing } = (await supabase
    .from("class_channels")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("class_id", class_id)
    .maybeSingle()) as { data: { id: string } | null; error: unknown };

  if (existing) {
    return badRequest("This class already has a linked channel. Unlink it first.");
  }

  // Insert
  const { data: channel, error: insertError } = (await supabase
    .from("class_channels")
    .insert({
      tenant_id: tenantId,
      intake_id,
      class_id,
      telegram_channel_id,
      telegram_channel_name: channelName,
      telegram_invite_link: inviteLink,
    } as never)
    .select("*")
    .single()) as { data: Record<string, unknown> | null; error: { message: string } | null };

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ channel, message: `Linked to ${channelName}` }, { status: 201 });
}
