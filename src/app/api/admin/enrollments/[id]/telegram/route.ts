import { NextRequest, NextResponse } from "next/server";
import { requireAuth, notFound } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/messenger/crypto";
import { banChatMember, unbanChatMember } from "@/lib/telegram/send";

// ─── GET /api/admin/enrollments/[id]/telegram ───────────────────────────────
// Returns telegram link status for an enrollment.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;
  const { id } = await params;

  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, telegram_chat_id, telegram_link_pending_chat_id, telegram_phone")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      id: string;
      telegram_chat_id: string | null;
      telegram_link_pending_chat_id: string | null;
      telegram_phone: string | null;
    } | null;
    error: unknown;
  };

  if (!enrollment) return notFound("Enrollment");

  return NextResponse.json({
    linked: !!enrollment.telegram_chat_id,
    chatId: enrollment.telegram_chat_id,
    pending: !!enrollment.telegram_link_pending_chat_id,
    phone: enrollment.telegram_phone,
  });
}

// ─── DELETE /api/admin/enrollments/[id]/telegram ────────────────────────────
// Unlinks telegram from an enrollment: kicks from channels, then clears DB.

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { tenantId } = auth;
  const { id } = await params;

  const supabase = createAdminClient();

  // Fetch enrollment with class_id and telegram_chat_id
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, class_id, telegram_chat_id")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      id: string;
      class_id: string | null;
      telegram_chat_id: string | null;
    } | null;
    error: unknown;
  };

  if (!enrollment) return notFound("Enrollment");

  // Kick from linked channels (best-effort, don't block on failure)
  if (enrollment.telegram_chat_id && enrollment.class_id) {
    try {
      // Get bot token
      const { data: tenant } = (await supabase
        .from("tenants")
        .select("telegram_bot_token, telegram_enabled")
        .eq("id", tenantId)
        .single()) as {
        data: { telegram_bot_token: string | null; telegram_enabled: boolean } | null;
        error: unknown;
      };

      if (tenant?.telegram_enabled && tenant.telegram_bot_token) {
        const botToken = decryptToken(tenant.telegram_bot_token);

        // Find all channels for this class
        const { data: channels } = (await supabase
          .from("class_channels")
          .select("telegram_channel_id")
          .eq("tenant_id", tenantId)
          .eq("class_id", enrollment.class_id)) as {
          data: { telegram_channel_id: string }[] | null;
          error: unknown;
        };

        if (channels && channels.length > 0) {
          // telegram_chat_id is the user's chat ID, which equals their user ID
          const userId = Number(enrollment.telegram_chat_id);

          for (const ch of channels) {
            // Ban then unban = kick without permanent ban (can rejoin later)
            await banChatMember(botToken, ch.telegram_channel_id, userId).catch(() => {});
            await unbanChatMember(botToken, ch.telegram_channel_id, userId).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error("[telegram-unlink] Failed to kick from channels:", err);
      // Continue with DB cleanup even if kick fails
    }
  }

  // Clear DB fields
  await supabase
    .from("enrollments")
    .update({
      telegram_chat_id: null,
      telegram_link_pending_chat_id: null,
      telegram_phone: null,
      telegram_link_token: null,
      telegram_link_token_expires_at: null,
    } as never)
    .eq("id", id);

  return NextResponse.json({ success: true, message: "Telegram unlinked and removed from channels." });
}
