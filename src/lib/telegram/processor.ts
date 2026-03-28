// ─── Telegram message processor ──────────────────────────────────────────────
// Handles incoming messages from Telegram webhook.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendMessage } from "./send";

const REF_PATTERN = /^[A-Z]{1,5}-\d{4}-[A-Z0-9]{3,6}$/;

export async function processMessage(
  tenantId: string,
  chatId: string,
  text: string,
  botToken: string,
): Promise<void> {
  const trimmed = text.trim();

  // /start <enrollment_ref> — link chat to enrollment
  // Telegram deep links only allow A-Z a-z 0-9 _ so hyphens are sent as underscores
  if (trimmed.startsWith("/start")) {
    const ref = trimmed.substring(6).trim().toUpperCase().replace(/_/g, "-");
    if (ref && REF_PATTERN.test(ref)) {
      await handleLink(tenantId, chatId, ref, botToken);
    } else {
      await sendMessage(
        botToken,
        chatId,
        `👋 Welcome! To receive ticket updates, tap the link from your confirmation page.\n\n` +
          `Or send your enrollment reference (e.g. <b>T-2026-00123</b>) to check your status.\n\n` +
          `လက်မှတ် အပ်ဒိတ်များ ရယူရန် confirmation page မှ link ကို နှိပ်ပါ။\n` +
          `သို့မဟုတ် enrollment reference ပို့ပြီး status စစ်ပါ။`,
      );
    }
    return;
  }

  // /status <ref> — check status
  if (trimmed.startsWith("/status")) {
    const ref = trimmed.substring(7).trim().toUpperCase();
    if (ref && REF_PATTERN.test(ref)) {
      await handleStatus(tenantId, chatId, ref, botToken);
    } else {
      await sendMessage(botToken, chatId, "Usage: /status T-2026-00123");
    }
    return;
  }

  // Free text matching enrollment ref pattern
  const upper = trimmed.toUpperCase();
  if (REF_PATTERN.test(upper)) {
    await handleStatus(tenantId, chatId, upper, botToken);
    return;
  }

  // Help
  await sendMessage(
    botToken,
    chatId,
    `Send your enrollment reference to check status.\n` +
      `e.g. <b>T-2026-00123</b>\n\n` +
      `enrollment reference ပို့ပြီး status စစ်ပါ။`,
  );
}

// ─── Link chat_id to enrollment ─────────────────────────────────────────────

async function handleLink(
  tenantId: string,
  chatId: string,
  ref: string,
  botToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, enrollment_ref, status, telegram_chat_id")
    .eq("enrollment_ref", ref)
    .eq("tenant_id", tenantId)
    .single()) as {
    data: { id: string; enrollment_ref: string; status: string; telegram_chat_id: string | null } | null;
    error: unknown;
  };

  if (!enrollment) {
    await sendMessage(botToken, chatId, `❌ Enrollment <b>${ref}</b> not found.\n\nစာရင်းသွင်းမှု ရှာမတွေ့ပါ။`);
    return;
  }

  if (enrollment.telegram_chat_id === chatId) {
    await sendMessage(botToken, chatId, `✅ Already linked! You'll receive updates for <b>${ref}</b>.`);
    return;
  }

  await supabase
    .from("enrollments")
    .update({ telegram_chat_id: chatId } as never)
    .eq("id", enrollment.id);

  await sendMessage(
    botToken,
    chatId,
    `✅ Linked! You'll receive ticket & payment updates for <b>${ref}</b> here.\n\n` +
      `<b>${ref}</b> အတွက် လက်မှတ်နှင့် ငွေပေးချေမှု အပ်ဒိတ်များ ဤနေရာတွင် ရရှိပါမည်။\n\n` +
      `Current status: <b>${enrollment.status.replace(/_/g, " ")}</b>`,
  );
}

// ─── Status check ───────────────────────────────────────────────────────────

async function handleStatus(
  tenantId: string,
  chatId: string,
  ref: string,
  botToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("enrollment_ref, status, student_name_en")
    .eq("enrollment_ref", ref)
    .eq("tenant_id", tenantId)
    .single()) as {
    data: { enrollment_ref: string; status: string; student_name_en: string } | null;
    error: unknown;
  };

  if (!enrollment) {
    await sendMessage(botToken, chatId, `❌ Enrollment <b>${ref}</b> not found.\n\nစာရင်းသွင်းမှု ရှာမတွေ့ပါ။`);
    return;
  }

  const statusLabels: Record<string, string> = {
    pending_payment: "⏳ Pending Payment / ငွေပေးချေရန် စောင့်ဆိုင်းနေသည်",
    payment_submitted: "📤 Payment Submitted / ငွေပေးချေမှု တင်ပြီး",
    confirmed: "✅ Confirmed / အတည်ပြုပြီး",
    rejected: "❌ Rejected / ပယ်ချပြီး",
    partial_payment: "💰 Partial Payment / ငွေတစ်စိတ်တစ်ပိုင်း",
  };

  const label = statusLabels[enrollment.status] ?? enrollment.status;

  await sendMessage(
    botToken,
    chatId,
    `📋 <b>${enrollment.enrollment_ref}</b>\n` +
      `Name: ${enrollment.student_name_en || "—"}\n` +
      `Status: ${label}`,
  );
}
