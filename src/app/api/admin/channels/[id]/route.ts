import { NextRequest, NextResponse } from "next/server";
import { requireOwner, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/messenger/crypto";
import { getChatMemberCount } from "@/lib/telegram/send";

// ─── GET /api/admin/channels/[id] ──────────────────────────────────────────
// Get channel details including member count.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;
  const { id } = await params;

  const supabase = createAdminClient();

  const { data: channel } = (await supabase
    .from("class_channels")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      id: string;
      telegram_channel_id: string;
      telegram_channel_name: string | null;
      telegram_invite_link: string | null;
      class_id: string;
      intake_id: string;
      created_at: string;
    } | null;
    error: unknown;
  };

  if (!channel) return notFound("Channel");

  // Get member count from Telegram
  let memberCount: number | null = null;
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("telegram_bot_token")
    .eq("id", tenantId)
    .single()) as { data: { telegram_bot_token: string | null } | null; error: unknown };

  if (tenant?.telegram_bot_token) {
    try {
      const botToken = decryptToken(tenant.telegram_bot_token);
      const countResult = await getChatMemberCount(botToken, channel.telegram_channel_id);
      if (countResult.ok && countResult.result !== undefined) {
        memberCount = countResult.result;
      }
    } catch {
      // Ignore — bot might not have access anymore
    }
  }

  // Count linked enrollments for this class
  const { count: linkedCount } = await supabase
    .from("enrollments")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("class_id", channel.class_id)
    .not("telegram_chat_id", "is", null);

  return NextResponse.json({
    channel,
    memberCount,
    linkedEnrollments: linkedCount ?? 0,
  });
}

// ─── DELETE /api/admin/channels/[id] ────────────────────────────────────────
// Unlink a channel from a class.

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOwner();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;
  const { id } = await params;

  const supabase = createAdminClient();

  const { data: channel } = (await supabase
    .from("class_channels")
    .select("id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single()) as { data: { id: string } | null; error: unknown };

  if (!channel) return notFound("Channel");

  await supabase.from("class_channels").delete().eq("id", id);

  return NextResponse.json({ success: true, message: "Channel unlinked." });
}
