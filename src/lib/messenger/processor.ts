// ─── Messenger message processor ────────────────────────────────────────────

import { createAdminClient } from "@/lib/supabase/admin";
import { formatMMK } from "@/lib/utils";
import { sendTextMessage, sendQuickReplies } from "./send";
import type { Enrollment, Class, Payment } from "@/types/database";

// ─── Types ──────────────────────────────────────────────────────────────────

interface MessengerMessage {
  text?: string;
  quick_reply?: { payload: string };
}

interface EnrollmentWithClass extends Enrollment {
  classes: Pick<Class, "level" | "fee_mmk"> | null;
}

type EnrollmentResult = { data: EnrollmentWithClass | null; error: unknown };
type PaymentResult = { data: Pick<Payment, "status"> | null; error: unknown };

// ─── Status labels ──────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, { en: string; mm: string }> = {
  pending_payment: { en: "Awaiting Payment", mm: "ငွေပေးချေမှု စောင့်ဆိုင်းဆဲ" },
  payment_submitted: { en: "Payment Under Review", mm: "ငွေပေးချေမှု စစ်ဆေးနေဆဲ" },
  confirmed: { en: "Enrollment Confirmed ✅", mm: "စာရင်းသွင်းမှု အတည်ပြုပြီး ✅" },
  rejected: { en: "Enrollment Rejected ❌", mm: "စာရင်းသွင်းမှု ငြင်းဆိုထားသည် ❌" },
};

const PAYMENT_LABELS: Record<string, string> = {
  pending: "Pending Verification / အတည်ပြုမှု စောင့်ဆိုင်းဆဲ",
  verified: "Payment Verified ✅ / ငွေပေးချေမှု အတည်ပြုပြီး ✅",
  rejected: "Payment Rejected ❌ / ငွေပေးချေမှု ငြင်းဆိုထားသည် ❌",
};

// ─── Reference number pattern ───────────────────────────────────────────────

const REF_PATTERN = /^[A-Z]{2,4}-\d{4}-\d{4,6}$/i;

// ─── Main processor ─────────────────────────────────────────────────────────

export async function processMessage(
  tenantId: string,
  senderPsid: string,
  message: MessengerMessage,
  pageToken: string,
): Promise<void> {
  // Quick reply payloads take priority
  if (message.quick_reply?.payload) {
    await handleQuickReply(tenantId, senderPsid, message.quick_reply.payload, pageToken);
    return;
  }

  const text = message.text?.trim();
  if (!text) return;

  // Check if it looks like a reference number
  if (REF_PATTERN.test(text)) {
    await handleStatusCheck(tenantId, senderPsid, text.toUpperCase(), pageToken);
    return;
  }

  // Default: send welcome message
  await sendWelcome(senderPsid, pageToken);
}

// ─── Welcome message ────────────────────────────────────────────────────────

async function sendWelcome(senderPsid: string, pageToken: string): Promise<void> {
  await sendQuickReplies(
    pageToken,
    senderPsid,
    "မင်္ဂလာပါ! Welcome to KuuNyi 🎓\n\nHow can I help you?\nဘာကူညီပေးရမလဲ?",
    [
      { content_type: "text", title: "📋 Check Status", payload: "CHECK_STATUS" },
      { content_type: "text", title: "📞 Contact School", payload: "CONTACT_SCHOOL" },
    ],
  );
}

// ─── Quick reply handler ────────────────────────────────────────────────────

async function handleQuickReply(
  tenantId: string,
  senderPsid: string,
  payload: string,
  pageToken: string,
): Promise<void> {
  switch (payload) {
    case "CHECK_STATUS":
      await sendTextMessage(
        pageToken,
        senderPsid,
        "Please send your enrollment reference number.\n" +
          "စာရင်းသွင်း ရည်ညွှန်းနံပါတ် ပို့ပေးပါ။\n\n" +
          "Example: NM-2026-00042",
      );
      break;

    case "CONTACT_SCHOOL":
      await sendTextMessage(
        pageToken,
        senderPsid,
        "Please contact the school directly through their Facebook page.\n" +
          "ကျောင်း Facebook စာမျက်နှာမှ တိုက်ရိုက် ဆက်သွယ်ပါ။",
      );
      break;

    default:
      await sendWelcome(senderPsid, pageToken);
      break;
  }
}

// ─── Status check ───────────────────────────────────────────────────────────

async function handleStatusCheck(
  tenantId: string,
  senderPsid: string,
  ref: string,
  pageToken: string,
): Promise<void> {
  const supabase = createAdminClient();

  const { data: enrollment } = (await supabase
    .from("enrollments")
    .select("*, classes(level, fee_mmk)")
    .eq("enrollment_ref", ref)
    .eq("tenant_id", tenantId)
    .single()) as EnrollmentResult;

  if (!enrollment) {
    await sendTextMessage(
      pageToken,
      senderPsid,
      `❌ No enrollment found for "${ref}".\nစာရင်းသွင်းမှု ရှာမတွေ့ပါ။\n\nPlease check the reference number and try again.`,
    );
    return;
  }

  const statusLabel = STATUS_LABELS[enrollment.status] ?? {
    en: enrollment.status,
    mm: enrollment.status,
  };

  let reply =
    `📋 Enrollment Status / စာရင်းသွင်းမှု အခြေအနေ\n\n` +
    `Ref: ${enrollment.enrollment_ref}\n` +
    `Name: ${enrollment.student_name_en}\n`;

  if (enrollment.classes) {
    reply += `Class: JLPT ${enrollment.classes.level}\n`;
    reply += `Fee: ${formatMMK(enrollment.classes.fee_mmk)}\n`;
  }

  reply += `\nStatus: ${statusLabel.en}\n${statusLabel.mm}`;

  // Check payment status
  const { data: payment } = (await supabase
    .from("payments")
    .select("status")
    .eq("enrollment_id", enrollment.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .single()) as PaymentResult;

  if (payment) {
    const paymentLabel = PAYMENT_LABELS[payment.status] ?? payment.status;
    reply += `\n\n💰 Payment: ${paymentLabel}`;
  }

  await sendQuickReplies(pageToken, senderPsid, reply, [
    { content_type: "text", title: "🔄 Check Another", payload: "CHECK_STATUS" },
    { content_type: "text", title: "🏠 Main Menu", payload: "MAIN_MENU" },
  ]);
}
