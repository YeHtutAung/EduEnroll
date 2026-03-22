// ─── Auto-send channel invite after payment approval (Sprint 9) ─────────────
// Only active for language_school tenants with telegram_auto_send_invite = true.

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/messenger/crypto";
import { sendMessageWithButtons } from "./send";

interface SendInviteParams {
  tenantId: string;
  enrollmentId: string;
  classId: string | null;
  telegramChatId: string;
  studentName: string;
}

/**
 * Sends the Telegram channel invite link to a verified student.
 * Returns true if sent, false if skipped (no channel, not enabled, etc.).
 */
export async function sendChannelInviteIfEligible(
  params: SendInviteParams,
): Promise<boolean> {
  const { tenantId, classId, telegramChatId, studentName } = params;

  if (!classId || !telegramChatId) return false;

  const supabase = createAdminClient();

  // Check tenant settings
  const { data: tenant } = (await supabase
    .from("tenants")
    .select("org_type, telegram_auto_send_invite, telegram_bot_token, telegram_enabled")
    .eq("id", tenantId)
    .single()) as {
    data: {
      org_type: string;
      telegram_auto_send_invite: boolean;
      telegram_bot_token: string | null;
      telegram_enabled: boolean;
    } | null;
    error: unknown;
  };

  if (!tenant) return false;
  if (tenant.org_type !== "language_school") return false;
  if (!tenant.telegram_auto_send_invite) return false;
  if (!tenant.telegram_enabled || !tenant.telegram_bot_token) return false;

  // Find channel for this class
  const { data: channel } = (await supabase
    .from("class_channels")
    .select("telegram_channel_name, telegram_invite_link")
    .eq("tenant_id", tenantId)
    .eq("class_id", classId)
    .single()) as {
    data: {
      telegram_channel_name: string | null;
      telegram_invite_link: string | null;
    } | null;
    error: unknown;
  };

  if (!channel?.telegram_invite_link) return false;

  // Decrypt bot token and send invite
  let botToken: string;
  try {
    botToken = decryptToken(tenant.telegram_bot_token);
  } catch {
    console.error("[channel-invite] Failed to decrypt bot token");
    return false;
  }

  const channelName = channel.telegram_channel_name ?? "Class Channel";

  await sendMessageWithButtons(botToken, telegramChatId, [
    `🎉 <b>Payment verified!</b>`,
    ``,
    `${studentName}, you can now join the class channel:`,
    `<b>${channelName}</b>`,
    ``,
    `Tap the button below to join.`,
    ``,
    `ငွေပေးချေမှု အတည်ပြုပြီးပါပြီ။`,
    `အောက်ပါ ခလုတ်ကို နှိပ်ပြီး အတန်း channel သို့ ဝင်ပါ။`,
  ].join("\n"), [
    [{ text: `📺 Join ${channelName}`, url: channel.telegram_invite_link }],
  ]);

  return true;
}
