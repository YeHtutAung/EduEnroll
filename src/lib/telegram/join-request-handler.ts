// ─── Auto-approve/decline channel join requests (Sprint 9) ──────────────────
// Handles chat_join_request webhook events for language_school tenants.
// Approves if the user has a verified enrollment for the channel's class.

import { createAdminClient } from "@/lib/supabase/admin";
import { approveChatJoinRequest, declineChatJoinRequest, sendMessage } from "./send";

export interface ChatJoinRequest {
  chat: { id: number; title?: string };
  from: { id: number; first_name?: string; username?: string };
  date: number;
}

/**
 * Handle a chat_join_request event.
 * - Looks up which class the channel belongs to
 * - Checks if the requesting user has a confirmed enrollment with linked telegram
 * - Approves or declines accordingly
 */
export async function handleChatJoinRequest(
  tenantId: string,
  joinRequest: ChatJoinRequest,
  botToken: string,
): Promise<void> {
  const channelId = String(joinRequest.chat.id);
  const userId = joinRequest.from.id;
  const userChatId = String(userId);

  const supabase = createAdminClient();

  // Find which class this channel belongs to
  const { data: classChannel } = (await supabase
    .from("class_channels")
    .select("class_id, telegram_channel_name")
    .eq("tenant_id", tenantId)
    .eq("telegram_channel_id", channelId)
    .single()) as {
    data: { class_id: string; telegram_channel_name: string | null } | null;
    error: unknown;
  };

  if (!classChannel) {
    // Channel not managed by us — ignore
    return;
  }

  // Check if this user has a confirmed enrollment for this class
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, enrollment_ref, status")
    .eq("tenant_id", tenantId)
    .eq("class_id", classChannel.class_id)
    .eq("telegram_chat_id", userChatId)
    .eq("status", "confirmed")
    .maybeSingle()) as {
    data: { id: string; enrollment_ref: string; status: string } | null;
    error: unknown;
  };

  if (enrollment) {
    // Approved — verified student
    const result = await approveChatJoinRequest(botToken, joinRequest.chat.id, userId);
    if (result.ok) {
      await sendMessage(
        botToken,
        userChatId,
        `✅ You've been approved to join <b>${classChannel.telegram_channel_name ?? "the class channel"}</b>!\n\n` +
          `<b>${classChannel.telegram_channel_name ?? "အတန်း channel"}</b> သို့ ဝင်ခွင့်ရပြီ။`,
      );
    }
  } else {
    // Declined — no verified enrollment
    await declineChatJoinRequest(botToken, joinRequest.chat.id, userId);
    await sendMessage(
      botToken,
      userChatId,
      `❌ Your request to join <b>${classChannel.telegram_channel_name ?? "the channel"}</b> was declined.\n\n` +
        `You need a verified enrollment to join this channel.\n` +
        `Please complete enrollment and payment first.\n\n` +
        `ဤ channel သို့ ဝင်ခွင့်ရရန် စာရင်းသွင်းပြီး ငွေပေးချေမှု အတည်ပြုပြီးဖြစ်ရပါမည်။`,
    );
  }
}
