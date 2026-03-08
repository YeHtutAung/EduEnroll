"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { formatMMK, formatMMKSimple } from "@/lib/utils";
import type { MyanmarBank, ClassStatus } from "@/types/database";

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnrollmentInfo {
  enrollment_ref: string;
  student_name_en: string;
  student_name_mm: string | null;
  class_level: string | null;
  fee_mmk: number | null;
  fee_formatted: string | null;
  status: string;
  status_label_en: string;
  status_label_mm: string;
}

interface BankAccountInfo {
  bank_name: MyanmarBank;
  account_number: string;
  account_holder: string;
}

interface PublicClass {
  id: string;
  level: string;
  fee_mmk: number;
  fee_formatted: string;
  seat_remaining: number;
  status: ClassStatus;
}

// ─── Bank badge colors ───────────────────────────────────────────────────────

const BANK_COLORS: Record<string, string> = {
  KBZ:   "bg-green-100 text-green-800",
  AYA:   "bg-blue-100 text-blue-800",
  CB:    "bg-yellow-100 text-yellow-800",
  UAB:   "bg-purple-100 text-purple-800",
  Yoma:  "bg-orange-100 text-orange-800",
  Other: "bg-gray-100 text-gray-700",
};

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement("input");
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
        copied
          ? "bg-green-100 text-green-700"
          : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-300"
      }`}
    >
      <span className="inline-flex items-center gap-1">
        {copied ? (
          <>
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Copied! / <span className="font-myanmar">ကူးယူပြီး</span>
          </>
        ) : (
          <>
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Copy
          </>
        )}
      </span>
    </button>
  );
}

function CopySmall({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement("input");
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
        copied
          ? "bg-green-100 text-green-700"
          : "bg-white text-gray-600 hover:bg-gray-100 border border-gray-300"
      }`}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="mx-auto max-w-lg animate-pulse">
      <div className="mx-auto mb-6 h-16 w-16 rounded-full bg-gray-200" />
      <div className="mx-auto mb-4 h-7 w-64 rounded bg-gray-200" />
      <div className="mx-auto mb-8 h-5 w-48 rounded bg-gray-100" />
      <div className="mb-6 h-24 rounded-xl bg-gray-100" />
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-5 rounded bg-gray-100" />
        ))}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SuccessPageWrapper() {
  return (
    <Suspense fallback={<LoadingSkeleton />}>
      <SuccessPage />
    </Suspense>
  );
}

function SuccessPage() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const enrollmentRef = searchParams.get("ref") ?? "";

  const [enrollment, setEnrollment] = useState<EnrollmentInfo | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccountInfo[]>([]);
  const [otherClasses, setOtherClasses] = useState<PublicClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enrollmentRef) {
      setError("Missing enrollment reference.");
      setLoading(false);
      return;
    }

    async function fetchData() {
      try {
        const [statusRes, banksRes, intakeRes] = await Promise.all([
          fetch(`/api/public/status?ref=${encodeURIComponent(enrollmentRef)}`),
          fetch("/api/public/bank-accounts"),
          fetch(`/api/public/enroll/${params.slug}`),
        ]);

        if (!statusRes.ok) {
          setError("Enrollment not found.");
          return;
        }

        const statusData: EnrollmentInfo = await statusRes.json();
        setEnrollment(statusData);

        if (banksRes.ok) {
          setBankAccounts(await banksRes.json());
        }

        if (intakeRes.ok) {
          const intakeData = await intakeRes.json();
          const available = (intakeData.classes ?? []).filter(
            (c: PublicClass) => c.status === "open" && c.seat_remaining > 0,
          );
          setOtherClasses(available);
        }
      } catch {
        setError("Failed to load. Please try again.");
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [enrollmentRef, params.slug]);

  if (loading) return <LoadingSkeleton />;

  if (error || !enrollment) {
    return (
      <div className="flex flex-col items-center py-20 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-50">
          <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="mb-2 text-xl font-semibold text-gray-900">Something went wrong</h2>
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    );
  }

  const feeEn = enrollment.fee_mmk != null ? formatMMKSimple(enrollment.fee_mmk) : null;
  const feeMm = enrollment.fee_mmk != null ? formatMMK(enrollment.fee_mmk).replace(" MMK", "") : null;

  return (
    <div className="mx-auto max-w-lg">
      {/* ── Success header ─────────────────────────────────────── */}
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
          <svg className="h-10 w-10 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Enrollment Successful!</h1>
        <p className="font-myanmar mt-1 text-lg text-gray-600">
          စာရင်းသွင်းမှု အောင်မြင်ပါသည်
        </p>
        {enrollment.student_name_en && (
          <p className="mt-2 text-sm text-gray-500">
            Welcome, <span className="font-semibold text-gray-700">{enrollment.student_name_en}</span>
            {enrollment.student_name_mm && (
              <span className="font-myanmar text-gray-400"> / {enrollment.student_name_mm}</span>
            )}
          </p>
        )}
      </div>

      {/* ── Enrollment reference ───────────────────────────────── */}
      <div className="mb-8 rounded-xl bg-[#1a6b3c]/10 p-6 text-center">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#1a6b3c]">
          Your Enrollment Reference
        </p>
        <p className="font-myanmar mb-3 text-xs text-gray-500">
          သင့်စာရင်းသွင်းမှု ရည်ညွှန်းကုဒ်
        </p>
        <p className="font-mono text-3xl font-bold text-[#1a6b3c] leading-tight">
          {enrollment.enrollment_ref}
        </p>
        <div className="mt-3 flex justify-center">
          <CopyButton text={enrollment.enrollment_ref} />
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Save this reference — you&apos;ll need it to check your status and make payment.
        </p>
        <p className="font-myanmar mt-1 text-xs text-gray-400">
          ဤရည်ညွှန်းကုဒ်ကို သိမ်းထားပါ — အခြေအနေစစ်ဆေးရန်နှင့် ငွေပေးချေရန် လိုအပ်ပါမည်။
        </p>
      </div>

      {/* ── Class & fee summary ────────────────────────────────── */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-3">
          {enrollment.class_level && (
            <span className="rounded-full bg-[#1a3f8a] px-3 py-1 text-sm font-bold text-white">
              {enrollment.class_level}
            </span>
          )}
          <div>
            {feeEn && (
              <p className="text-lg font-bold text-gray-900">{feeEn}</p>
            )}
            {feeMm && (
              <p className="font-myanmar text-sm text-gray-500">{feeMm} ကျပ်</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Payment instructions ───────────────────────────────── */}
      <div className="mb-8">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          Next Step: Make Payment
        </h2>
        <p className="font-myanmar mb-5 text-sm text-gray-500">
          နောက်တစ်ဆင့်: ငွေပေးချေပါ
        </p>

        <ol className="space-y-4">
          <li className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a6b3c] text-sm font-bold text-white">1</span>
            <div className="text-sm text-gray-700">
              <p>
                Transfer {feeEn && <span className="font-semibold text-gray-900">{feeEn}</span>} to one of the bank accounts below
              </p>
              <p className="font-myanmar mt-1 text-gray-500">
                အောက်ပါ ဘဏ်အကောင့်သို့ {feeMm && <span className="font-semibold text-gray-700">{feeMm} ကျပ်</span>} လွှဲပါ
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a6b3c] text-sm font-bold text-white">2</span>
            <div className="text-sm text-gray-700">
              <p>
                Use <span className="font-mono font-bold text-red-600">{enrollment.enrollment_ref}</span> as the transfer note
              </p>
              <p className="font-myanmar mt-1 text-gray-500">
                ငွေလွှဲမှတ်ချက်တွင် <span className="font-mono font-bold text-red-600">{enrollment.enrollment_ref}</span> ထည့်ပါ
              </p>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1a6b3c] text-sm font-bold text-white">3</span>
            <div className="text-sm text-gray-700">
              <p>Upload the transfer screenshot on the payment page</p>
              <p className="font-myanmar mt-1 text-gray-500">ငွေလွှဲပြေစာ ဓာတ်ပုံကို ငွေပေးချေရန်စာမျက်နှာတွင် တင်သွင်းပါ</p>
            </div>
          </li>
        </ol>
      </div>

      {/* ── Bank accounts ──────────────────────────────────────── */}
      {bankAccounts.length > 0 && (
        <div className="mb-8">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Bank Accounts / <span className="font-myanmar normal-case">ဘဏ်အကောင့်များ</span>
          </h3>
          <div className="space-y-3">
            {bankAccounts.map((account, i) => (
              <div key={i} className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4">
                <div>
                  <span className={`mb-1.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${BANK_COLORS[account.bank_name] ?? BANK_COLORS.Other}`}>
                    {account.bank_name}
                  </span>
                  <p className="text-sm font-medium text-gray-900">{account.account_holder}</p>
                  <p className="font-mono text-sm text-gray-600">{account.account_number}</p>
                </div>
                <CopySmall text={account.account_number} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Action buttons ─────────────────────────────────────── */}
      <div className="mb-8 space-y-3">
        <a
          href={`/enroll/payment/${enrollment.enrollment_ref}`}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#1a6b3c] py-3.5 text-sm font-semibold text-white hover:bg-[#155d33] transition-colors"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          Upload Payment / <span className="font-myanmar">ငွေလွှဲပြေစာ တင်သွင်းမည်</span>
        </a>

        <a
          href={`/enroll/${params.slug}/status?ref=${encodeURIComponent(enrollment.enrollment_ref)}`}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Check Status / <span className="font-myanmar">အခြေအနေ စစ်ဆေးမည်</span>
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </a>
      </div>

      {/* ── Other available classes ─────────────────────────────── */}
      {otherClasses.length > 1 && (
        <div className="border-t border-gray-200 pt-8">
          <h3 className="mb-4 text-sm font-semibold text-gray-500 uppercase tracking-wide">
            Other Available Classes
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {otherClasses
              .filter((c) => c.level !== enrollment.class_level)
              .slice(0, 4)
              .map((cls) => (
                <a
                  key={cls.id}
                  href={`/enroll/form?class_id=${cls.id}&slug=${params.slug}`}
                  className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 hover:border-[#1a6b3c] hover:shadow-sm transition-all"
                >
                  <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-bold text-gray-700">
                    {cls.level}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{cls.fee_formatted}</p>
                    <p className="text-xs text-green-600">{cls.seat_remaining} seats left</p>
                  </div>
                </a>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
