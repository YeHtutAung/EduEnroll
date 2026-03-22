// ─── Language-school Telegram processor (Sprint 9) ──────────────────────────
// Adds phone verification before linking chat_id to enrollment.
// Only used when tenant org_type === 'language_school'.
// Does NOT modify the original processor.ts.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendMessage, requestContact, removeKeyboard } from "./send";

const REF_PATTERN = /^[A-Z]{1,5}-\d{4}-[A-Z0-9]{3,6}$/;

/** Normalize phone for comparison: strip +, spaces, leading country code 95 */
function normalizePhone(phone: string): string {
  let p = phone.replace(/[\s\-\+\(\)]/g, "");
  // +959xxx → 09xxx
  if (p.startsWith("959") && p.length >= 10) {
    p = "0" + p.substring(2);
  }
  // 09xxx stays 09xxx
  return p;
}

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

  // Find enrollment that is pending verification for this chatId
  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("id, enrollment_ref, phone, status, telegram_chat_id")
    .eq("telegram_link_pending_chat_id", chatId)
    .eq("tenant_id", tenantId)
    .single()) as {
    data: {
      id: string;
      enrollment_ref: string;
      phone: string;
      status: string;
      telegram_chat_id: string | null;
    } | null;
    error: unknown;
  };

  if (!enrollment) {
    await removeKeyboard(
      botToken,
      chatId,
      `❌ No pending verification found.\nPlease tap the "Connect Telegram" link from your payment page first.\n\n` +
        `အတည်ပြု ရန် စောင့်ဆိုင်းနေသည့် ချိတ်ဆက်မှု မရှိပါ။\n` +
        `ငွေပေးချေမှုစာမျက်နှာမှ "Connect Telegram" ကို အရင်နှိပ်ပါ။`,
    );
    return;
  }

  // Compare phone numbers
  const enrolledPhone = normalizePhone(enrollment.phone);
  const sharedPhone = normalizePhone(contact.phone_number);

  if (!sharedPhone.endsWith(enrolledPhone) && !enrolledPhone.endsWith(sharedPhone)) {
    await sendMessage(
      botToken,
      chatId,
      `❌ Phone number doesn't match.\n` +
        `Please share the phone number you used to enroll.\n\n` +
        `ဖုန်းနံပါတ် မကိုက်ညီပါ။\n` +
        `စာရင်းသွင်းရာတွင် သုံးခဲ့သော ဖုန်းနံပါတ်ကို ပေးပို့ပါ။`,
    );
    return;
  }

  // Phone matched — link the enrollment
  await supabase
    .from("enrollments")
    .update({
      telegram_chat_id: chatId,
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

  // /start <enrollment_ref> — begin phone verification flow
  if (trimmed.startsWith("/start")) {
    const ref = trimmed.substring(6).trim().toUpperCase().replace(/_/g, "-");
    if (ref && REF_PATTERN.test(ref)) {
      await handleVerifiedLink(tenantId, chatId, ref, botToken);
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

// ─── Start phone verification ───────────────────────────────────────────────

async function handleVerifiedLink(
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

  if (enrollment.telegram_chat_id === chatId) {
    await sendMessage(
      botToken,
      chatId,
      `✅ Already linked! You'll receive updates for <b>${ref}</b>.\n\n` +
        `<b>${ref}</b> အတွက် ချိတ်ဆက်ပြီးသားဖြစ်ပါသည်။`,
    );
    return;
  }

  // Set pending state — store chatId so we can match when phone is shared
  await supabase
    .from("enrollments")
    .update({ telegram_link_pending_chat_id: chatId } as never)
    .eq("id", enrollment.id);

  // Ask for phone verification
  await requestContact(
    botToken,
    chatId,
    `🔐 To verify your identity, please share your phone number.\n` +
      `Tap the button below to share.\n\n` +
      `သင့်အထောက်အထားကို အတည်ပြုရန် ဖုန်းနံပါတ် ပေးပို့ပါ။\n` +
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
