"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { formatCurrency, formatCurrencySimple } from "@/lib/utils";
import type { JlptLevel, ClassStatus } from "@/types/database";
import BrandHeader from "@/components/enrollment/BrandHeader";
import { randomId } from "@/lib/randomId";
import { computePlatformFee } from "@/server/payments/platformFee";
import TermsConsent from "@/components/enrollment/TermsConsent";
import { TERMS_VERSION } from "@/lib/legal/terms";
import { readableTextColor } from "@/lib/readableText";
import EmailTypoHint from "@/components/enrollment/EmailTypoHint";
import SizePicker from "@/components/enrollment/SizePicker";
import type { SizeNote } from "@/lib/enrollment/sizeChart";
import { emailBlockedFor, emailBlockedMessage, emailTypoToConfirm } from "@/lib/enrollment/emailAddress";
import AttendeeSection, { AttendeeTotals, type AttendeeCardSlot } from "@/components/enrollment/AttendeeSection";
import ProtectedNotice from "@/components/enroll/ProtectedNotice";
import ProtectedGate, { AccountEmailField } from "@/components/enroll/ProtectedGate";
import { currentSignInHref, resolveProtectedGate, type GateState } from "@/lib/enrollment/protectedGate";
import {
  attendeeFieldErrors,
  attendeeLabel,
  attendeeSlots,
  attendeesPayload,
  removeRunnerValues,
  slotKey,
} from "@/lib/enrollment/attendees";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClassInfo {
  id: string;
  level: JlptLevel;
  fee_amount: number;
  fee_formatted: string;
  seat_remaining: number;
  seat_total: number;
  enrollment_close_at: string | null;
  status: ClassStatus;
}

interface IntakeInfo {
  id: string;
  name: string;
  year: number;
  status: string;
  /** Account-bound tickets: buy signed in, email = the account's (Task 13). */
  ticket_protection?: boolean;
}

interface TenantLabels {
  intake: string;
  class: string;
  student: string;
  seat: string;
  fee: string;
  orgType: string;
  currency: string;
  paymentMode?: string;
  platformFeeMode?: string;
  platformFeeAmount?: number;
}

interface FormFieldDef {
  id: string;
  field_key: string;
  field_label: string;
  field_type: string;
  is_required: boolean;
  options: string[] | null;
  sort_order: number;
  is_default: boolean;
  /** Set by the API for an organiser's size field — see @/lib/enrollment/sizeChart. */
  size_chart_url?: string;
  size_note?: SizeNote;
  /** Asked once per ticket (runner) rather than once per order. */
  per_attendee?: boolean;
}

// ─── Phone validation (Myanmar + international) ─────────────────────────────

const MM_PHONE_RE = /^(?:\+?95|0)9\d{7,9}$/;
const INTL_PHONE_RE = /^\+[1-9]\d{6,14}$/;

function isValidPhone(phone: string): boolean {
  const cleaned = phone.replace(/[\s\-().]/g, "");
  return MM_PHONE_RE.test(cleaned) || INTL_PHONE_RE.test(cleaned);
}

// ─── Myanmar numerals ────────────────────────────────────────────────────────

const MM_DIGITS: Record<string, string> = {
  "0": "၀", "1": "၁", "2": "၂", "3": "၃", "4": "၄",
  "5": "၅", "6": "၆", "7": "၇", "8": "၈", "9": "၉",
};

function toMM(str: string): string {
  return str.replace(/[0-9]/g, (d) => MM_DIGITS[d]);
}

// ─── Month translations ──────────────────────────────────────────────────────

const MONTH_MM: Record<string, string> = {
  january: "ဇန်နဝါရီ", february: "ဖေဖော်ဝါရီ", march: "မတ်",
  april: "ဧပြီ", may: "မေ", june: "ဇွန်",
  july: "ဇူလိုင်", august: "ဩဂုတ်", september: "စက်တင်ဘာ",
  october: "အောက်တိုဘာ", november: "နိုဝင်ဘာ", december: "ဒီဇင်ဘာ",
};

function getIntakeNameMM(name: string, year: number): string {
  const lower = name.toLowerCase();
  for (const [en, mm] of Object.entries(MONTH_MM)) {
    if (lower.includes(en)) return `${mm} ${toMM(String(year))} သင်တန်း`;
  }
  return `${toMM(String(year))} သင်တန်း`;
}

// ─── Level badge colors ──────────────────────────────────────────────────────

const LEVEL_COLORS: Record<string, string> = {
  N5: "bg-emerald-100 text-emerald-800",
  N4: "bg-blue-100 text-blue-800",
  N3: "bg-purple-100 text-purple-800",
  N2: "bg-orange-100 text-orange-800",
  N1: "bg-red-100 text-red-800",
};
const DEFAULT_LEVEL_CLASS = "bg-gray-100 text-gray-800";

// ─── Step indicator ──────────────────────────────────────────────────────────

function StepIndicator({ step, color }: { step: 1 | 2; color?: string }) {
  const c = color ?? "#1a6b3c";
  return (
    <div className="mb-8 text-center">
      <p className="text-sm font-medium text-gray-500">
        Step {step} of 2 / <span className="font-myanmar">အဆင့် {toMM(String(step))}/၂</span>
      </p>
      <div className="mx-auto mt-3 flex max-w-xs gap-2">
        <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: step >= 1 ? c : "#e5e7eb" }} />
        <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: step >= 2 ? c : "#e5e7eb" }} />
      </div>
    </div>
  );
}

// ─── Loading skeleton ────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="mx-auto mb-8 h-5 w-40 rounded bg-gray-200" />
      <div className="mx-auto mb-6 h-20 max-w-md rounded-xl bg-gray-100" />
      <div className="mx-auto max-w-md space-y-5">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i}>
            <div className="mb-2 h-4 w-48 rounded bg-gray-200" />
            <div className="h-10 rounded-lg bg-gray-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Error page ──────────────────────────────────────────────────────────────

function ErrorPage({ message, onBack }: { message: string; onBack?: () => void }) {
  return (
    <div className="flex flex-col items-center py-20 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-50">
        <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <h2 className="mb-2 text-xl font-semibold text-gray-900">Something went wrong</h2>
      <p className="max-w-sm text-sm text-gray-500">{message}</p>
      {onBack && (
        <button
          onClick={onBack}
          className="mt-6 rounded-lg bg-[#1a6b3c] px-5 py-2 text-sm font-medium text-white hover:bg-[#155d33]"
        >
          Go Back
        </button>
      )}
    </div>
  );
}

// ─── Dynamic field renderer ──────────────────────────────────────────────────

const INPUT_BASE =
  "w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 " +
  "focus:border-[#1a6b3c] focus:outline-none focus:ring-1 focus:ring-[#1a6b3c]";
const INPUT_ERROR = "border-red-400 focus:border-red-500 focus:ring-red-500";

// ─── Field hints ──────────────────────────────────────────────────────────────

function getFieldHint(field: FormFieldDef): { en: string; mm?: string } | null {
  const key = field.field_key.toLowerCase();

  if (field.field_type === "phone") {
    return {
      en: "Myanmar or international format (+81, +66, etc.)",
      mm: "မြန်မာ သို့မဟုတ် နိုင်ငံတကာ ဖုန်းနံပါတ်",
    };
  }
  if (key === "email" || field.field_type === "email") {
    return {
      en: "We'll send your ticket and payment updates here",
      mm: "လက်မှတ်နှင့် ငွေပေးချေမှု အချက်အလက်များ ဤအီးမေးလ်သို့ ပို့ပါမည်",
    };
  }
  if (key === "name_en" || key === "student_name_en") {
    return { en: "Full name in English" };
  }
  if (key === "name_mm" || key === "student_name_mm") {
    return { en: "Full name in Myanmar", mm: "မြန်မာအမည် အပြည့်အစုံ" };
  }
  if (key === "nrc" || key === "nrc_number") {
    return { en: "e.g. 12/ThaGaKa(N)123456" };
  }
  return null;
}

function getFieldPlaceholder(field: FormFieldDef): string {
  const key = field.field_key.toLowerCase();
  if (field.field_type === "phone") return "09xxxxxxxxx";
  if (field.field_type === "email" || key === "email") return "yourname@gmail.com";
  if (key === "name_en" || key === "student_name_en") return "e.g. Aung Aung";
  if (key === "name_mm" || key === "student_name_mm") return "ဥပမာ - အောင်အောင်";
  if (key === "nrc" || key === "nrc_number") return "12/ThaGaKa(N)123456";
  return field.field_label;
}

function isEmailField(field: FormFieldDef): boolean {
  return field.field_type === "email" || (field.field_key === "email" && field.field_type === "text");
}

function DynamicField({
  field,
  value,
  error,
  onChange,
  lockedEmail = null,
}: {
  field: FormFieldDef;
  value: string;
  error?: string;
  onChange: (val: string) => void;
  /** A protected event's account email: the email field shows it, read-only. */
  lockedEmail?: string | null;
}) {
  const hasError = !!error;
  const cls = `${INPUT_BASE} ${hasError ? INPUT_ERROR : ""}`;
  const hint = getFieldHint(field);
  // Held back while typing, or "name@gmail.c" would be queried on its way to ".com".
  const [leftField, setLeftField] = useState(false);

  // An organiser's size field (e.g. The Beats Run's Jersey Size): size buttons
  // plus their size chart. Required-ness is still checked by validateStep1,
  // whose message shows below like any other field's.
  if (field.size_chart_url && field.options && field.options.length > 0) {
    return (
      <div className="mb-5">
        <SizePicker
          name={field.field_key}
          label={field.field_label}
          options={field.options}
          value={value}
          onChange={onChange}
          required={field.is_required}
          chartUrl={field.size_chart_url}
          note={field.size_note}
          labelClassName="text-sm font-medium text-gray-700"
          requiredMark={field.is_required && <span className="ml-1 text-red-500">*</span>}
        />
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  // Protected event: the order email is the account email, whatever is typed
  // (the server overwrites it), so the field shows it and can't change.
  if (lockedEmail !== null && isEmailField(field)) {
    return (
      <div className="mb-5">
        <label className="mb-1.5 block text-sm font-medium text-gray-700">{field.field_label}</label>
        <AccountEmailField email={lockedEmail} className={`${INPUT_BASE} bg-gray-50`} />
      </div>
    );
  }

  let input: React.ReactNode;

  switch (field.field_type) {
    case "phone":
      input = (
        <input
          type="tel"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
          placeholder={getFieldPlaceholder(field)}
        />
      );
      break;
    case "email":
      input = (
        <input
          type="email"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
          placeholder={getFieldPlaceholder(field)}
        />
      );
      break;
    case "date":
      input = (
        <input
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
        />
      );
      break;
    case "select":
      input = (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${cls} bg-white`}
        >
          <option value="">Select...</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );
      break;
    case "radio":
      input = (
        <div className="space-y-2 mt-1">
          {(field.options ?? []).map((opt) => (
            <label key={opt} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="radio"
                name={field.field_key}
                checked={value === opt}
                onChange={() => onChange(opt)}
                className="accent-[#1a6b3c] w-4 h-4"
              />
              {opt}
            </label>
          ))}
        </div>
      );
      break;
    case "checkbox":
      input = (
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={value === "true"}
            onChange={(e) => onChange(e.target.checked ? "true" : "")}
            className="accent-[#1a6b3c] w-4 h-4"
          />
          {field.field_label}
        </label>
      );
      break;
    case "address":
      input = (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className={`${cls} resize-none`}
          placeholder={field.field_label}
        />
      );
      break;
    case "file":
      input = (
        <input
          type="file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            onChange(file?.name ?? "");
          }}
          className={cls}
        />
      );
      break;
    default: // text
      input = (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${cls} ${field.field_label.toLowerCase().includes("myanmar") ? "font-myanmar" : ""}`}
          placeholder={getFieldPlaceholder(field)}
        />
      );
      break;
  }

  return (
    <div className="mb-5">
      {field.field_type !== "checkbox" && (
        <label className="mb-1.5 block text-sm font-medium text-gray-700">
          {field.field_label}
          {field.is_required && <span className="ml-1 text-red-500">*</span>}
        </label>
      )}
      <div onFocus={() => setLeftField(false)} onBlur={() => setLeftField(true)}>
        {input}
      </div>
      {leftField && isEmailField(field) && <EmailTypoHint value={value} onUse={onChange} />}
      {hint && !error && (
        <p className="mt-1 text-xs text-gray-400">
          {hint.en}
          {hint.mm && <span className="font-myanmar"> · {hint.mm}</span>}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

// ─── Page shell (module-level — must NOT be defined inside a component) ──────

function PageWrapper({
  schoolName,
  primaryColor,
  logoUrl,
  children,
}: {
  schoolName: string;
  primaryColor: string;
  logoUrl: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white">
      {schoolName && <BrandHeader schoolName={schoolName} primaryColor={primaryColor} logoUrl={logoUrl} />}
      <main className="mx-auto max-w-xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function EnrollmentFormPageWrapper() {
  return (
    <Suspense fallback={<LoadingSkeleton />}>
      <EnrollmentFormPage />
    </Suspense>
  );
}

function EnrollmentFormPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const classId = searchParams.get("class_id");
  const slug = searchParams.get("slug");
  // The buyer can still lower it here ("Remove" on a runner card) until the
  // order is created at Confirm Purchase.
  const [quantity, setQuantity] = useState(() => Math.max(1, Number(searchParams.get("quantity")) || 1));
  const cartKey = searchParams.get("cart_key");
  const messengerPsid = searchParams.get("psid");

  // Cart state
  const [cartItems, setCartItems] = useState<
    { class_id: string; level: string; quantity: number; fee_amount: number; image_url: string | null }[] | null
  >(null);
  // class_id -> pack_size, from the event's tiers. A "GA 3-Pack" cart line is
  // quantity 1 but three tickets, which the per_ticket fee preview must count
  // the way the payment routes do.
  const [packSizes, setPackSizes] = useState<Map<string, number>>(() => new Map());

  // Data state
  const [intake, setIntake] = useState<IntakeInfo | null>(null);
  const [classInfo, setClassInfo] = useState<ClassInfo | null>(null);
  const [formFields, setFormFields] = useState<FormFieldDef[]>([]);
  const [labels, setLabels] = useState<TenantLabels | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [primaryColor, setPrimaryColor] = useState("#1a6b3c");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [schoolName, setSchoolName] = useState("");
  // Protected event (account-bound tickets): settled before any field shows.
  // "open" for every other event, which renders exactly as before.
  const [gate, setGate] = useState<GateState>("open");
  const [accountEmail, setAccountEmail] = useState<string | null>(null);

  // Form state
  const [step, setStep] = useState<1 | 2>(1);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const emailTyposQueried = useRef(new Set<string>());
  const idempotencyKeyRef = useRef(randomId());
  const [submitError, setSubmitError] = useState<{ en: string; mm: string } | null>(null);

  // Terms of Sale consent. The organiser's rules and their fingerprint come
  // from the intake response; the fingerprint goes back with the order so the
  // server can refuse it if the rules changed while this page was open.
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsError, setTermsError] = useState(false);
  const [organiserTerms, setOrganiserTerms] = useState<string | null>(null);
  const [organiserTermsSha256, setOrganiserTermsSha256] = useState<string | null>(null);

  // Runner details: questions the organiser asks once per ticket. Keyed by
  // slotKey (class_id:seat_no), numbered like the tickets they end up on.
  const [runnerValues, setRunnerValues] = useState<Record<string, Record<string, string>>>({});
  const [runnerErrors, setRunnerErrors] = useState<Record<string, Record<string, string>>>({});
  const [openRunner, setOpenRunner] = useState<string | null>(null);

  // ── Read cart from sessionStorage ──────────────────────────────
  useEffect(() => {
    if (cartKey) {
      const stored = sessionStorage.getItem(cartKey);
      if (stored) {
        try {
          setCartItems(JSON.parse(stored));
        } catch {
          /* ignore */
        }
      }
    }
  }, [cartKey]);

  // Cart mode detection
  const isCartMode = cartItems !== null && cartItems.length > 0;
  const cartTotalFee = isCartMode
    ? cartItems.reduce((sum, item) => sum + item.fee_amount * item.quantity, 0)
    : 0;
  const cartTotalQty = isCartMode
    ? cartItems.reduce((sum, item) => sum + item.quantity * (packSizes.get(item.class_id) ?? 1), 0)
    : 0;

  // The same calculator the payment routes use, so the figure reviewed here is
  // the figure the gateway is sent. Computing it separately in the UI is how
  // the two drift apart.
  const platformFee = computePlatformFee(
    {
      payment_mode: labels?.paymentMode,
      platform_fee_mode: labels?.platformFeeMode,
      platform_fee_amount: labels?.platformFeeAmount,
    },
    cartTotalFee,
    cartTotalQty,
  );
  const grandTotal = cartTotalFee + platformFee;

  // Order fields are asked once (the buyer); runner fields once per ticket.
  const orderFields = formFields.filter((f) => !f.per_attendee);
  const runnerFields = formFields.filter((f) => f.per_attendee);
  const orderLines: { class_id: string; level: string; quantity: number }[] = isCartMode
    ? cartItems.map((i) => ({ class_id: i.class_id, level: i.level, quantity: i.quantity }))
    : classInfo
    ? [{ class_id: classInfo.id, level: classInfo.level, quantity }]
    : [];
  let runnerSlots: AttendeeCardSlot[] = [];
  if (runnerFields.length > 0) {
    const levelOf = new Map(orderLines.map((l) => [l.class_id, l.level]));
    try {
      runnerSlots = attendeeSlots(
        orderLines.map((l) => ({ class_id: l.class_id, admissions: l.quantity * (packSizes.get(l.class_id) ?? 1) })),
      ).map((slot) => ({ ...slot, tierLabel: levelOf.get(slot.class_id) ?? "Ticket" }));
    } catch {
      // More tickets than one order can carry runners for: the server refuses
      // it with a message, which the review step shows.
      runnerSlots = [];
    }
  }

  // ── Fetch intake + class + form fields ────────────────────────
  useEffect(() => {
    // For cart mode, we need slug but not classId
    if (!slug || (!classId && !cartKey)) {
      setPageError("Missing class or intake information. Please go back and select a class.");
      setPageLoading(false);
      return;
    }

    async function fetchData() {
      try {
        const res = await fetch(`/api/public/enroll/${slug}`);
        if (!res.ok) {
          setPageError("Could not load intake information.");
          return;
        }
        const json = await res.json();
        // A protected event asks who is signed in before showing any field.
        // An unprotected one makes no profile call.
        const gateResult = await resolveProtectedGate(json.intake?.ticket_protection === true);
        setGate(gateResult.state);
        setAccountEmail(gateResult.email);
        setIntake(json.intake);
        if (json.labels) setLabels(json.labels);
        if (json.appearance?.primary_color) setPrimaryColor(json.appearance.primary_color);
        if (json.appearance?.logo_url) setLogoUrl(json.appearance.logo_url);
        if (json.school_name) setSchoolName(json.school_name);
        setOrganiserTerms(json.organiser_terms ?? null);
        setOrganiserTermsSha256(json.organiser_terms_sha256 ?? null);
        setPackSizes(
          new Map(
            ((json.classes ?? []) as { id: string; pack_size?: number }[]).map((c) => [c.id, c.pack_size ?? 1]),
          ),
        );

        // For single-class mode, find the selected class
        if (classId && !cartKey) {
          const found = (json.classes as ClassInfo[]).find((c) => c.id === classId);
          if (!found) {
            setPageError("Class not found or no longer available.");
            return;
          }
          setClassInfo(found);
        }

        // Fetch form fields for this intake
        const fieldsRes = await fetch(`/api/public/form-fields?intake_id=${json.intake.id}`);
        if (fieldsRes.ok) {
          const fields = (await fieldsRes.json()) as FormFieldDef[];
          setFormFields(fields);
          // Initialize form data with empty values
          const initial: Record<string, string> = {};
          for (const f of fields) {
            initial[f.field_key] = gateResult.email && isEmailField(f) ? gateResult.email : "";
          }
          setFormData(initial);
        }
      } catch {
        setPageError("Failed to load. Please try again.");
      } finally {
        setPageLoading(false);
      }
    }
    fetchData();
  }, [classId, slug, cartKey]);

  // ── Validation ───────────────────────────────────────────────
  function validateStep1(): boolean {
    const errors: Record<string, string> = {};

    for (const field of orderFields) {
      const val = (formData[field.field_key] ?? "").trim();

      if (field.is_required && !val) {
        errors[field.field_key] = `${field.field_label} is required.`;
        continue;
      }

      if (!val) continue;

      // Type-specific validation
      if (field.field_type === "phone" && !isValidPhone(val)) {
        errors[field.field_key] = "Invalid phone number (e.g. 09xxxxxxxxx or +819xxxxxxxx).";
      }
      if (isEmailField(field)) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
          errors[field.field_key] = "Invalid email address.";
        } else if (emailBlockedFor(val)) {
          const blocked = emailBlockedMessage(emailBlockedFor(val)!);
          errors[field.field_key] = `${blocked.en} ${blocked.mm}`;
        } else if (!accountEmail) {
          // Not asked of the account email: the buyer can't change it.
          const suggestion = emailTypoToConfirm(val, emailTyposQueried.current);
          if (suggestion) {
            errors[field.field_key] =
              `Please check this email. Did you mean ${suggestion}? If ${val} is correct, press Next again.`;
          }
        }
      }
    }

    setFieldErrors(errors);

    const runnerProblems = attendeeFieldErrors(runnerValues, runnerSlots, runnerFields);
    setRunnerErrors(runnerProblems);
    const firstBad = runnerSlots.find((s) => runnerProblems[slotKey(s)]);
    if (firstBad) setOpenRunner(slotKey(firstBad));

    return Object.keys(errors).length === 0 && !firstBad;
  }

  // ── Remove a runner ──────────────────────────────────────────────────────
  // Nothing is reserved until Confirm Purchase, so dropping a ticket here is
  // only lowering a number: the tier's quantity goes down by one and that
  // runner's answers go, the later runners of the tier move up a seat with
  // theirs. A package tier sells whole packs, so its runners aren't removed
  // one by one; and the last ticket stays (go Back to leave).
  function canRemoveRunner(slot: AttendeeCardSlot): boolean {
    return runnerSlots.length > 1 && (packSizes.get(slot.class_id) ?? 1) === 1;
  }

  function removeRunner(slot: AttendeeCardSlot) {
    if (!canRemoveRunner(slot)) return;
    setRunnerValues((prev) => removeRunnerValues(prev, runnerSlots, slot));
    setRunnerErrors({});
    setOpenRunner(null);
    // A different order now: never let a retry replay the old one.
    idempotencyKeyRef.current = randomId();

    if (isCartMode) {
      const next = cartItems
        .map((item) => (item.class_id === slot.class_id ? { ...item, quantity: item.quantity - 1 } : item))
        .filter((item) => item.quantity > 0);
      setCartItems(next);
      // Kept in step, so a reload shows the same order.
      if (cartKey) {
        try {
          sessionStorage.setItem(cartKey, JSON.stringify(next));
        } catch {
          /* storage refused: the page still has the new cart */
        }
      }
    } else {
      const nextQty = Math.max(1, quantity - 1);
      setQuantity(nextQty);
      const url = new URL(window.location.href);
      url.searchParams.set("quantity", String(nextQty));
      window.history.replaceState(window.history.state, "", url.toString());
    }
  }

  function updateRunner(key: string, fieldKey: string, value: string) {
    setRunnerValues((prev) => ({ ...prev, [key]: { ...prev[key], [fieldKey]: value } }));
    if (runnerErrors[key]?.[fieldKey]) {
      setRunnerErrors((prev) => {
        const card = { ...prev[key] };
        delete card[fieldKey];
        const next = { ...prev };
        if (Object.keys(card).length > 0) next[key] = card;
        else delete next[key];
        return next;
      });
    }
  }

  function handleNext() {
    // Both checks run so every problem shows at once, not one per click.
    const fieldsOk = validateStep1();
    setTermsError(!termsAccepted);
    if (fieldsOk && termsAccepted) {
      setStep(2);
      setSubmitError(null);
    }
  }

  function handleBack() {
    setStep(1);
    setSubmitError(null);
  }

  // ── Submit enrollment ────────────────────────────────────────
  async function handleSubmit() {
    if ((!classInfo && !isCartMode) || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);

    // Build form_data from the order-level fields; runner answers go in
    // `attendees`, one entry per ticket.
    const dynamicData: Record<string, string> = {};
    for (const field of orderFields) {
      const val = (formData[field.field_key] ?? "").trim();
      if (val) dynamicData[field.field_key] = val;
    }

    // Include honeypot value (server rejects if filled)
    const hpValue = (formData.__hp ?? "").trim();

    // Priority-access token captured earlier from the URL fragment (see
    // `[slug]/page.tsx`) and stashed in sessionStorage, keyed per slug. Sent
    // only in this POST body — never as a query param or link href.
    const priorityToken = slug ? sessionStorage.getItem(`pa_${slug}`) : null;

    // What the buyer agreed to on step 1. Verified again by the server.
    const termsAcceptance = {
      terms_accepted: termsAccepted,
      terms_version: TERMS_VERSION,
      organiser_terms_sha256: organiserTermsSha256,
    };

    const runners =
      runnerFields.length > 0 ? { attendees: attendeesPayload(runnerValues, runnerSlots, runnerFields) } : {};

    // Build payload based on mode
    const payload = isCartMode
      ? {
          ...termsAcceptance,
          items: cartItems.map((item) => ({ class_id: item.class_id, quantity: item.quantity })),
          form_data: dynamicData,
          ...runners,
          idempotency_key: idempotencyKeyRef.current,
          ...(messengerPsid ? { messenger_psid: messengerPsid } : {}),
          ...(hpValue ? { __hp: hpValue } : {}),
          ...(priorityToken ? { priority_token: priorityToken } : {}),
        }
      : {
          ...termsAcceptance,
          class_id: classInfo!.id,
          form_data: dynamicData,
          ...runners,
          idempotency_key: idempotencyKeyRef.current,
          quantity,
          ...(messengerPsid ? { messenger_psid: messengerPsid } : {}),
          ...(hpValue ? { __hp: hpValue } : {}),
          ...(priorityToken ? { priority_token: priorityToken } : {}),
        };

    try {
      const res = await fetch("/api/public/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));

        if (body.error === "Class Full") {
          setSubmitError({
            en: "Sorry, this class just filled up. Please go back and choose another class.",
            mm: "ဤအတန်း နေရာပြည့်သွားပြီ။ နောက်သို့ပြန်သွားပြီး အခြားအတန်းကို ရွေးချယ်ပါ။",
          });
        } else if (body.error === "Class Unavailable") {
          setSubmitError({
            en: body.message || "This class is no longer accepting enrollments.",
            mm: body.message_mm || "ဤသင်တန်းအတွက် စာရင်းသွင်းမှု ပိတ်သိမ်းပြီးဖြစ်သည်။",
          });
        } else {
          // Includes TERMS_CHANGED / TERMS_REQUIRED, whose messages already
          // tell the buyer what to do, in both languages.
          setSubmitError({
            en: body.message || "Enrollment failed. Please try again.",
            mm: body.message_mm || "စာရင်းသွင်းမှု မအောင်မြင်ပါ။ ထပ်မံကြိုးစားပါ။",
          });
        }
        return;
      }

      const data = await res.json();

      // Clean up sessionStorage after successful submission
      if (cartKey) {
        sessionStorage.removeItem(cartKey);
      }

      router.push(`/enroll/payment/${data.enrollment_ref}`);
    } catch {
      setSubmitError({
        en: "Network error. Please check your connection and try again.",
        mm: "ကွန်ရက်ချိတ်ဆက်မှု မအောင်မြင်ပါ။ ထပ်မံကြိုးစားပါ။",
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // ── Input handler ────────────────────────────────────────────
  function updateField(key: string, value: string) {
    setFormData((prev) => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  // ── Render guards ────────────────────────────────────────────
  if (pageLoading) return <PageWrapper schoolName={schoolName} primaryColor={primaryColor} logoUrl={logoUrl}><LoadingSkeleton /></PageWrapper>;

  if (pageError) {
    return (
      <PageWrapper schoolName={schoolName} primaryColor={primaryColor} logoUrl={logoUrl}>
        <ErrorPage
          message={pageError}
          // The event page is tracked: a full page load, never a soft move.
          onBack={slug ? () => window.location.assign(`/enroll/${slug}`) : undefined}
        />
      </PageWrapper>
    );
  }

  if (!intake || (!classInfo && !isCartMode)) return null;

  // Protected event, and not (or not checkably) signed in as a buyer: the gate
  // replaces the form. The server refuses the order the same way (Task 12).
  if (gate !== "open" && gate !== "signedIn") {
    return (
      <PageWrapper schoolName={schoolName} primaryColor={primaryColor} logoUrl={logoUrl}>
        <ProtectedNotice className="mx-auto mb-6 max-w-md" />
        <ProtectedGate state={gate} next={currentSignInHref()} />
      </PageWrapper>
    );
  }
  const protectedNotice = gate === "signedIn" ? <ProtectedNotice className="mb-6" /> : null;

  const isEvent = labels?.orgType === "event";
  const intakeNameMM = isEvent ? null : getIntakeNameMM(intake.name, intake.year);

  // ── Step 1: Personal Information ─────────────────────────────
  if (step === 1) {
    return (
      <PageWrapper schoolName={schoolName} primaryColor={primaryColor} logoUrl={logoUrl}>
      <div className="mx-auto max-w-md">
        <StepIndicator step={1} color={primaryColor} />
        {protectedNotice}

        {/* Selected class/cart summary */}
        {isCartMode ? (
          <div className="mb-8 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="space-y-2">
              {cartItems.map((item, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${LEVEL_COLORS[item.level] ?? DEFAULT_LEVEL_CLASS}`}>
                      {item.level}
                    </span>
                    <span className="text-gray-600">x{item.quantity}</span>
                  </div>
                  <span className="font-medium text-gray-900">{formatCurrencySimple(item.fee_amount * item.quantity, labels?.currency ?? "MMK")}</span>
                </div>
              ))}
              {platformFee > 0 && (
                <div className="flex justify-between text-sm text-gray-700">
                  <span>Online Platform Fee / <span className="font-myanmar">အွန်လိုင်း ဝန်ဆောင်ခ</span></span>
                  <span className="font-medium text-gray-900">{formatCurrencySimple(platformFee, labels?.currency ?? "MMK")}</span>
                </div>
              )}
              <div className="border-t pt-2 flex justify-between font-semibold text-gray-900">
                <span>Total ({cartTotalQty} tickets)</span>
                <span>{formatCurrencySimple(grandTotal, labels?.currency ?? "MMK")}</span>
              </div>
            </div>
          </div>
        ) : classInfo ? (
          <div className="mb-8 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div className="flex items-center gap-3">
              <span className={`rounded-full px-3 py-1 text-sm font-bold ${LEVEL_COLORS[classInfo.level] ?? DEFAULT_LEVEL_CLASS}`}>
                {classInfo.level}
              </span>
              <div>
                <p className="font-myanmar text-lg font-semibold text-gray-900">
                  {classInfo.fee_formatted}
                </p>
                <p className="text-xs text-gray-500">{intake.name}</p>
              </div>
            </div>
          </div>
        ) : null}

        {/* Email/phone accuracy warning — only if form has required email or phone */}
        {formFields.some((f) =>
          (f.field_key === "email" || f.field_type === "phone") && f.is_required
        ) && (
          <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex gap-2">
              <svg className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="text-xs font-medium text-amber-800">
                  Please double-check your email address and phone number. We&apos;ll send payment status and ticket updates to this email. If incorrect, you won&apos;t receive any updates.
                </p>
                <p className="font-myanmar mt-1 text-xs text-amber-700">
                  သင့်အီးမေးလ်နှင့် ဖုန်းနံပါတ် မှန်ကန်ကြောင်း စစ်ဆေးပါ။ ငွေပေးချေမှုနှင့် လက်မှတ်သတင်းများကို ဤအီးမေးလ်သို့ ပို့ပေးပါမည်။
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Honeypot — hidden from real users, filled by bots */}
        <div aria-hidden="true" style={{ position: "absolute", left: "-9999px", top: "-9999px" }}>
          <label htmlFor="website_url">Website</label>
          <input
            id="website_url"
            name="website_url"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={formData.__hp ?? ""}
            onChange={(e) => updateField("__hp", e.target.value)}
          />
        </div>

        {/* Form fields */}
        <h2 className="mb-6 text-lg font-semibold text-gray-900">
          Personal Information / <span className="font-myanmar">ကိုယ်ရေးအချက်အလက်</span>
        </h2>

        {orderFields.map((field) => (
          <DynamicField
            key={field.id}
            field={field}
            value={formData[field.field_key] ?? ""}
            error={fieldErrors[field.field_key]}
            onChange={(val) => updateField(field.field_key, val)}
            lockedEmail={accountEmail}
          />
        ))}

        <AttendeeSection
          slots={runnerSlots}
          fields={runnerFields}
          values={runnerValues}
          errors={runnerErrors}
          openKey={openRunner ?? (runnerSlots[0] ? slotKey(runnerSlots[0]) : null)}
          onOpen={setOpenRunner}
          onChange={updateRunner}
          onRemove={removeRunner}
          canRemove={canRemoveRunner}
          accentColor={primaryColor}
          renderField={(field, value, onChange, error) => (
            <DynamicField field={field} value={value} error={error} onChange={onChange} />
          )}
        />

        <TermsConsent
          checked={termsAccepted}
          onChange={(value) => {
            setTermsAccepted(value);
            if (value) setTermsError(false);
          }}
          organiserTerms={organiserTerms}
          showError={termsError}
        />

        <button
          onClick={handleNext}
          className="mt-2 w-full rounded-lg py-3 text-sm font-semibold transition-colors"
          style={{ backgroundColor: primaryColor, color: readableTextColor(primaryColor) }}
        >
          Next &rarr;
        </button>
      </div>
      </PageWrapper>
    );
  }

  // ── Step 2: Review & Confirm ─────────────────────────────────
  const reviewEmailField = formFields.find(isEmailField);
  const reviewEmail = reviewEmailField ? (formData[reviewEmailField.field_key] ?? "").trim() : "";

  return (
    <PageWrapper schoolName={schoolName} primaryColor={primaryColor} logoUrl={logoUrl}>
    <div className="mx-auto max-w-md">
      <StepIndicator step={2} color={primaryColor} />
      {protectedNotice}

      <h2 className="mb-6 text-lg font-semibold text-gray-900">
        Review & Confirm / <span className="font-myanmar">ပြန်လည်စစ်ဆေးပြီး အတည်ပြုပါ</span>
      </h2>

      {/* Class/cart summary */}
      {isCartMode ? (
        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Order Summary</h3>
          <div className="space-y-2">
            {cartItems.map((item, i) => (
              <div key={i} className="flex justify-between text-sm text-gray-700">
                <span>{item.level} &times; {item.quantity}</span>
                <span className="font-medium text-gray-900">{formatCurrencySimple(item.fee_amount * item.quantity, labels?.currency ?? "MMK")}</span>
              </div>
            ))}
            {platformFee > 0 && (
              <div className="flex justify-between text-sm text-gray-700">
                <span>Online Platform Fee / <span className="font-myanmar">အွန်လိုင်း ဝန်ဆောင်ခ</span></span>
                <span className="font-medium text-gray-900">{formatCurrencySimple(platformFee, labels?.currency ?? "MMK")}</span>
              </div>
            )}
            <div className="border-t pt-2 mt-2 flex justify-between font-semibold text-gray-900">
              <span>Total ({cartTotalQty} tickets)</span>
              <span>{formatCurrencySimple(grandTotal, labels?.currency ?? "MMK")}</span>
            </div>
          </div>
        </div>
      ) : classInfo ? (
        <div className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-5">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {isEvent ? "Selected Ticket" : "Selected Class"}
          </h3>
          <div className="flex items-center gap-3">
            <span className={`rounded-full px-3 py-1 text-sm font-bold ${LEVEL_COLORS[classInfo.level] ?? DEFAULT_LEVEL_CLASS}`}>
              {classInfo.level}
            </span>
            <div>
              <p className="font-myanmar text-xl font-bold text-gray-900">
                {quantity > 1
                  ? <>{classInfo.fee_formatted} &times; {quantity} = <span className="text-[#1a6b3c]">{formatCurrency(classInfo.fee_amount * quantity, labels?.currency ?? "MMK")}</span></>
                  : classInfo.fee_formatted}
              </p>
              {quantity > 1 && (
                <p className="text-sm text-gray-500">
                  {quantity} ticket{quantity > 1 ? "s" : ""}
                </p>
              )}
              <p className="text-sm text-gray-500">
                {intake.name}{intakeNameMM && <> / <span className="font-myanmar">{intakeNameMM}</span></>}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* Student details summary */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Your Information
        </h3>
        <dl className="space-y-2.5 text-sm">
          {orderFields.map((field) => {
            const val = (formData[field.field_key] ?? "").trim();
            if (!val) return null;
            return (
              <div key={field.field_key} className="flex justify-between">
                <dt className="text-gray-500">{field.field_label}</dt>
                <dd className={`font-medium text-gray-900 ${field.field_label.toLowerCase().includes("myanmar") ? "font-myanmar" : ""}`}>
                  {field.field_type === "checkbox" ? (val === "true" ? "Yes" : "No") : val}
                </dd>
              </div>
            );
          })}
        </dl>
        {reviewEmail && (
          <div className="mt-4 rounded-lg bg-gray-50 p-3 text-sm">
            <p className="text-gray-600">
              We will send your confirmation to:
              <span className="font-myanmar block text-xs text-gray-500">အတည်ပြုချက်ကို ဤအီးမေးလ်သို့ ပို့ပေးပါမည်-</span>
            </p>
            <p className="mt-1 break-all text-base font-semibold text-gray-900">{reviewEmail}</p>
          </div>
        )}
      </div>

      {/* Runners: one line per ticket, then totals per size (choice) question */}
      {runnerFields.length > 0 && runnerSlots.length > 0 && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {runnerSlots.length === 1 ? "Runner" : "Runners"}
          </h3>
          <ol className="space-y-1.5 text-sm">
            {runnerSlots.map((slot, i) => (
              <li key={slotKey(slot)} className="flex justify-between gap-3">
                <span className="text-gray-500">
                  {runnerSlots.length > 1 ? `${i + 1}. ` : ""}{slot.tierLabel}
                </span>
                <span className="text-right font-medium text-gray-900">
                  {attendeeLabel(runnerValues[slotKey(slot)] ?? {}, runnerFields)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <AttendeeTotals fields={runnerFields} values={runnerValues} slots={runnerSlots} />

      {/* Error message */}
      {submitError && (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm">
          <p className="font-medium text-red-800">{submitError.en}</p>
          <p className="font-myanmar mt-1 text-red-700">{submitError.mm}</p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-3">
        <button
          onClick={handleBack}
          disabled={submitting}
          className="flex-1 rounded-lg border border-gray-300 bg-white py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          &larr; Back
        </button>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="flex-1 rounded-lg py-3 text-sm font-semibold transition-colors disabled:opacity-50"
          style={{ backgroundColor: primaryColor, color: readableTextColor(primaryColor) }}
        >
          {submitting ? (
            <span className="inline-flex items-center gap-2">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Submitting...
            </span>
          ) : (
            isEvent ? "Confirm Purchase" : <>Confirm / <span className="font-myanmar">စာရင်းသွင်းမည်</span></>
          )}
        </button>
      </div>
    </div>
    </PageWrapper>
  );
}
