// ─── Language-school Telegram processor (Sprint 9) ──────────────────────────
// Collects Telegram phone number and links chat_id to enrollment.
// Only used when tenant org_type === 'language_school'.
// Does NOT modify the original processor.ts.
// Flow: /start REF → ask phone → store phone + link chat_id.
// Blocks overwrites: if already linked to a different account, rejects.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendMessage, requestContact, removeKeyboard } from "./send";

const REF_PATTERN = /^[A-Z]{1,5}-\d{4}-[A-Z0-9]{3,6}$/;

// ─── Contact message handler ────────────────────────────────────────────────

export interface TelegramContact {
  phone_number: string;
  first_name?: string;
  user_id?: number;
}

export async function processLanguageSchoolContact(
  tenantId: string,
  chatId: string,
  contact: TelegramContact,
  botToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  // Find enrollment that is pending phone collection for this chatId
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, enrollment_ref, status")
    .eq("telegram_link_pending_chat_id", chatId)
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      id: string;
      enrollment_ref: string;
      status: string;
    } | null;
    error: unknown;
  };

  if (!enrollment) {
    await removeKeyboard(
      botToken,
      chatId,
      `❌ No pending connection found.\nPlease tap the "Connect Telegram" link from your payment page first.\n\n` +
        `ချိတ်ဆက်ရန် စောင့်ဆိုင်းနေသည့် အချက် မရှိပါ။\n` +
        `ငွေပေးချေမှုစာမျက်နှာမှ "Connect Telegram" ကို အရင်နှိပ်ပါ။`,
    );
    return;
  }

  // Store phone + link chat_id
  await supabase
    .from("enrollments")
    .update({
      telegram_chat_id: chatId,
      telegram_phone: contact.phone_number,
      telegram_link_pending_chat_id: null,
    } as never)
    .eq("id", enrollment.id);

  await removeKeyboard(
    botToken,
    chatId,
    `✅ Linked! You'll receive updates for <b>${enrollment.enrollment_ref}</b> here.\n\n` +
      `<b>${enrollment.enrollment_ref}</b> အတွက် အပ်ဒိတ်များ ဤနေရာတွင် ရရှိပါမည်။\n\n` +
      `Current status: <b>${enrollment.status.replace(/_/g, " ")}</b>`,
  );
}

// ─── Text message handler ───────────────────────────────────────────────────

export async function processLanguageSchoolMessage(
  tenantId: string,
  chatId: string,
  text: string,
  botToken: string,
): Promise<void> {
  const trimmed = text.trim();

  // /start <enrollment_ref> — begin phone collection flow
  if (trimmed.startsWith("/start")) {
    const ref = trimmed.substring(6).trim().toUpperCase().replace(/_/g, "-");
    if (ref && REF_PATTERN.test(ref)) {
      await handleStartLink(tenantId, chatId, ref, botToken);
    } else {
      await sendMessage(
        botToken,
        chatId,
        `👋 Welcome! To connect your Telegram, tap the link from your payment page.\n\n` +
          `Telegram ချိတ်ဆက်ရန် ငွေပေးချေမှုစာမျက်နှာမှ link ကို နှိပ်ပါ။\n\n` +
          `Or send your enrollment reference (e.g. <b>T-2026-00123</b>) to check status.\n` +
          `သို့မဟုတ် enrollment reference ပို့ပြီး status စစ်ပါ။`,
      );
    }
    return;
  }

  // /status <ref>
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

// ─── Start link: ask for phone, block overwrites ────────────────────────────

async function handleStartLink(
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
    data: {
      id: string;
      enrollment_ref: string;
      status: string;
      telegram_chat_id: string | null;
    } | null;
    error: unknown;
  };

  if (!enrollment) {
    await sendMessage(
      botToken,
      chatId,
      `❌ Enrollment <b>${ref}</b> not found.\n\nစာရင်းသွင်းမှု ရှာမတွေ့ပါ။`,
    );
    return;
  }

  // Block connection before payment is submitted
  if (enrollment.status === "pending_payment") {
    await sendMessage(
      botToken,
      chatId,
      `⏳ Payment has not been submitted yet for <b>${ref}</b>.\n` +
        `Please submit your payment first, then come back to connect Telegram.\n\n` +
        `<b>${ref}</b> အတွက် ငွေပေးချေမှု မတင်ရသေးပါ။\n` +
        `ငွေပေးချေမှု အရင်တင်ပြီးမှ Telegram ချိတ်ဆက်ရန် ပြန်လာပါ။`,
    );
    return;
  }

  // Already linked to THIS chat
  if (enrollment.telegram_chat_id === chatId) {
    await sendMessage(
      botToken,
      chatId,
      `✅ Already linked! You'll receive updates for <b>${ref}</b>.\n\n` +
        `<b>${ref}</b> အတွက် ချိတ်ဆက်ပြီးသားဖြစ်ပါသည်။`,
    );
    return;
  }

  // Already linked to a DIFFERENT chat — block overwrite
  if (enrollment.telegram_chat_id) {
    await sendMessage(
      botToken,
      chatId,
      `❌ This enrollment is already connected to another Telegram account.\n` +
        `If you need to re-link, please contact the school admin.\n\n` +
        `ဤစာရင်းသွင်းမှုသည် အခြား Telegram အကောင့်နှင့် ချိတ်ဆက်ပြီးဖြစ်သည်။\n` +
        `ပြန်လည်ချိတ်ဆက်လိုပါက ကျောင်း admin ထံ ဆက်သွယ်ပါ။`,
    );
    return;
  }

  // Set pending state — waiting for phone share
  await supabase
    .from("enrollments")
    .update({ telegram_link_pending_chat_id: chatId } as never)
    .eq("id", enrollment.id);

  // Ask for phone number (to collect, not to verify)
  await requestContact(
    botToken,
    chatId,
    `📱 Please share your phone number to complete the connection.\n` +
      `Tap the button below.\n\n` +
      `ချိတ်ဆက်မှု ပြီးမြောက်ရန် ဖုန်းနံပါတ် ပေးပို့ပါ။\n` +
      `အောက်ပါ ခလုတ်ကို နှိပ်ပါ။`,
  );
}

// ─── Status check (same logic as original processor) ────────────────────────

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
    await sendMessage(
      botToken,
      chatId,
      `❌ Enrollment <b>${ref}</b> not found.\n\nစာရင်းသွင်းမှု ရှာမတွေ့ပါ။`,
    );
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
