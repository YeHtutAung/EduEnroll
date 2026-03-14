// ─── Messenger status notification helper ────────────────────────────────────
//
// Sends a notification to the user's Messenger when admin takes action
// (approve / reject / request_remaining).

import { createAdminClient } from "@/lib/supabase/admin";
import { sendTextMessage } from "./send";
import { decryptToken } from "./crypto";
import { formatMMK } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

interface NotifyParams {
  tenantId: string;
  messengerPsid: string;
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

export async function sendStatusNotification(params: NotifyParams): Promise<boolean> {
  const {
    tenantId,
    messengerPsid,
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
    // Look up tenant's page token
    const supabase = createAdminClient();
    const { data: tenant } = await supabase
      .from("tenants")
      .select("messenger_page_token, messenger_enabled")
      .eq("id", tenantId)
      .single() as {
      data: { messenger_page_token: string | null; messenger_enabled: boolean } | null;
      error: unknown;
    };

    if (!tenant?.messenger_enabled || !tenant.messenger_page_token) {
      console.warn("[messenger-notify] Messenger not enabled for tenant", tenantId);
      return false;
    }

    const pageToken = decryptToken(tenant.messenger_page_token);
    const msg = composeMessage(action, {
      studentName,
      enrollmentRef,
      classLevel,
      statusUrl,
      paymentUrl,
      rejectionReason,
      adminNote,
      receivedAmount,
      remainingAmount,
    });

    await sendTextMessage(pageToken, messengerPsid, msg);
    return true;
  } catch (err) {
    console.error("[messenger-notify] Failed to send notification:", err);
    return false;
  }
}

// ─── Message composer ───────────────────────────────────────────────────────

function composeMessage(
  action: "approve" | "reject" | "request_remaining",
  p: {
    studentName: string;
    enrollmentRef: string;
    classLevel: string;
    statusUrl: string;
    paymentUrl: string;
    rejectionReason?: string | null;
    adminNote?: string | null;
    receivedAmount?: number | null;
    remainingAmount?: number | null;
  },
): string {
  switch (action) {
    case "approve":
      return (
        `✅ Payment Verified! / ငွေပေးချေမှု အတည်ပြုပြီး!\n\n` +
        `Hi ${p.studentName}, your payment for ${p.classLevel} (${p.enrollmentRef}) has been confirmed.\n\n` +
        `${p.studentName}, သင့် ${p.classLevel} (${p.enrollmentRef}) ငွေပေးချေမှု အတည်ပြုပြီးပါပြီ။\n\n` +
        `👉 ${p.statusUrl}`
      );

    case "reject": {
      let msg =
        `❌ Payment Not Approved / ငွေပေးချေမှု အတည်မပြုပါ\n\n` +
        `Hi ${p.studentName}, your payment for ${p.classLevel} (${p.enrollmentRef}) was not approved.`;
      if (p.rejectionReason) {
        msg += `\nReason: ${p.rejectionReason}`;
      }
      msg +=
        `\n\n${p.studentName}, သင့် ${p.classLevel} (${p.enrollmentRef}) ငွေပေးချေမှု အတည်မပြုပါ။`;
      if (p.rejectionReason) {
        msg += `\nအကြောင်းပြချက်: ${p.rejectionReason}`;
      }
      msg += `\n\n👉 ${p.statusUrl}`;
      return msg;
    }

    case "request_remaining": {
      let msg =
        `💰 Partial Payment Received / ငွေတစ်စိတ်တစ်ပိုင်း လက်ခံရရှိပြီး\n\n` +
        `Hi ${p.studentName}, we received partial payment for ${p.enrollmentRef}.`;
      if (p.receivedAmount != null) {
        msg += `\nReceived / လက်ခံရရှိ: ${formatMMK(p.receivedAmount)}`;
      }
      if (p.remainingAmount != null && p.remainingAmount > 0) {
        msg += `\nRemaining / ကျန်ငွေ: ${formatMMK(p.remainingAmount)}`;
      }
      if (p.adminNote) {
        msg += `\n\nAdmin: ${p.adminNote}`;
      }
      msg +=
        `\n\nကျန်ငွေ ပေးချေရန် / Pay remaining:\n👉 ${p.paymentUrl}`;
      return msg;
    }
  }
}
