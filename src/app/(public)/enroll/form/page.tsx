"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { formatMMK } from "@/lib/utils";
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

interface FormData {
  student_name_en: string;
  student_name_mm: string;
  nrc_number: string;
  phone: string;
  email: string;
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

const LEVEL_COLORS: Record<JlptLevel, string> = {
  N5: "bg-emerald-100 text-emerald-800",
  N4: "bg-blue-100 text-blue-800",
  N3: "bg-purple-100 text-purple-800",
  N2: "bg-orange-100 text-orange-800",
  N1: "bg-red-100 text-red-800",
};

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

// ─── Form field wrapper ──────────────────────────────────────────────────────

function Field({
  label,
  labelMM,
  required,
  error,
  children,
}: {
  label: string;
  labelMM: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="mb-1.5 block text-sm font-medium text-gray-700">
        {label} / <span className="font-myanmar">{labelMM}</span>
        {required && <span className="ml-1 text-red-500">*</span>}
      </label>
      {children}
      {error && (
        <p className="mt-1 text-xs text-red-600">{error}</p>
      )}
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

// ─── Main page ───────────────────────────────────────────────────────────────

export default function EnrollmentFormPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const classId = searchParams.get("class_id");
  const slug = searchParams.get("slug");

  // Data state
  const [intake, setIntake] = useState<IntakeInfo | null>(null);
  const [classInfo, setClassInfo] = useState<ClassInfo | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  // Form state
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState<FormData>({
    student_name_en: "",
    student_name_mm: "",
    nrc_number: "",
    phone: "",
    email: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormData, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ en: string; mm: string } | null>(null);

  // ── Fetch intake + class info ────────────────────────────────
  useEffect(() => {
    if (!classId || !slug) {
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

        const found = (json.classes as ClassInfo[]).find((c) => c.id === classId);
        if (!found) {
          setPageError("Class not found or no longer available.");
          return;
        }
        setClassInfo(found);
      } catch {
        setPageError("Failed to load. Please try again.");
      } finally {
        setPageLoading(false);
      }
    }
    fetchData();
  }, [classId, slug]);

  // ── Validation ───────────────────────────────────────────────
  function validateStep1(): boolean {
    const errors: Partial<Record<keyof FormData, string>> = {};

    if (!form.student_name_en.trim()) {
      errors.student_name_en = "English name is required.";
    }
    if (!form.student_name_mm.trim()) {
      errors.student_name_mm = "Myanmar name is required.";
    }
    if (!form.nrc_number.trim()) {
      errors.nrc_number = "NRC number is required.";
    }
    if (!form.phone.trim()) {
      errors.phone = "Phone number is required.";
    } else if (!isValidMyanmarPhone(form.phone)) {
      errors.phone = "Invalid Myanmar phone number (e.g. 09-xxxxxxxxx).";
    }
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errors.email = "Invalid email address.";
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
    if (!classInfo) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch("/api/public/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          class_id: classInfo.id,
          student_name_en: form.student_name_en.trim(),
          student_name_mm: form.student_name_mm.trim() || null,
          nrc_number: form.nrc_number.trim() || null,
          phone: form.phone.trim(),
          email: form.email.trim() || null,
        }),
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
      router.push(`/enroll/payment/${data.enrollment_ref}`);
    } catch {
      setSubmitError({
        en: "Network error. Please check your connection and try again.",
        mm: "ကွန်ရက်ချိတ်ဆက်မှု မအောင်မြင်ပါ။ ထပ်မံကြိုးစားပါ။",
      });
    } finally {
      setSubmitting(false);
    }
  }

  // ── Input handler ────────────────────────────────────────────
  function updateField(field: keyof FormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (fieldErrors[field]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[field];
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

  if (!intake || !classInfo) return null;

  const intakeNameMM = getIntakeNameMM(intake.name, intake.year);
  const inputBase =
    "w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 " +
    "focus:border-[#1a6b3c] focus:outline-none focus:ring-1 focus:ring-[#1a6b3c]";
  const inputError = "border-red-400 focus:border-red-500 focus:ring-red-500";

  // ── Step 1: Personal Information ─────────────────────────────
  if (step === 1) {
    return (
      <div className="mx-auto max-w-md">
        <StepIndicator step={1} />

        {/* Selected class summary */}
        <div className="mb-8 rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="flex items-center gap-3">
            <span className={`rounded-full px-3 py-1 text-sm font-bold ${LEVEL_COLORS[classInfo.level]}`}>
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

        {/* Form fields */}
        <h2 className="mb-6 text-lg font-semibold text-gray-900">
          Personal Information / <span className="font-myanmar">ကိုယ်ရေးအချက်အလက်</span>
        </h2>

        <Field label="Full Name (English)" labelMM="အမည် (အင်္ဂလိပ်)" required error={fieldErrors.student_name_en}>
          <input
            type="text"
            value={form.student_name_en}
            onChange={(e) => updateField("student_name_en", e.target.value)}
            className={`${inputBase} ${fieldErrors.student_name_en ? inputError : ""}`}
            placeholder="e.g. Mg Mg"
          />
        </Field>

        <Field label="Full Name (Myanmar)" labelMM="အမည် (မြန်မာ)" required error={fieldErrors.student_name_mm}>
          <input
            type="text"
            value={form.student_name_mm}
            onChange={(e) => updateField("student_name_mm", e.target.value)}
            className={`font-myanmar ${inputBase} ${fieldErrors.student_name_mm ? inputError : ""}`}
            placeholder="ဥပမာ - မောင်မောင်"
          />
        </Field>

        <Field label="NRC Number" labelMM="မှတ်ပုံတင်နံပါတ်" required error={fieldErrors.nrc_number}>
          <input
            type="text"
            value={form.nrc_number}
            onChange={(e) => updateField("nrc_number", e.target.value)}
            className={`${inputBase} ${fieldErrors.nrc_number ? inputError : ""}`}
            placeholder="12/OuKaMa(N)123456"
          />
        </Field>

        <Field label="Phone" labelMM="ဖုန်းနံပါတ်" required error={fieldErrors.phone}>
          <input
            type="tel"
            value={form.phone}
            onChange={(e) => updateField("phone", e.target.value)}
            className={`${inputBase} ${fieldErrors.phone ? inputError : ""}`}
            placeholder="09-xxxxxxxxx"
          />
        </Field>

        <Field label="Email (Optional)" labelMM="အီးမေးလ် (မဖြစ်မနေမလို)" error={fieldErrors.email}>
          <input
            type="email"
            value={form.email}
            onChange={(e) => updateField("email", e.target.value)}
            className={`${inputBase} ${fieldErrors.email ? inputError : ""}`}
            placeholder="example@email.com"
          />
        </Field>

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

      {/* Class summary */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-5">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Selected Class
        </h3>
        <div className="flex items-center gap-3">
          <span className={`rounded-full px-3 py-1 text-sm font-bold ${LEVEL_COLORS[classInfo.level]}`}>
            {classInfo.level}
          </span>
          <div>
            <p className="font-myanmar text-xl font-bold text-gray-900">{classInfo.fee_formatted}</p>
            <p className="text-sm text-gray-500">
              {intake.name} / <span className="font-myanmar">{intakeNameMM}</span>
            </p>
          </div>
        </div>
      </div>

      {/* Student details summary */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Your Information
        </h3>
        <dl className="space-y-2.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-500">Name (English)</dt>
            <dd className="font-medium text-gray-900">{form.student_name_en}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Name (Myanmar)</dt>
            <dd className="font-myanmar font-medium text-gray-900">{form.student_name_mm}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">NRC</dt>
            <dd className="font-medium text-gray-900">{form.nrc_number}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-gray-500">Phone</dt>
            <dd className="font-medium text-gray-900">{form.phone}</dd>
          </div>
          {form.email && (
            <div className="flex justify-between">
              <dt className="text-gray-500">Email</dt>
              <dd className="font-medium text-gray-900">{form.email}</dd>
            </div>
          )}
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
            <>
              Confirm / <span className="font-myanmar">စာရင်းသွင်းမည်</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
