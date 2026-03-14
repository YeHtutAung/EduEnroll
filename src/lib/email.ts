// ─── Email configuration & sending via Resend ───────────────────────────────

import { Resend } from "resend";

export const FROM_EMAIL = process.env.FROM_EMAIL ?? "noreply@kuunyi.com";
export const EMAIL_FOOTER_URL = "https://www.kuunyi.com";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// ─── Send email helper ──────────────────────────────────────────────────────

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail({ to, subject, html }: SendEmailParams): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[email] RESEND_API_KEY not set — skipping email send.");
    return false;
  }

  try {
    const { error } = await getResend().emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      html,
    });

    if (error) {
      console.error("[email] Resend error:", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] Send failed:", err);
    return false;
  }
}

// ─── Org-aware labels ───────────────────────────────────────────────────────

type OrgType = "language_school" | "event" | "training_center";

interface OrgLabels {
  itemLabel: string;
  itemLabelMm: string;
  feeLabel: string;
  feeLabelMm: string;
  enrollLabel: string;
  enrollLabelMm: string;
  confirmedTitle: string;
  confirmedTitleMm: string;
  approvedTitle: string;
  approvedTitleMm: string;
  rejectedTitle: string;
  rejectedTitleMm: string;
  subjectPrefix: string;
  refLabel: string;
  contactLine: string;
  contactLineMm: string;
}

const ORG_LABELS: Record<OrgType, OrgLabels> = {
  language_school: {
    itemLabel: "Class Level",
    itemLabelMm: "အဆင့်",
    feeLabel: "Fee",
    feeLabelMm: "ကျောင်းလခ",
    enrollLabel: "Enrollment",
    enrollLabelMm: "စာရင်းသွင်းမှု",
    confirmedTitle: "Enrollment Successful!",
    confirmedTitleMm: "စာရင်းသွင်းမှု အောင်မြင်ပါသည်",
    approvedTitle: "Your Enrollment is Confirmed!",
    approvedTitleMm: "သင့်စာရင်းသွင်းမှု အတည်ပြုပြီးပါပြီ",
    rejectedTitle: "Enrollment Not Approved",
    rejectedTitleMm: "စာရင်းသွင်းမှု အတည်မပြုပါ",
    subjectPrefix: "Enrollment",
    refLabel: "Enrollment Reference",
    contactLine: "If you believe this is a mistake, please contact the school directly.",
    contactLineMm: "အမှားဖြစ်ပါက ကျောင်းသို့ တိုက်ရိုက်ဆက်သွယ်ပါ။",
  },
  event: {
    itemLabel: "Ticket",
    itemLabelMm: "လက်မှတ်",
    feeLabel: "Price",
    feeLabelMm: "စျေးနှုန်း",
    enrollLabel: "Order",
    enrollLabelMm: "အော်ဒါ",
    confirmedTitle: "Purchase Successful!",
    confirmedTitleMm: "ဝယ်ယူမှု အောင်မြင်ပါသည်",
    approvedTitle: "Your Order is Confirmed!",
    approvedTitleMm: "သင့်အော်ဒါ အတည်ပြုပြီးပါပြီ",
    rejectedTitle: "Order Not Approved",
    rejectedTitleMm: "အော်ဒါ အတည်မပြုပါ",
    subjectPrefix: "Order",
    refLabel: "Order Reference",
    contactLine: "If you believe this is a mistake, please contact us directly.",
    contactLineMm: "အမှားဖြစ်ပါက တိုက်ရိုက်ဆက်သွယ်ပါ။",
  },
  training_center: {
    itemLabel: "Course",
    itemLabelMm: "သင်တန်း",
    feeLabel: "Fee",
    feeLabelMm: "သင်တန်းကြေး",
    enrollLabel: "Enrollment",
    enrollLabelMm: "စာရင်းသွင်းမှု",
    confirmedTitle: "Enrollment Successful!",
    confirmedTitleMm: "စာရင်းသွင်းမှု အောင်မြင်ပါသည်",
    approvedTitle: "Your Enrollment is Confirmed!",
    approvedTitleMm: "သင့်စာရင်းသွင်းမှု အတည်ပြုပြီးပါပြီ",
    rejectedTitle: "Enrollment Not Approved",
    rejectedTitleMm: "စာရင်းသွင်းမှု အတည်မပြုပါ",
    subjectPrefix: "Enrollment",
    refLabel: "Enrollment Reference",
    contactLine: "If you believe this is a mistake, please contact us directly.",
    contactLineMm: "အမှားဖြစ်ပါက တိုက်ရိုက်ဆက်သွယ်ပါ။",
  },
};

function getLabels(orgType?: string): OrgLabels {
  return ORG_LABELS[(orgType as OrgType)] ?? ORG_LABELS.language_school;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const mmDigits: Record<string, string> = {
  "0": "၀", "1": "၁", "2": "၂", "3": "၃", "4": "၄",
  "5": "၅", "6": "၆", "7": "၇", "8": "၈", "9": "၉",
};

function toMmFee(amount: number): string {
  return String(amount)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    .replace(/[0-9]/g, (d) => mmDigits[d]);
}

/** Clean class level display: "Madness Zone - Day 4 x1" → "Madness Zone - Day 4" */
function cleanClassLevel(level: string): string {
  return level.replace(/\s*x1$/i, "").trim();
}

// ─── Email templates ────────────────────────────────────────────────────────

function baseLayout(content: string, tenantName?: string): string {
  const brandHeader = tenantName
    ? `<p style="text-align: center; font-size: 13px; font-weight: 600; color: #6b7280; letter-spacing: 0.5px; margin: 0 0 20px; text-transform: uppercase;">${tenantName}</p>`
    : "";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; color: #1a1a1a; }
    .container { max-width: 520px; margin: 0 auto; padding: 32px 20px; }
    .card { background: #ffffff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .header { text-align: center; margin-bottom: 24px; }
    .ref-box { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; text-align: center; margin: 20px 0; }
    .ref-code { font-family: 'JetBrains Mono', monospace; font-size: 24px; font-weight: 700; color: #1a6b3c; letter-spacing: 1px; }
    .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
    .info-label { color: #6b7280; min-width: 100px; }
    .info-value { font-weight: 600; color: #1f2937; text-align: right; }
    .btn { display: inline-block; padding: 12px 28px; background: #1a6b3c; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; }
    .btn-outline { display: inline-block; padding: 10px 24px; border: 1px solid #d1d5db; color: #374151; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; }
    .footer { text-align: center; margin-top: 24px; font-size: 12px; color: #9ca3af; }
    .myanmar { font-family: 'Noto Sans Myanmar', sans-serif; }
    .alert-box { border-radius: 8px; padding: 16px; margin: 20px 0; }
    .alert-green { background: #f0fdf4; border: 1px solid #bbf7d0; }
    .alert-red { background: #fef2f2; border: 1px solid #fecaca; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      ${brandHeader}
      ${content}
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} Powered by <a href="${EMAIL_FOOTER_URL}" style="color: #1a3f8a;">KuuNyi</a></p>
    </div>
  </div>
</body>
</html>`;
}

// ── Enrollment confirmation email (sent after successful enrollment) ─────────

export function enrollmentConfirmationEmail(params: {
  studentName: string;
  enrollmentRef: string;
  classLevel: string;
  feeMmk: number;
  feeFormatted: string;
  paymentUrl: string;
  statusUrl: string;
  orgType?: string;
  tenantName?: string;
}): { subject: string; html: string } {
  const { studentName, enrollmentRef, classLevel, feeMmk, feeFormatted, paymentUrl, statusUrl, orgType, tenantName } = params;
  const l = getLabels(orgType);
  const displayLevel = cleanClassLevel(classLevel);
  const feeMm = toMmFee(feeMmk);

  return {
    subject: `${l.subjectPrefix} Confirmed — ${enrollmentRef}`,
    html: baseLayout(`
      <div class="header">
        <div style="width: 56px; height: 56px; border-radius: 50%; background: #dcfce7; margin: 0 auto 12px; display: flex; align-items: center; justify-content: center;">
          <span style="font-size: 28px;">✓</span>
        </div>
        <h1 style="margin: 0; font-size: 22px; color: #1a1a1a;">${l.confirmedTitle}</h1>
        <p class="myanmar" style="margin: 4px 0 0; color: #6b7280;">${l.confirmedTitleMm}</p>
      </div>

      <p style="font-size: 14px; color: #374151;">
        Hi <strong>${studentName}</strong>, your ${l.enrollLabel.toLowerCase()} has been registered successfully.
      </p>

      <div class="ref-box">
        <p style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #1a6b3c; margin: 0 0 8px;">${l.refLabel}</p>
        <p class="ref-code" style="margin: 0;">${enrollmentRef}</p>
      </div>

      <div style="margin: 20px 0;">
        <div class="info-row">
          <span class="info-label">${l.itemLabel}</span>
          <span class="info-value">${displayLevel}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${l.feeLabel}</span>
          <span class="info-value">${feeFormatted}</span>
        </div>
        <div class="info-row" style="border-bottom: none;">
          <span class="info-label myanmar">${l.feeLabelMm}</span>
          <span class="info-value myanmar">${feeMm} ကျပ်</span>
        </div>
      </div>

      <div style="text-align: center; margin: 28px 0 16px;">
        <a href="${paymentUrl}" class="btn">Upload Payment Proof</a>
      </div>
      <div style="text-align: center;">
        <a href="${statusUrl}" class="btn-outline">Check Status</a>
      </div>

      <p style="margin-top: 24px; font-size: 13px; color: #6b7280; text-align: center;">
        Please make your payment and upload the transfer screenshot to complete your ${l.enrollLabel.toLowerCase()}.
      </p>
      <p class="myanmar" style="font-size: 13px; color: #9ca3af; text-align: center;">
        ငွေပေးချေပြီး ငွေလွှဲပြေစာကို တင်သွင်းပေးပါ။
      </p>
    `, tenantName),
  };
}

// ── Enrollment approved email ───────────────────────────────────────────────

export function enrollmentApprovedEmail(params: {
  studentName: string;
  enrollmentRef: string;
  classLevel: string;
  statusUrl: string;
  feeFormatted?: string;
  orgType?: string;
  tenantName?: string;
}): { subject: string; html: string } {
  const { studentName, enrollmentRef, classLevel, statusUrl, feeFormatted, orgType, tenantName } = params;
  const l = getLabels(orgType);
  const displayLevel = cleanClassLevel(classLevel);

  const feeRow = feeFormatted
    ? `<div class="info-row" style="border-bottom: none;">
        <span class="info-label">${l.feeLabel}</span>
        <span class="info-value">${feeFormatted}</span>
      </div>`
    : "";

  return {
    subject: `${l.subjectPrefix} Approved — ${enrollmentRef}`,
    html: baseLayout(`
      <div class="header">
        <div style="width: 56px; height: 56px; border-radius: 50%; background: #dcfce7; margin: 0 auto 12px; display: flex; align-items: center; justify-content: center;">
          <span style="font-size: 28px;">🎉</span>
        </div>
        <h1 style="margin: 0; font-size: 22px; color: #1a6b3c;">${l.approvedTitle}</h1>
        <p class="myanmar" style="margin: 4px 0 0; color: #6b7280;">${l.approvedTitleMm}</p>
      </div>

      <div class="alert-box alert-green">
        <p style="margin: 0; font-size: 14px; color: #166534;">
          <strong>${studentName}</strong>, your payment has been verified and your ${l.enrollLabel.toLowerCase()} for <strong>${displayLevel}</strong> is now confirmed.
        </p>
        <p class="myanmar" style="margin: 8px 0 0; font-size: 13px; color: #15803d;">
          သင့်ငွေပေးချေမှု အတည်ပြုပြီးဖြစ်ပြီး ${displayLevel} ${l.enrollLabelMm} အတည်ပြုပြီးပါပြီ။
        </p>
      </div>

      <div style="margin: 20px 0;">
        <div class="info-row">
          <span class="info-label">Reference</span>
          <span class="info-value" style="font-family: monospace;">${enrollmentRef}</span>
        </div>
        <div class="info-row">
          <span class="info-label">${l.itemLabel}</span>
          <span class="info-value">${displayLevel}</span>
        </div>
        ${feeRow}
      </div>

      <div style="text-align: center; margin: 24px 0;">
        <a href="${statusUrl}" class="btn">View ${l.enrollLabel} Details</a>
      </div>
    `, tenantName),
  };
}

// ── Partial payment email ────────────────────────────────────────────────────

export function partialPaymentEmail(params: {
  studentName: string;
  enrollmentRef: string;
  classLevel: string;
  totalAmount: number;
  receivedAmount: number | null;
  remainingAmount: number | null;
  adminNote: string;
  paymentUrl: string;
  statusUrl: string;
  orgType?: string;
  tenantName?: string;
}): { subject: string; html: string } {
  const { studentName, enrollmentRef, classLevel, totalAmount, receivedAmount, remainingAmount, adminNote, paymentUrl, statusUrl, orgType, tenantName } = params;
  const l = getLabels(orgType);
  const displayLevel = cleanClassLevel(classLevel);

  const fmtMmk = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  const receivedLine = receivedAmount != null
    ? `<div class="info-row">
        <span class="info-label">Received</span>
        <span class="info-value" style="color: #1a6b3c;">${fmtMmk(receivedAmount)} MMK</span>
      </div>`
    : "";

  const remainingLine = remainingAmount != null && remainingAmount > 0
    ? `<div class="info-row" style="border-bottom: none;">
        <span class="info-label">Remaining</span>
        <span class="info-value" style="color: #c0392b; font-weight: 700;">${fmtMmk(remainingAmount)} MMK</span>
      </div>`
    : "";

  return {
    subject: `Action Required: Complete Payment — ${enrollmentRef}`,
    html: baseLayout(`
      <div class="header">
        <div style="width: 56px; height: 56px; border-radius: 50%; background: #fef3c7; margin: 0 auto 12px; display: flex; align-items: center; justify-content: center;">
          <span style="font-size: 28px;">💰</span>
        </div>
        <h1 style="margin: 0; font-size: 22px; color: #92400e;">Partial Payment Received</h1>
        <p class="myanmar" style="margin: 4px 0 0; color: #6b7280;">ငွေတစ်စိတ်တစ်ပိုင်း လက်ခံရရှိပြီး</p>
      </div>

      <div class="alert-box" style="background: #fffbeb; border: 1px solid #fde68a;">
        <p style="margin: 0; font-size: 14px; color: #92400e;">
          <strong>${studentName}</strong>, we have received a partial payment for your ${displayLevel} ${l.enrollLabel.toLowerCase()}. Please complete the remaining payment to confirm your spot.
        </p>
        <p class="myanmar" style="margin: 8px 0 0; font-size: 13px; color: #a16207;">
          ${displayLevel} ${l.enrollLabelMm}အတွက် ငွေတစ်စိတ်တစ်ပိုင်း လက်ခံရရှိပြီးပါပြီ။ သင့်နေရာ အတည်ပြုရန် ကျန်ငွေကို ပေးချေပါ။
        </p>
      </div>

      <div style="margin: 20px 0;">
        <div class="info-row">
          <span class="info-label">Reference</span>
          <span class="info-value" style="font-family: monospace;">${enrollmentRef}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Total Amount</span>
          <span class="info-value">${fmtMmk(totalAmount)} MMK</span>
        </div>
        ${receivedLine}
        ${remainingLine}
      </div>

      ${adminNote ? `
      <div style="background: #f9fafb; border-radius: 8px; padding: 12px 16px; margin: 16px 0;">
        <p style="margin: 0 0 4px; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Message from admin</p>
        <p style="margin: 0; font-size: 14px; color: #374151;">${adminNote}</p>
      </div>` : ""}

      <div style="text-align: center; margin: 28px 0 16px;">
        <a href="${paymentUrl}" class="btn" style="background: #b07d2a;">Upload Remaining Payment Proof</a>
      </div>
      <div style="text-align: center;">
        <a href="${statusUrl}" class="btn-outline">Check Status</a>
      </div>

      <p style="margin-top: 24px; font-size: 13px; color: #6b7280; text-align: center;">
        Please transfer the remaining amount and upload the receipt screenshot.
      </p>
      <p class="myanmar" style="font-size: 13px; color: #9ca3af; text-align: center;">
        ကျန်ငွေကို လွှဲပေးပြီး ငွေလွှဲပြေစာကို တင်သွင်းပါ။
      </p>
    `, tenantName),
  };
}

// ── Enrollment rejected email ───────────────────────────────────────────────

export function enrollmentRejectedEmail(params: {
  studentName: string;
  enrollmentRef: string;
  classLevel: string;
  reason?: string | null;
  statusUrl: string;
  orgType?: string;
  tenantName?: string;
}): { subject: string; html: string } {
  const { studentName, enrollmentRef, classLevel, reason, statusUrl, orgType, tenantName } = params;
  const l = getLabels(orgType);
  const displayLevel = cleanClassLevel(classLevel);

  return {
    subject: `${l.subjectPrefix} Update — ${enrollmentRef}`,
    html: baseLayout(`
      <div class="header">
        <div style="width: 56px; height: 56px; border-radius: 50%; background: #fee2e2; margin: 0 auto 12px; display: flex; align-items: center; justify-content: center;">
          <span style="font-size: 28px;">⚠️</span>
        </div>
        <h1 style="margin: 0; font-size: 22px; color: #991b1b;">${l.rejectedTitle}</h1>
        <p class="myanmar" style="margin: 4px 0 0; color: #6b7280;">${l.rejectedTitleMm}</p>
      </div>

      <div class="alert-box alert-red">
        <p style="margin: 0; font-size: 14px; color: #991b1b;">
          <strong>${studentName}</strong>, your ${l.enrollLabel.toLowerCase()} for <strong>${displayLevel}</strong> (${enrollmentRef}) was not approved.
        </p>
        ${reason ? `
        <p style="margin: 12px 0 0; font-size: 13px; color: #7f1d1d;">
          <strong>Reason:</strong> ${reason}
        </p>` : ""}
        <p class="myanmar" style="margin: 8px 0 0; font-size: 13px; color: #b91c1c;">
          သင့် ${displayLevel} ${l.enrollLabelMm}ကို အတည်မပြုပါ။
        </p>
      </div>

      <p style="font-size: 14px; color: #374151;">
        ${l.contactLine}
      </p>
      <p class="myanmar" style="font-size: 13px; color: #6b7280;">
        ${l.contactLineMm}
      </p>

      <div style="text-align: center; margin: 24px 0;">
        <a href="${statusUrl}" class="btn-outline">View Details</a>
      </div>
    `, tenantName),
  };
}
