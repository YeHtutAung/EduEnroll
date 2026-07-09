import { sendEmail, enrollmentConfirmationEmail } from "@/lib/email";
import { formatCurrencySimple, resolveEmailFromFormData } from "@/lib/utils";

interface TenantEmailConfig {
  name: string;
  org_type: string;
  logo_url: string | null;
  email_on_enroll: boolean;
  currency: string;
}

interface EnrollmentEmailParams {
  fd: Record<string, string> | null;
  enrollmentRef: string;
  classLevel: string;
  feeAmount: number;
  baseUrl: string;
  tenant: TenantEmailConfig;
}

/**
 * Sends enrollment confirmation email if:
 * - a recipient email can be resolved from form_data
 * - tenant has email_on_enroll enabled
 *
 * Fire-and-forget — errors are logged, not thrown.
 */
export function sendEnrollmentConfirmationEmail(params: EnrollmentEmailParams): void {
  const { fd, enrollmentRef, classLevel, feeAmount, baseUrl, tenant } = params;

  if (!tenant.email_on_enroll) return;

  const recipientEmail = resolveEmailFromFormData(fd);
  if (!recipientEmail) return;

  const emailData = enrollmentConfirmationEmail({
    studentName: fd?.name_en?.trim() || "Student",
    enrollmentRef,
    classLevel,
    feeAmount,
    feeFormatted: formatCurrencySimple(feeAmount, tenant.currency),
    paymentUrl: `${baseUrl}/enroll/payment/${enrollmentRef}`,
    statusUrl: `${baseUrl}/status?ref=${enrollmentRef}`,
    orgType: tenant.org_type,
    tenantName: tenant.name,
    logoUrl: tenant.logo_url ?? undefined,
  });

  sendEmail({ to: recipientEmail, ...emailData }).catch((err) => {
    console.error("[enrollment] Confirmation email failed:", err);
  });
}
