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
  sendHandoffStart,
  sendUnrecognized,
  checkHandoff,
  endHandoff,
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
  const text = message.text?.trim();
  const lower = text?.toLowerCase() ?? "";

  // "bot" keyword exits handoff — always check first
  if (lower === "bot") {
    await endHandoff(tenantId, senderPsid, pageToken);
    return;
  }

  // Check if user is in live-agent handoff mode — bot stays silent
  let isHandoff = false;
  try {
    isHandoff = await checkHandoff(tenantId, senderPsid);
  } catch {
    // Handoff check failed — fall through to normal bot
    isHandoff = false;
  }
  if (isHandoff) return;

  // Quick reply payloads take priority
  if (message.quick_reply?.payload) {
    await handlePayload(tenantId, senderPsid, message.quick_reply.payload, pageToken);
    return;
  }

  if (!text) return;

  // Check if it looks like a reference number
  if (REF_PATTERN.test(text)) {
    await sendStatusCheck(tenantId, senderPsid, text.toUpperCase(), pageToken);
    return;
  }

  // Greetings → show welcome menu
  if (/^(hi|hello|hey|start|menu|get started|မင်္ဂလာ|ဟယ်လို)$/i.test(lower)) {
    await sendWelcome(tenantId, senderPsid, pageToken);
    return;
  }

  // Keyword matching for free-text messages
  if (lower.includes("fee") || lower.includes("ကြေး") || lower.includes("price") || lower.includes("ticket")) {
    await sendFees(tenantId, senderPsid, pageToken);
    return;
  }
  if (lower.includes("enroll") || lower.includes("register") || lower.includes("စာရင်း")) {
    await sendEnrollLink(tenantId, senderPsid, pageToken);
    return;
  }
  if (lower.includes("schedule") || lower.includes("date") || lower.includes("အချိန်") || lower.includes("event")) {
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
  if (lower.includes("agent") || lower.includes("human") || lower.includes("help") || lower.includes("လူ")) {
    await sendHandoffStart(tenantId, senderPsid, pageToken);
    return;
  }

  // Unrecognized input: show "I didn't understand" + menu
  await sendUnrecognized(tenantId, senderPsid, pageToken);
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

    case "LIVE_AGENT":
      await sendHandoffStart(tenantId, senderPsid, pageToken);
      break;

    case "MAIN_MENU":
      await sendWelcome(tenantId, senderPsid, pageToken);
      break;

    default:
      await sendWelcome(tenantId, senderPsid, pageToken);
      break;
  }
}
