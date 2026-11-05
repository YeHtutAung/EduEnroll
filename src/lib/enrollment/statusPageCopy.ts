// ─── Wording for the public status page ───────────────────────────────────────
//
// Event tenants read tickets and orders. Everyone else keeps the wording the page
// has always had, including org types with labels of their own, because this
// change is about event orders only.

export interface StatusPageTenant {
  org_type?: string | null;
  label_class?: string | null;
  label_fee?: string | null;
}

interface Bilingual {
  en: string;
  mm: string;
}

export interface StatusPageCopy {
  heading: Bilingual;
  lookupPrompt: Bilingual;
  firstStep: Bilingual;
  itemLabel: string;
  feeLabel: string;
  feeLabelMm: string;
  backLink: string;
  /** Replaces the API's status label. The API's other labels name only the payment. */
  statusLabels: Partial<Record<"confirmed" | "rejected", Bilingual>>;
  /** Replaces the API's 404 message, which says "enrollment". Null keeps it. */
  notFoundMessage: string | null;
  /** Used when a failed response carries no message of its own. */
  fallbackError: string;
}

const SCHOOL_COPY: StatusPageCopy = {
  heading: { en: "Enrollment Status", mm: "စာရင်းသွင်းမှု အခြေအနေ" },
  lookupPrompt: {
    en: "Enter your enrollment reference to check your status.",
    mm: "သင့်စာရင်းသွင်းမှု ရည်ညွှန်းကုဒ်ကို ထည့်သွင်းပါ။",
  },
  firstStep: { en: "Enrolled", mm: "စာရင်းသွင်းပြီး" },
  itemLabel: "Class Level",
  feeLabel: "Fee",
  feeLabelMm: "ကျောင်းလခ",
  backLink: "Back to Classes",
  statusLabels: {},
  notFoundMessage: null,
  fallbackError: "Enrollment not found.",
};

const EVENT_COPY: StatusPageCopy = {
  heading: { en: "Order Status", mm: "အော်ဒါ အခြေအနေ" },
  lookupPrompt: {
    en: "Enter your order reference to check your status.",
    mm: "သင့်အော်ဒါ ရည်ညွှန်းကုဒ်ကို ထည့်သွင်းပါ။",
  },
  firstStep: { en: "Ordered", mm: "အော်ဒါတင်ပြီး" },
  itemLabel: "Ticket",
  feeLabel: "Price",
  feeLabelMm: "စျေးနှုန်း",
  backLink: "Back to Tickets",
  statusLabels: {
    confirmed: { en: "Order Confirmed", mm: "အော်ဒါ အတည်ပြုပြီး" },
    rejected: { en: "Order Rejected", mm: "အော်ဒါ ငြင်းဆိုထားသည်" },
  },
  notFoundMessage: "No order found for this reference.",
  fallbackError: "Order not found.",
};

// Values nobody chose for a ticket: the column defaults from migration 024 and the
// school and fitness presets in /register. The event preset's own "Ticket Type" is
// a real label, but it also gives every event "Fee", so that one is treated as unset.
const UNSET_ITEM_LABELS = new Set(["class type", "level", "class"]);
const UNSET_FEE_LABELS = new Set(["fee"]);

function chosenLabel(label: string | null | undefined, unset: Set<string>): string | null {
  const trimmed = label?.trim();
  return trimmed && !unset.has(trimmed.toLowerCase()) ? trimmed : null;
}

export function statusPageCopy(tenant: StatusPageTenant | null): StatusPageCopy {
  if (tenant?.org_type !== "event") return SCHOOL_COPY;

  return {
    ...EVENT_COPY,
    itemLabel: chosenLabel(tenant.label_class, UNSET_ITEM_LABELS) ?? EVENT_COPY.itemLabel,
    feeLabel: chosenLabel(tenant.label_fee, UNSET_FEE_LABELS) ?? EVENT_COPY.feeLabel,
  };
}
