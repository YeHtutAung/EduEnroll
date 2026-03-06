// ─── Messenger message processor ────────────────────────────────────────────

import { sendTextMessage } from "./send";
import {
  sendWelcome,
  sendOpenIntakes,
  sendFees,
  sendEnrollLink,
  sendSchedule,
  sendPaymentInfo,
  sendStatusCheck,
} from "./responses";

// ─── Types ──────────────────────────────────────────────────────────────────

interface MessengerMessage {
  text?: string;
  quick_reply?: { payload: string };
}

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
    await handlePayload(tenantId, senderPsid, message.quick_reply.payload, pageToken);
    return;
  }

  const text = message.text?.trim();
  if (!text) return;

  // Check if it looks like a reference number
  if (REF_PATTERN.test(text)) {
    await sendStatusCheck(tenantId, senderPsid, text.toUpperCase(), pageToken);
    return;
  }

  // Keyword matching for free-text messages
  const lower = text.toLowerCase();
  if (lower.includes("fee") || lower.includes("ကြေး") || lower.includes("price")) {
    await sendFees(tenantId, senderPsid, pageToken);
    return;
  }
  if (lower.includes("enroll") || lower.includes("register") || lower.includes("စာရင်း")) {
    await sendEnrollLink(tenantId, senderPsid, pageToken);
    return;
  }
  if (lower.includes("schedule") || lower.includes("date") || lower.includes("အချိန်")) {
    await sendSchedule(tenantId, senderPsid, pageToken);
    return;
  }
  if (lower.includes("pay") || lower.includes("bank") || lower.includes("ငွေ") || lower.includes("ဘဏ်")) {
    await sendPaymentInfo(tenantId, senderPsid, pageToken);
    return;
  }
  if (lower.includes("status") || lower.includes("check") || lower.includes("စစ်ဆေး")) {
    await sendTextMessage(
      pageToken,
      senderPsid,
      "Please send your enrollment reference number.\nစာရင်းသွင်း ရည်ညွှန်းနံပါတ် ပို့ပေးပါ။\n\nExample: NM-2026-00042",
    );
    return;
  }
  if (lower.includes("intake") || lower.includes("class") || lower.includes("သင်တန်း") || lower.includes("course")) {
    await sendOpenIntakes(tenantId, senderPsid, pageToken);
    return;
  }

  // Default: send welcome message
  await sendWelcome(tenantId, senderPsid, pageToken);
}

// ─── Payload router ─────────────────────────────────────────────────────────

async function handlePayload(
  tenantId: string,
  senderPsid: string,
  payload: string,
  pageToken: string,
): Promise<void> {
  switch (payload) {
    case "OPEN_INTAKES":
      await sendOpenIntakes(tenantId, senderPsid, pageToken);
      break;

    case "FEES":
      await sendFees(tenantId, senderPsid, pageToken);
      break;

    case "HOW_TO_ENROLL":
      await sendEnrollLink(tenantId, senderPsid, pageToken);
      break;

    case "SCHEDULE":
      await sendSchedule(tenantId, senderPsid, pageToken);
      break;

    case "PAYMENT":
      await sendPaymentInfo(tenantId, senderPsid, pageToken);
      break;

    case "CHECK_STATUS":
      await sendTextMessage(
        pageToken,
        senderPsid,
        "Please send your enrollment reference number.\nစာရင်းသွင်း ရည်ညွှန်းနံပါတ် ပို့ပေးပါ။\n\nExample: NM-2026-00042",
      );
      break;

    case "MAIN_MENU":
      await sendWelcome(tenantId, senderPsid, pageToken);
      break;

    default:
      await sendWelcome(tenantId, senderPsid, pageToken);
      break;
  }
}
