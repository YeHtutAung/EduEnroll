import { sendEmail, enrollmentRejectedEmail } from "@/lib/email";
import { sendStatusNotification } from "@/lib/messenger/notify";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";

export interface RejectionNotificationInput {
  tenantId: string;
  enrollmentRef: string;
  studentName: string;
  classLevel: string;
  statusUrl: string;
  paymentUrl: string;
  currency: string;
  // Contact
  email?: string | null;
  phone?: string | null; // unused on rejection, kept for symmetry
  messengerPsid?: string | null;
  telegramChatId?: string | null;
  // Tenant settings
  tenantName?: string;
  orgType?: string;
  logoUrl?: string;
  // Rejection detail
  rejectionReason?: string | null;
}

/**
 * Dispatches all rejection notifications for a denied payment.
 * Runs all enabled channels concurrently (Promise.allSettled).
 * Errors in individual channels are logged but do not fail the dispatch.
 * No SMS on rejection. No channel invite.
 */
export async function dispatchPaymentRejected(input: RejectionNotificationInput): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if (input.email) {
    const emailData = enrollmentRejectedEmail({
      studentName: input.studentName,
      enrollmentRef: input.enrollmentRef,
      classLevel: input.classLevel,
      reason: input.rejectionReason ?? null,
      statusUrl: input.statusUrl,
      orgType: input.orgType,
      tenantName: input.tenantName,
      logoUrl: input.logoUrl,
    });
    tasks.push(
      sendEmail({ to: input.email, ...emailData }).catch((err) => {
        console.error("[dispatchPaymentRejected] Email failed:", err);
      }),
    );
  }

  if (input.messengerPsid) {
    tasks.push(
      sendStatusNotification({
        tenantId: input.tenantId,
        messengerPsid: input.messengerPsid,
        action: "reject",
        studentName: input.studentName,
        enrollmentRef: input.enrollmentRef,
        classLevel: input.classLevel,
        statusUrl: input.statusUrl,
        paymentUrl: input.paymentUrl,
        rejectionReason: input.rejectionReason ?? null,
        currency: input.currency,
      }).catch((err) => {
        console.error("[dispatchPaymentRejected] Messenger failed:", err);
      }),
    );
  }

  if (input.telegramChatId) {
    tasks.push(
      sendTelegramStatusNotification({
        tenantId: input.tenantId,
        telegramChatId: input.telegramChatId,
        action: "reject",
        studentName: input.studentName,
        enrollmentRef: input.enrollmentRef,
        classLevel: input.classLevel,
        statusUrl: input.statusUrl,
        paymentUrl: input.paymentUrl,
        rejectionReason: input.rejectionReason ?? null,
        currency: input.currency,
      }).catch((err) => {
        console.error("[dispatchPaymentRejected] Telegram failed:", err);
      }),
    );
  }

  await Promise.allSettled(tasks);
}
