import { sendEmail, enrollmentApprovedEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { sendStatusNotification } from "@/lib/messenger/notify";
import { sendTelegramStatusNotification } from "@/lib/telegram/notify";
import { sendChannelInviteIfEligible } from "@/lib/telegram/channel-invite";

export interface ApprovalNotificationInput {
  tenantId: string;
  enrollmentId: string;
  enrollmentRef: string;
  studentName: string;
  classLevel: string;
  feeFormatted?: string;
  statusUrl: string;
  paymentUrl: string;
  currency: string;
  // Contact
  email?: string | null;
  phone?: string | null;
  messengerPsid?: string | null;
  telegramChatId?: string | null;
  classId?: string | null;
  // Tenant settings
  tenantName?: string;
  orgType?: string;
  logoUrl?: string;
  smsOnPayment?: boolean;
}

/**
 * Dispatches all approval notifications for a confirmed payment.
 * Runs all enabled channels concurrently (Promise.allSettled).
 * Errors in individual channels are logged but do not fail the dispatch.
 */
export async function dispatchPaymentApproved(input: ApprovalNotificationInput): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if (input.email) {
    const emailData = enrollmentApprovedEmail({
      studentName: input.studentName,
      enrollmentRef: input.enrollmentRef,
      classLevel: input.classLevel,
      statusUrl: input.statusUrl,
      feeFormatted: input.feeFormatted,
      orgType: input.orgType,
      tenantName: input.tenantName,
      logoUrl: input.logoUrl,
    });
    tasks.push(
      sendEmail({ to: input.email, ...emailData }).catch((err) => {
        console.error("[dispatchPaymentApproved] Email failed:", err);
      }),
    );
  }

  if (input.phone && input.smsOnPayment !== false) {
    tasks.push(
      sendSms({
        to: input.phone,
        message: `Hi ${input.studentName}, your payment for ${input.enrollmentRef} has been confirmed. Welcome to class!`,
        clientReference: input.enrollmentRef,
      }).catch((err) => {
        console.error("[dispatchPaymentApproved] SMS failed:", err);
      }),
    );
  }

  if (input.messengerPsid) {
    tasks.push(
      sendStatusNotification({
        tenantId: input.tenantId,
        messengerPsid: input.messengerPsid,
        action: "approve",
        studentName: input.studentName,
        enrollmentRef: input.enrollmentRef,
        classLevel: input.classLevel,
        statusUrl: input.statusUrl,
        paymentUrl: input.paymentUrl,
        currency: input.currency,
      }).catch((err) => {
        console.error("[dispatchPaymentApproved] Messenger failed:", err);
      }),
    );
  }

  if (input.telegramChatId) {
    tasks.push(
      sendTelegramStatusNotification({
        tenantId: input.tenantId,
        telegramChatId: input.telegramChatId,
        action: "approve",
        studentName: input.studentName,
        enrollmentRef: input.enrollmentRef,
        classLevel: input.classLevel,
        statusUrl: input.statusUrl,
        paymentUrl: input.paymentUrl,
        currency: input.currency,
      }).catch((err) => {
        console.error("[dispatchPaymentApproved] Telegram failed:", err);
      }),
    );

    tasks.push(
      sendChannelInviteIfEligible({
        tenantId: input.tenantId,
        enrollmentId: input.enrollmentId,
        classId: input.classId ?? null,
        telegramChatId: input.telegramChatId,
        studentName: input.studentName,
      }).catch((err) => {
        console.error("[dispatchPaymentApproved] Channel invite failed:", err);
      }),
    );
  }

  await Promise.allSettled(tasks);
}
