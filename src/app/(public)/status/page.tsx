"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatusResponse {
  enrollment_ref: string;
  student_name_en: string;
  student_name_mm: string | null;
  class_level: string | null;
  fee_mmk: number | null;
  fee_formatted: string | null;
  status: string;
  status_label_en: string;
  status_label_mm: string;
  payment: {
    id: string;
    status: string;
    status_label_en: string;
    status_label_mm: string;
    submitted_at: string;
  } | null;
}

// ─── Level badge colors ──────────────────────────────────────────────────────

const LEVEL_COLORS: Record<string, string> = {
  N5: "bg-emerald-100 text-emerald-800",
  N4: "bg-blue-100 text-blue-800",
  N3: "bg-purple-100 text-purple-800",
  N2: "bg-orange-100 text-orange-800",
  N1: "bg-red-100 text-red-800",
};

// ─── Status cards ────────────────────────────────────────────────────────────

function PendingPaymentCard({ data }: { data: StatusResponse }) {
  return (
    <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-6">
      {/* Status icon */}
      <div className="mb-4 flex justify-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-100">
          <svg className="h-7 w-7 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
      </div>

      <h2 className="text-center text-xl font-bold text-amber-800">Awaiting Payment</h2>
      <p className="font-myanmar mt-1 text-center text-amber-700">
        ငွေပေးချေမှု စောင့်ဆိုင်းနေသည်
      </p>

      <EnrollmentDetails data={data} />

      <Link
        href={`/enroll/payment/${encodeURIComponent(data.enrollment_ref)}`}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-amber-600 py-3 text-sm font-semibold text-white hover:bg-amber-700 transition-colors"
      >
        View Payment Instructions / <span className="font-myanmar">ငွေပေးချေနည်း ကြည့်ရန်</span>
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </Link>
    </div>
  );
}

function PaymentSubmittedCard({ data }: { data: StatusResponse }) {
  return (
    <div className="rounded-xl border-2 border-blue-300 bg-blue-50 p-6">
      <div className="mb-4 flex justify-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-blue-100">
          <svg className="h-7 w-7 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </div>
      </div>

      <h2 className="text-center text-xl font-bold text-blue-800">Payment Under Review</h2>
      <p className="font-myanmar mt-1 text-center text-blue-700">
        ငွေပေးချေမှု စစ်ဆေးနေသည်
      </p>

      <div className="mt-4 rounded-lg bg-blue-100/60 p-3 text-center">
        <p className="text-sm text-blue-800">We will review within 24 hours.</p>
        <p className="font-myanmar mt-0.5 text-sm text-blue-700">
          ၂၄ နာရီအတွင်း စစ်ဆေးပေးပါမည်
        </p>
      </div>

      <EnrollmentDetails data={data} />
    </div>
  );
}

function ConfirmedCard({ data }: { data: StatusResponse }) {
  return (
    <div className="rounded-xl border-2 border-green-300 bg-green-50 p-6">
      <div className="mb-4 flex justify-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <svg className="h-9 w-9 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      </div>

      <h2 className="text-center text-2xl font-bold text-green-800">
        Enrollment Confirmed!
      </h2>
      <p className="font-myanmar mt-1 text-center text-lg text-green-700">
        စာရင်းသွင်းမှု အတည်ပြုပြီး
      </p>

      <EnrollmentDetails data={data} />

      <div className="mt-5 rounded-lg bg-green-100/60 p-4 text-center">
        <p className="text-sm font-medium text-green-800">
          Congratulations! Welcome to the Japanese Language Course.
        </p>
        <p className="font-myanmar mt-1 text-green-700">
          ဂျပန်ဘာသာ သင်တန်းသို့ ကြိုဆိုပါသည်
        </p>
      </div>
    </div>
  );
}

function RejectedCard({ data }: { data: StatusResponse }) {
  return (
    <div className="rounded-xl border-2 border-red-300 bg-red-50 p-6">
      <div className="mb-4 flex justify-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
          <svg className="h-7 w-7 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
      </div>

      <h2 className="text-center text-xl font-bold text-red-800">Enrollment Rejected</h2>
      <p className="font-myanmar mt-1 text-center text-red-700">
        စာရင်းသွင်းမှု ငြင်းပယ်ခံရသည်
      </p>

      <EnrollmentDetails data={data} />

      <div className="mt-5 rounded-lg bg-red-100/60 p-4">
        <p className="text-sm text-red-800">
          If you believe this is an error, please contact the school:
        </p>
        <p className="font-myanmar mt-0.5 text-sm text-red-700">
          အမှားဖြစ်နေသည်ဟု ယူဆပါက ကျောင်းသို့ ဆက်သွယ်ပါ -
        </p>
        <p className="mt-2 text-sm font-semibold text-red-900">
          Please contact the school directly.
        </p>
      </div>
    </div>
  );
}

// ─── Shared enrollment details ───────────────────────────────────────────────

function EnrollmentDetails({ data }: { data: StatusResponse }) {
  return (
    <div className="mt-5 space-y-2.5 rounded-lg bg-white/70 p-4 text-sm">
      {/* Reference */}
      <div className="flex items-center justify-between">
        <span className="text-gray-500">Reference</span>
        <span className="font-mono font-semibold text-gray-900">{data.enrollment_ref}</span>
      </div>

      {/* Student name */}
      <div className="flex items-center justify-between">
        <span className="text-gray-500">Student</span>
        <span className="text-right font-medium text-gray-900">
          {data.student_name_en}
          {data.student_name_mm && (
            <span className="font-myanmar ml-1 text-gray-600">({data.student_name_mm})</span>
          )}
        </span>
      </div>

      {/* Class level */}
      {data.class_level && (
        <div className="flex items-center justify-between">
          <span className="text-gray-500">Class</span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
              LEVEL_COLORS[data.class_level] ?? "bg-gray-100 text-gray-700"
            }`}
          >
            {data.class_level}
          </span>
        </div>
      )}

      {/* Fee */}
      {data.fee_formatted && (
        <div className="flex items-center justify-between">
          <span className="text-gray-500">Fee</span>
          <span className="font-myanmar font-semibold text-gray-900">{data.fee_formatted}</span>
        </div>
      )}
    </div>
  );
}

// ─── Not found ───────────────────────────────────────────────────────────────

function NotFoundResult() {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-8 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gray-200">
        <svg className="h-7 w-7 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>
      <h2 className="text-lg font-semibold text-gray-700">Reference not found</h2>
      <p className="font-myanmar mt-1 text-gray-500">
        မှတ်ပုံတင်ကုတ် မတွေ့ရှိပါ
      </p>
      <p className="mt-3 text-sm text-gray-500">
        Please check the reference number and try again.
      </p>
      <p className="font-myanmar mt-1 text-sm text-gray-400">
        ရည်ညွှန်းကုဒ်ကို စစ်ဆေးပြီး ထပ်မံကြိုးစားပါ
      </p>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function StatusPageWrapper() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col items-center py-20">
          <svg className="h-8 w-8 animate-spin text-[#1a6b3c]" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      }
    >
      <StatusPage />
    </Suspense>
  );
}

function StatusPage() {
  const searchParams = useSearchParams();
  const initialRef = searchParams.get("ref") ?? "";

  const [refInput, setRefInput] = useState(initialRef);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<StatusResponse | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async (ref: string) => {
    const trimmed = ref.trim();
    if (!trimmed) return;

    setLoading(true);
    setResult(null);
    setNotFound(false);
    setError(null);
    setSearched(true);

    try {
      const res = await fetch(`/api/public/status?ref=${encodeURIComponent(trimmed)}`);

      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || "Something went wrong. Please try again.");
        return;
      }

      const data: StatusResponse = await res.json();
      setResult(data);
    } catch {
      setError("Network error. Please check your connection.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-search if URL has ?ref= param
  useEffect(() => {
    if (initialRef) {
      handleSearch(initialRef);
    }
  }, [initialRef, handleSearch]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    handleSearch(refInput);
  }

  // ── Render result card based on status ──────────────────────
  function renderResult() {
    if (loading) {
      return (
        <div className="flex flex-col items-center py-12">
          <svg className="h-8 w-8 animate-spin text-[#1a6b3c]" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="mt-3 text-sm text-gray-500">Checking status...</p>
        </div>
      );
    }

    if (notFound) return <NotFoundResult />;

    if (error) {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <p className="text-sm font-medium text-red-700">{error}</p>
        </div>
      );
    }

    if (!result) return null;

    switch (result.status) {
      case "pending_payment":
        return <PendingPaymentCard data={result} />;
      case "payment_submitted":
        return <PaymentSubmittedCard data={result} />;
      case "confirmed":
        return <ConfirmedCard data={result} />;
      case "rejected":
        return <RejectedCard data={result} />;
      default:
        return (
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-6 text-center">
            <p className="font-semibold text-gray-700">{result.status_label_en}</p>
            <p className="font-myanmar mt-1 text-sm text-gray-500">{result.status_label_mm}</p>
            <EnrollmentDetails data={result} />
          </div>
        );
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      {/* Heading */}
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Check Your Enrollment Status</h1>
        <p className="font-myanmar mt-1 text-gray-600">
          သင်၏ စာရင်းသွင်းမှု အခြေအနေ စစ်ဆေးရန်
        </p>
      </div>

      {/* Search form */}
      <form onSubmit={handleSubmit} className="mb-8">
        <label htmlFor="ref-input" className="mb-2 block text-sm font-medium text-gray-700">
          Enrollment Reference / <span className="font-myanmar">စာရင်းသွင်းမှု ရည်ညွှန်းကုဒ်</span>
        </label>
        <div className="flex gap-2">
          <input
            id="ref-input"
            type="text"
            value={refInput}
            onChange={(e) => setRefInput(e.target.value.toUpperCase())}
            placeholder="NM-2026-XXXXX"
            className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-mono text-sm text-gray-900 placeholder-gray-400 focus:border-[#1a6b3c] focus:outline-none focus:ring-1 focus:ring-[#1a6b3c]"
          />
          <button
            type="submit"
            disabled={!refInput.trim() || loading}
            className="shrink-0 rounded-lg bg-[#1a6b3c] px-5 py-3 text-sm font-semibold text-white hover:bg-[#155d33] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <span>
                Check <span className="hidden sm:inline">Status</span>
                <br className="sm:hidden" />
                <span className="font-myanmar text-xs sm:hidden">စစ်ဆေးမည်</span>
              </span>
            )}
          </button>
        </div>
      </form>

      {/* Result */}
      {searched && renderResult()}
    </div>
  );
}
