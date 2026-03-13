"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { formatMMK, formatMMKSimple } from "@/lib/utils";
import type { EnrollmentStatus, PaymentStatus } from "@/types/database";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatusInfo {
  enrollment_ref: string;
  student_name_en: string;
  student_name_mm: string | null;
  class_level: string | null;
  fee_mmk: number | null;
  fee_formatted: string | null;
  status: EnrollmentStatus;
  status_label_en: string;
  status_label_mm: string;
  payment: {
    id: string;
    status: PaymentStatus;
    status_label_en: string;
    status_label_mm: string;
    submitted_at: string | null;
  } | null;
}

// ─── Status step config ──────────────────────────────────────────────────────

interface StepInfo {
  label_en: string;
  label_mm: string;
  icon: string;
}

const STEPS: StepInfo[] = [
  { label_en: "Enrolled",          label_mm: "စာရင်းသွင်းပြီး",        icon: "1" },
  { label_en: "Payment Submitted", label_mm: "ငွေပေးချေပြီး",          icon: "2" },
  { label_en: "Under Review",      label_mm: "စစ်ဆေးနေဆဲ",            icon: "3" },
  { label_en: "Confirmed",         label_mm: "အတည်ပြုပြီး",            icon: "✓" },
];

function getActiveStep(status: EnrollmentStatus, paymentStatus: PaymentStatus | null): number {
  if (status === "confirmed") return 4;
  if (status === "rejected") return -1; // special case
  if (status === "payment_submitted") return 3;
  if (paymentStatus === "pending") return 3;
  return 1; // pending_payment
}

// ─── Status colors ───────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<EnrollmentStatus, { bg: string; text: string; border: string }> = {
  pending_payment:   { bg: "bg-amber-50",   text: "text-amber-800",   border: "border-amber-200" },
  payment_submitted: { bg: "bg-blue-50",    text: "text-blue-800",    border: "border-blue-200" },
  partial_payment:   { bg: "bg-amber-50",   text: "text-amber-700",   border: "border-amber-400" },
  confirmed:         { bg: "bg-green-50",   text: "text-green-800",   border: "border-green-200" },
  rejected:          { bg: "bg-red-50",     text: "text-red-800",     border: "border-red-200" },
};

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="mx-auto max-w-lg animate-pulse">
      <div className="mx-auto mb-6 h-12 w-12 rounded-full bg-gray-200" />
      <div className="mx-auto mb-4 h-7 w-64 rounded bg-gray-200" />
      <div className="mx-auto mb-8 h-5 w-48 rounded bg-gray-100" />
      <div className="space-y-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-12 rounded-xl bg-gray-100" />
        ))}
      </div>
    </div>
  );
}

// ─── Lookup form ──────────────────────────────────────────────────────────────

function LookupForm({ onLookup }: { onLookup: (ref: string) => void }) {
  const [ref, setRef] = useState("");

  return (
    <div className="mx-auto max-w-md text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-blue-50 mx-auto">
        <svg className="h-8 w-8 text-blue-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Check Your Status</h1>
      <p className="font-myanmar text-gray-500 mb-6">သင့်အခြေအနေ စစ်ဆေးပါ</p>

      <p className="text-sm text-gray-600 mb-4">
        Enter your enrollment reference to check your status.
      </p>
      <p className="font-myanmar text-sm text-gray-400 mb-6">
        သင့်စာရင်းသွင်းမှု ရည်ညွှန်းကုဒ်ကို ထည့်သွင်းပါ။
      </p>

      <div className="flex gap-2">
        <input
          type="text"
          value={ref}
          onChange={(e) => setRef(e.target.value.toUpperCase())}
          placeholder="e.g. NM-2026-00042"
          className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-sm font-mono text-center focus:border-[#1a3f8a] focus:outline-none focus:ring-1 focus:ring-[#1a3f8a]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && ref.trim()) onLookup(ref.trim());
          }}
        />
        <button
          onClick={() => ref.trim() && onLookup(ref.trim())}
          disabled={!ref.trim()}
          className="rounded-lg bg-[#1a3f8a] px-6 py-3 text-sm font-semibold text-white hover:bg-[#163478] disabled:opacity-50 transition-colors"
        >
          Check
        </button>
      </div>
    </div>
  );
}

// ─── Step tracker ─────────────────────────────────────────────────────────────

function StepTracker({ activeStep }: { activeStep: number }) {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between relative">
        {/* Connecting line */}
        <div className="absolute top-5 left-0 right-0 h-0.5 bg-gray-200 mx-8" />
        <div
          className="absolute top-5 left-0 h-0.5 bg-[#1a6b3c] mx-8 transition-all duration-500"
          style={{ width: `${Math.max(0, ((activeStep - 1) / (STEPS.length - 1)) * 100)}%` }}
        />

        {STEPS.map((step, i) => {
          const stepNum = i + 1;
          const isActive = stepNum <= activeStep;
          const isCurrent = stepNum === activeStep;

          return (
            <div key={i} className="relative flex flex-col items-center z-10" style={{ flex: 1 }}>
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                  isActive
                    ? "bg-[#1a6b3c] text-white shadow-md"
                    : "bg-gray-200 text-gray-400"
                } ${isCurrent ? "ring-4 ring-[#1a6b3c]/20" : ""}`}
              >
                {step.icon}
              </div>
              <p className={`mt-2 text-xs font-medium text-center ${isActive ? "text-[#1a6b3c]" : "text-gray-400"}`}>
                {step.label_en}
              </p>
              <p className={`font-myanmar text-[10px] text-center ${isActive ? "text-[#1a6b3c]/70" : "text-gray-300"}`}>
                {step.label_mm}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function StatusPageWrapper() {
  return (
    <Suspense fallback={<LoadingSkeleton />}>
      <StatusPage />
    </Suspense>
  );
}

function StatusPage() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const initialRef = searchParams.get("ref") ?? "";

  const [enrollmentRef, setEnrollmentRef] = useState(initialRef);
  const [data, setData] = useState<StatusInfo | null>(null);
  const [loading, setLoading] = useState(!!initialRef);
  const [error, setError] = useState<string | null>(null);

  async function fetchStatus(ref: string) {
    setLoading(true);
    setError(null);
    setEnrollmentRef(ref);

    try {
      const res = await fetch(`/api/public/status?ref=${encodeURIComponent(ref)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || "Enrollment not found.");
        setData(null);
        return;
      }
      setData(await res.json());
    } catch {
      setError("Failed to load. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initialRef) fetchStatus(initialRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <LoadingSkeleton />;

  // Show lookup form if no ref provided or error
  if (!enrollmentRef || (error && !data)) {
    return (
      <div>
        <LookupForm onLookup={fetchStatus} />
        {error && (
          <div className="mx-auto max-w-md mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-center">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
      </div>
    );
  }

  if (!data) {
    return <LookupForm onLookup={fetchStatus} />;
  }

  const statusConfig = STATUS_CONFIG[data.status];
  const activeStep = getActiveStep(data.status, data.payment?.status ?? null);
  const isRejected = data.status === "rejected";
  const isConfirmed = data.status === "confirmed";

  const feeEn = data.fee_mmk != null ? formatMMKSimple(data.fee_mmk) : null;
  const feeMm = data.fee_mmk != null ? formatMMK(data.fee_mmk).replace(" MMK", "") : null;

  return (
    <div className="mx-auto max-w-lg">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="mb-6 text-center">
        <h1 className="text-xl font-bold text-gray-900">Enrollment Status</h1>
        <p className="font-myanmar text-sm text-gray-500">စာရင်းသွင်းမှု အခြေအနေ</p>
      </div>

      {/* ── Enrollment ref ─────────────────────────────────────── */}
      <div className="mb-6 rounded-xl bg-gray-50 border border-gray-200 p-4 text-center">
        <p className="text-xs text-gray-400 mb-1">Reference</p>
        <p className="font-mono text-xl font-bold text-[#1a3f8a]">{data.enrollment_ref}</p>
        {data.student_name_en && (
          <p className="mt-1 text-sm text-gray-600">
            {data.student_name_en}
            {data.student_name_mm && (
              <span className="font-myanmar text-gray-400"> / {data.student_name_mm}</span>
            )}
          </p>
        )}
      </div>

      {/* ── Step tracker (not shown for rejected) ──────────────── */}
      {!isRejected && <StepTracker activeStep={activeStep} />}

      {/* ── Status card ────────────────────────────────────────── */}
      <div className={`mb-6 rounded-xl border p-5 ${statusConfig.bg} ${statusConfig.border}`}>
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
            isConfirmed ? "bg-green-200" : isRejected ? "bg-red-200" : "bg-white"
          }`}>
            {isConfirmed ? (
              <svg className="w-5 h-5 text-green-700" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : isRejected ? (
              <svg className="w-5 h-5 text-red-700" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
          </div>
          <div>
            <p className={`font-semibold ${statusConfig.text}`}>{data.status_label_en}</p>
            <p className={`font-myanmar text-sm ${statusConfig.text} opacity-80`}>{data.status_label_mm}</p>
          </div>
        </div>

        {/* Payment status */}
        {data.payment && (
          <div className="mt-4 pt-3 border-t border-black/5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">Payment</span>
              <span className={`font-medium ${
                data.payment.status === "verified" ? "text-green-700" :
                data.payment.status === "rejected" ? "text-red-700" : "text-amber-700"
              }`}>
                {data.payment.status_label_en}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs mt-1">
              <span className="font-myanmar text-gray-400">ငွေပေးချေမှု</span>
              <span className="font-myanmar text-gray-400">{data.payment.status_label_mm}</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Class & fee info ───────────────────────────────────── */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Details</h3>
        <div className="space-y-3 text-sm">
          {data.class_level && (
            <div className="flex justify-between">
              <span className="text-gray-500">Class Level</span>
              <span className="font-semibold text-gray-900">{data.class_level}</span>
            </div>
          )}
          {feeEn && (
            <div className="flex justify-between">
              <span className="text-gray-500">Fee</span>
              <span className="font-semibold text-gray-900">{feeEn}</span>
            </div>
          )}
          {feeMm && (
            <div className="flex justify-between">
              <span className="font-myanmar text-gray-400">ကျောင်းလခ</span>
              <span className="font-myanmar font-semibold text-gray-700">{feeMm} ကျပ်</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Action buttons ─────────────────────────────────────── */}
      <div className="space-y-3">
        {data.status === "pending_payment" && (
          <a
            href={`/enroll/payment/${data.enrollment_ref}`}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#1a6b3c] py-3 text-sm font-semibold text-white hover:bg-[#155d33] transition-colors"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Upload Payment / <span className="font-myanmar">ငွေလွှဲပြေစာ တင်သွင်းမည်</span>
          </a>
        )}

        <button
          onClick={() => {
            setData(null);
            setEnrollmentRef("");
            setError(null);
          }}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Check Another Reference / <span className="font-myanmar">အခြား ရည်ညွှန်းကုဒ် စစ်ဆေးမည်</span>
        </button>

        <a
          href={`/enroll/${params.slug}`}
          className="flex w-full items-center justify-center gap-1 text-sm text-[#1a3f8a] hover:underline py-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Back to Classes
        </a>
      </div>
    </div>
  );
}
