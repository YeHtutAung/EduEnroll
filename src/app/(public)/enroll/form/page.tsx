"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { formatMMK, formatMMKSimple } from "@/lib/utils";
import type { JlptLevel, ClassStatus } from "@/types/database";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClassInfo {
  id: string;
  level: JlptLevel;
  fee_mmk: number;
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
}

interface TenantLabels {
  intake: string;
  class: string;
  student: string;
  seat: string;
  fee: string;
  orgType: string;
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
}

// ─── Myanmar phone validation ────────────────────────────────────────────────

const MM_PHONE_RE = /^(?:\+?95|0)(9\d{7,9})$/;

function isValidMyanmarPhone(phone: string): boolean {
  return MM_PHONE_RE.test(phone.replace(/[\s\-().]/g, ""));
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

function StepIndicator({ step }: { step: 1 | 2 }) {
  return (
    <div className="mb-8 text-center">
      <p className="text-sm font-medium text-gray-500">
        Step {step} of 2 / <span className="font-myanmar">အဆင့် {toMM(String(step))}/၂</span>
      </p>
      <div className="mx-auto mt-3 flex max-w-xs gap-2">
        <div className={`h-1.5 flex-1 rounded-full ${step >= 1 ? "bg-[#1a6b3c]" : "bg-gray-200"}`} />
        <div className={`h-1.5 flex-1 rounded-full ${step >= 2 ? "bg-[#1a6b3c]" : "bg-gray-200"}`} />
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

function DynamicField({
  field,
  value,
  error,
  onChange,
}: {
  field: FormFieldDef;
  value: string;
  error?: string;
  onChange: (val: string) => void;
}) {
  const hasError = !!error;
  const cls = `${INPUT_BASE} ${hasError ? INPUT_ERROR : ""}`;

  let input: React.ReactNode;

  switch (field.field_type) {
    case "phone":
      input = (
        <input
          type="tel"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
          placeholder="09-xxxxxxxxx"
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
          placeholder={field.field_label}
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
      {input}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
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
  const quantity = Math.max(1, Number(searchParams.get("quantity")) || 1);
  const cartKey = searchParams.get("cart_key");
  const messengerPsid = searchParams.get("psid");

  // Cart state
  const [cartItems, setCartItems] = useState<
    { class_id: string; level: string; quantity: number; fee_mmk: number; image_url: string | null }[] | null
  >(null);

  // Data state
  const [intake, setIntake] = useState<IntakeInfo | null>(null);
  const [classInfo, setClassInfo] = useState<ClassInfo | null>(null);
  const [formFields, setFormFields] = useState<FormFieldDef[]>([]);
  const [labels, setLabels] = useState<TenantLabels | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  // Form state
  const [step, setStep] = useState<1 | 2>(1);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const [submitError, setSubmitError] = useState<{ en: string; mm: string } | null>(null);

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
    ? cartItems.reduce((sum, item) => sum + item.fee_mmk * item.quantity, 0)
    : 0;
  const cartTotalQty = isCartMode
    ? cartItems.reduce((sum, item) => sum + item.quantity, 0)
    : 0;

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
        setIntake(json.intake);
        if (json.labels) setLabels(json.labels);

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
            initial[f.field_key] = "";
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

    for (const field of formFields) {
      const val = (formData[field.field_key] ?? "").trim();

      if (field.is_required && !val) {
        errors[field.field_key] = `${field.field_label} is required.`;
        continue;
      }

      if (!val) continue;

      // Type-specific validation
      if (field.field_type === "phone" && !isValidMyanmarPhone(val)) {
        errors[field.field_key] = "Invalid Myanmar phone number (e.g. 09-xxxxxxxxx).";
      }
      if (field.field_key === "email" && field.field_type === "text" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
        errors[field.field_key] = "Invalid email address.";
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function handleNext() {
    if (validateStep1()) {
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

    // Build form_data from dynamic fields
    const dynamicData: Record<string, string> = {};
    for (const field of formFields) {
      const val = (formData[field.field_key] ?? "").trim();
      if (val) dynamicData[field.field_key] = val;
    }

    // Build payload based on mode
    const payload = isCartMode
      ? {
          items: cartItems.map((item) => ({ class_id: item.class_id, quantity: item.quantity })),
          form_data: dynamicData,
          idempotency_key: idempotencyKeyRef.current,
          ...(messengerPsid ? { messenger_psid: messengerPsid } : {}),
        }
      : {
          class_id: classInfo!.id,
          form_data: dynamicData,
          idempotency_key: idempotencyKeyRef.current,
          quantity,
          ...(messengerPsid ? { messenger_psid: messengerPsid } : {}),
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
          setSubmitError({
            en: body.message || "Enrollment failed. Please try again.",
            mm: "စာရင်းသွင်းမှု မအောင်မြင်ပါ။ ထပ်မံကြိုးစားပါ။",
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
  if (pageLoading) return <LoadingSkeleton />;

  if (pageError) {
    return (
      <ErrorPage
        message={pageError}
        onBack={slug ? () => router.push(`/enroll/${slug}`) : undefined}
      />
    );
  }

  if (!intake || (!classInfo && !isCartMode)) return null;

  const isEvent = labels?.orgType === "event";
  const intakeNameMM = isEvent ? null : getIntakeNameMM(intake.name, intake.year);

  // ── Step 1: Personal Information ─────────────────────────────
  if (step === 1) {
    return (
      <div className="mx-auto max-w-md">
        <StepIndicator step={1} />

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
                  <span className="font-medium text-gray-900">{formatMMKSimple(item.fee_mmk * item.quantity)}</span>
                </div>
              ))}
              <div className="border-t pt-2 flex justify-between font-semibold text-gray-900">
                <span>Total ({cartTotalQty} tickets)</span>
                <span>{formatMMKSimple(cartTotalFee)}</span>
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

        {/* Email/phone accuracy warning */}
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

        {/* Form fields */}
        <h2 className="mb-6 text-lg font-semibold text-gray-900">
          Personal Information / <span className="font-myanmar">ကိုယ်ရေးအချက်အလက်</span>
        </h2>

        {formFields.map((field) => (
          <DynamicField
            key={field.id}
            field={field}
            value={formData[field.field_key] ?? ""}
            error={fieldErrors[field.field_key]}
            onChange={(val) => updateField(field.field_key, val)}
          />
        ))}

        <button
          onClick={handleNext}
          className="mt-2 w-full rounded-lg bg-[#1a6b3c] py-3 text-sm font-semibold text-white hover:bg-[#155d33] transition-colors"
        >
          Next &rarr;
        </button>
      </div>
    );
  }

  // ── Step 2: Review & Confirm ─────────────────────────────────
  return (
    <div className="mx-auto max-w-md">
      <StepIndicator step={2} />

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
                <span className="font-medium text-gray-900">{formatMMKSimple(item.fee_mmk * item.quantity)}</span>
              </div>
            ))}
            <div className="border-t pt-2 mt-2 flex justify-between font-semibold text-gray-900">
              <span>Total ({cartTotalQty} tickets)</span>
              <span>{formatMMKSimple(cartTotalFee)}</span>
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
                  ? <>{classInfo.fee_formatted} &times; {quantity} = <span className="text-[#1a6b3c]">{formatMMK(classInfo.fee_mmk * quantity)}</span></>
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
          {formFields.map((field) => {
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
      </div>

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
          className="flex-1 rounded-lg bg-[#1a6b3c] py-3 text-sm font-semibold text-white hover:bg-[#155d33] transition-colors disabled:opacity-50"
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
  );
}
