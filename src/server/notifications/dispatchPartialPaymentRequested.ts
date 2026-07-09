import { sendEmail, partialPaymentEmail } from "@/lib/email";
import { sendStatusNotification } from "@/lib/messenger/notify";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";

export interface PartialPaymentNotificationInput {
  tenantId: string;
  enrollmentRef: string;
  studentName: string;
  classLevel: string;
  statusUrl: string;
  paymentUrl: string;
  currency: string;
  // Contact
  email?: string | null;
  phone?: string | null; // unused, kept for symmetry
  messengerPsid?: string | null;
  telegramChatId?: string | null;
  // Tenant settings
  tenantName?: string;
  orgType?: string;
  logoUrl?: string;
  // Partial payment details
  adminNote: string;
  totalAmount: number;
  receivedAmount?: number | null;
  remainingAmount?: number | null;
}

/**
 * Dispatches all notifications for a partial-payment / request-remaining action.
 * Runs all enabled channels concurrently (Promise.allSettled).
 * Errors in individual channels are logged but do not fail the dispatch.
 * No SMS. No channel invite.
 */
export async function dispatchPartialPaymentRequested(
  input: PartialPaymentNotificationInput,
): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if (input.email) {
    const emailData = partialPaymentEmail({
      studentName: input.studentName,
      enrollmentRef: input.enrollmentRef,
      classLevel: input.classLevel,
      totalAmount: input.totalAmount,
      receivedAmount: input.receivedAmount ?? null,
      remainingAmount: input.remainingAmount ?? null,
      adminNote: input.adminNote,
      paymentUrl: input.paymentUrl,
      statusUrl: input.statusUrl,
      orgType: input.orgType,
      tenantName: input.tenantName,
      logoUrl: input.logoUrl,
    });
    tasks.push(
      sendEmail({ to: input.email, ...emailData }).catch((err) => {
        console.error("[dispatchPartialPaymentRequested] Email failed:", err);
      }),
    );
  }

  if (input.messengerPsid) {
    tasks.push(
      sendStatusNotification({
        tenantId: input.tenantId,
        messengerPsid: input.messengerPsid,
        action: "request_remaining",
        studentName: input.studentName,
        enrollmentRef: input.enrollmentRef,
        classLevel: input.classLevel,
        statusUrl: input.statusUrl,
        paymentUrl: input.paymentUrl,
        adminNote: input.adminNote,
        receivedAmount: input.receivedAmount ?? null,
        remainingAmount: input.remainingAmount ?? null,
        currency: input.currency,
      }).catch((err) => {
        console.error("[dispatchPartialPaymentRequested] Messenger failed:", err);
      }),
    );
  }

  if (input.telegramChatId) {
    tasks.push(
      sendTelegramStatusNotification({
        tenantId: input.tenantId,
        telegramChatId: input.telegramChatId,
        action: "request_remaining",
        studentName: input.studentName,
        enrollmentRef: input.enrollmentRef,
        classLevel: input.classLevel,
        statusUrl: input.statusUrl,
        paymentUrl: input.paymentUrl,
        adminNote: input.adminNote,
        receivedAmount: input.receivedAmount ?? null,
        remainingAmount: input.remainingAmount ?? null,
        currency: input.currency,
      }).catch((err) => {
        console.error("[dispatchPartialPaymentRequested] Telegram failed:", err);
      }),
    );
  }

  await Promise.allSettled(tasks);
}
