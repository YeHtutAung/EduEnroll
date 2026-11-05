import type { EnrollmentStatus } from "@/types/database";

// ─── Order wording for event tenants ──────────────────────────────────────────
//
// Event tenants read orders. Everyone else keeps the wording these screens have
// always had, including when the tenant could not be read (a null org type).

interface Bilingual {
  en: string;
  mm: string;
}

const SHARED_STATUS_LABELS: Record<Exclude<EnrollmentStatus, "confirmed" | "rejected">, Bilingual> = {
  pending_payment: { en: "Awaiting Payment", mm: "ငွေပေးချေမှု စောင့်ဆိုင်းဆဲ" },
  payment_submitted: { en: "Payment Under Review", mm: "ငွေပေးချေမှု စစ်ဆေးနေဆဲ" },
  partial_payment: {
    en: "Partial Payment — Please Complete",
    mm: "ငွေတစ်စိတ်တစ်ပိုင်း — ကျန်ငွေ ပေးချေပါ",
  },
};

const SCHOOL_STATUS_LABELS: Record<EnrollmentStatus, Bilingual> = {
  ...SHARED_STATUS_LABELS,
  confirmed: { en: "Enrollment Confirmed", mm: "စာရင်းသွင်းမှု အတည်ပြုပြီး" },
  rejected: { en: "Enrollment Rejected", mm: "စာရင်းသွင်းမှု ငြင်းဆိုထားသည်" },
};

const EVENT_STATUS_LABELS: Record<EnrollmentStatus, Bilingual> = {
  ...SHARED_STATUS_LABELS,
  confirmed: { en: "Order Confirmed", mm: "အော်ဒါ အတည်ပြုပြီး" },
  rejected: { en: "Order Rejected", mm: "အော်ဒါ ငြင်းဆိုထားသည်" },
};

export function enrollmentStatusLabels(orgType: string | null | undefined): Record<EnrollmentStatus, Bilingual> {
  return orgType === "event" ? EVENT_STATUS_LABELS : SCHOOL_STATUS_LABELS;
}

export function statusNotFoundMessage(orgType: string | null | undefined): string {
  return orgType === "event"
    ? "No order found for this reference."
    : "No enrollment found for this reference.";
}

// ─── Payment page ─────────────────────────────────────────────────────────────

const SCHOOL_PAYMENT_COPY = {
  notFoundTitle: { en: "Enrollment Not Found", mm: "စာရင်းသွင်းမှု ရှာမတွေ့ပါ" },
  referenceLabel: "Enrollment Reference",
  reviewNote: {
    en: "We will review your payment and confirm your enrollment shortly.",
    mm: "သင့်ငွေပေးချေမှုကို စစ်ဆေးပြီး စာရင်းသွင်းမှုကို မကြာမီ အတည်ပြုပေးပါမည်။",
  },
  transferNotePrefix: "Use your enrollment ref",
  itemFallback: "Class",
};

const EVENT_PAYMENT_COPY: typeof SCHOOL_PAYMENT_COPY = {
  notFoundTitle: { en: "Order Not Found", mm: "အော်ဒါ ရှာမတွေ့ပါ" },
  referenceLabel: "Order Reference",
  reviewNote: {
    en: "We will review your payment and confirm your order shortly.",
    mm: "သင့်ငွေပေးချေမှုကို စစ်ဆေးပြီး အော်ဒါကို မကြာမီ အတည်ပြုပေးပါမည်။",
  },
  transferNotePrefix: "Use your order reference",
  itemFallback: "Ticket",
};

export function paymentPageCopy(orgType: string | null | undefined) {
  return orgType === "event" ? EVENT_PAYMENT_COPY : SCHOOL_PAYMENT_COPY;
}

// ─── /status lookup page ──────────────────────────────────────────────────────

export interface StatusLookupTenant {
  org_type?: string | null;
  label_student?: string | null;
}

export interface StatusLookupCopy {
  heading: Bilingual;
  referenceLabel: Bilingual;
  placeholder: string;
  personLabel: string;
}

const SCHOOL_LOOKUP_COPY: StatusLookupCopy = {
  heading: { en: "Check Your Enrollment Status", mm: "သင်၏ စာရင်းသွင်းမှု အခြေအနေ စစ်ဆေးရန်" },
  referenceLabel: { en: "Enrollment Reference", mm: "စာရင်းသွင်းမှု ရည်ညွှန်းကုဒ်" },
  placeholder: "NM-2026-XXXXX",
  personLabel: "Student",
};

const EVENT_LOOKUP_COPY: StatusLookupCopy = {
  heading: { en: "Check Your Order Status", mm: "သင်၏ အော်ဒါ အခြေအနေ စစ်ဆေးရန်" },
  referenceLabel: { en: "Order Reference", mm: "အော်ဒါ ရည်ညွှန်းကုဒ်" },
  placeholder: "Your order reference",
  personLabel: "Attendee",
};

export function statusLookupCopy(tenant: StatusLookupTenant | null): StatusLookupCopy {
  if (tenant?.org_type !== "event") return SCHOOL_LOOKUP_COPY;

  // "Student" is the column default from migration 024, which older events still hold.
  const label = tenant.label_student?.trim();
  return label && label.toLowerCase() !== "student"
    ? { ...EVENT_LOOKUP_COPY, personLabel: label }
    : EVENT_LOOKUP_COPY;
}
