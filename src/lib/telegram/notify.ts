// ─── Telegram status notification helper ─────────────────────────────────────
// Mirrors src/lib/messenger/notify.ts for Telegram.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendMessageWithButtons } from "./send";
import { decryptToken } from "@/lib/messenger/crypto";
import { formatMMK } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

interface NotifyParams {
  tenantId: string;
  telegramChatId: string;
  action: "approve" | "reject" | "request_remaining";
  studentName: string;
  enrollmentRef: string;
  classLevel: string;
  statusUrl: string;
  paymentUrl: string;
  rejectionReason?: string | null;
  adminNote?: string | null;
  receivedAmount?: number | null;
  remainingAmount?: number | null;
}

// ─── Main function ──────────────────────────────────────────────────────────

export async function sendTelegramStatusNotification(params: NotifyParams): Promise<boolean> {
  const {
    tenantId,
    telegramChatId,
    action,
    studentName,
    enrollmentRef,
    classLevel,
    statusUrl,
    paymentUrl,
    rejectionReason,
    adminNote,
    receivedAmount,
    remainingAmount,
  } = params;

  try {
    const supabase = createAdminClient();
    const { data: tenant } = (await supabase
      .from("tenants")
      .select("telegram_bot_token, telegram_enabled")
      .eq("id", tenantId)
      .single()) as {
      data: { telegram_bot_token: string | null; telegram_enabled: boolean } | null;
      error: unknown;
    };

    if (!tenant?.telegram_enabled || !tenant.telegram_bot_token) {
      return false;
    }

    const botToken = decryptToken(tenant.telegram_bot_token);

    switch (action) {
      case "approve": {
        const text =
          `✅ <b>Payment Verified!</b>\nငွေပေးချေမှု အတည်ပြုပြီး!\n\n` +
          `Hi ${studentName}, your payment for <b>${classLevel}</b> (${enrollmentRef}) has been confirmed.\n\n` +
          `${studentName}, သင့် ${classLevel} (${enrollmentRef}) ငွေပေးချေမှု အတည်ပြုပြီးပါပြီ။`;
        await sendMessageWithButtons(botToken, telegramChatId, text, [
          [{ text: "View Status / အခြေအနေ ကြည့်ရန်", url: statusUrl }],
        ]);
        break;
      }

      case "reject": {
        let text =
          `❌ <b>Payment Not Approved</b>\nငွေပေးချေမှု အတည်မပြုပါ\n\n` +
          `Hi ${studentName}, your payment for <b>${classLevel}</b> (${enrollmentRef}) was not approved.`;
        if (rejectionReason) {
          text += `\nReason: ${rejectionReason}`;
          text += `\nအကြောင်းပြချက်: ${rejectionReason}`;
        }
        await sendMessageWithButtons(botToken, telegramChatId, text, [
          [{ text: "View Status / အခြေအနေ ကြည့်ရန်", url: statusUrl }],
        ]);
        break;
      }

      case "request_remaining": {
        let text =
          `💰 <b>Partial Payment Received</b>\nငွေတစ်စိတ်တစ်ပိုင်း လက်ခံရရှိပြီး\n\n` +
          `Hi ${studentName}, we received partial payment for ${enrollmentRef}.`;
        if (receivedAmount != null) {
          text += `\nReceived / လက်ခံရရှိ: ${formatMMK(receivedAmount)}`;
        }
        if (remainingAmount != null && remainingAmount > 0) {
          text += `\nRemaining / ကျန်ငွေ: ${formatMMK(remainingAmount)}`;
        }
        if (adminNote) {
          text += `\n\n${adminNote}`;
        }
        await sendMessageWithButtons(botToken, telegramChatId, text, [
          [{ text: "Pay Remaining / ကျန်ငွေ ပေးချေရန်", url: paymentUrl }],
        ]);
        break;
      }
    }

    return true;
  } catch (err) {
    console.error("[telegram-notify] Failed to send notification:", err);
    return false;
  }
}
