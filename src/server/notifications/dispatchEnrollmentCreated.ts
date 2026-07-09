import { sendEnrollmentConfirmationEmail } from "@/server/enrollment/enrollmentEmails";

export interface EnrollmentCreatedInput {
  fd: Record<string, string> | null;
  enrollmentRef: string;
  classLevel: string;
  feeAmount: number;
  baseUrl: string;
  tenant: {
    name: string;
    org_type: string;
    logo_url: string | null;
    email_on_enroll: boolean;
    currency: string;
  };
}

/**
 * Dispatches enrollment-created notifications.
 * Currently a thin wrapper around sendEnrollmentConfirmationEmail.
 * Fire-and-forget — errors are logged by the underlying function, not thrown.
 */
export function dispatchEnrollmentCreated(params: EnrollmentCreatedInput): void {
  sendEnrollmentConfirmationEmail(params);
}
