"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { formatMMK } from "@/lib/utils";
import type { JlptLevel, ClassStatus } from "@/types/database";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PublicClass {
  id: string;
  level: JlptLevel;
  fee_mmk: number;
  fee_formatted: string;
  seat_remaining: number;
  seat_total: number;
  enrollment_close_at: string | null;
  status: ClassStatus;
}

interface PublicIntake {
  id: string;
  name: string;
  year: number;
  status: string;
}

interface ApiResponse {
  intake: PublicIntake;
  classes: PublicClass[];
}

interface ApiError {
  error: string;
  code?: string;
  intake?: PublicIntake;
}

// ─── Myanmar translations for intake names ───────────────────────────────────

const MONTH_MM: Record<string, string> = {
  january: "ဇန်နဝါရီ",
  february: "ဖေဖော်ဝါရီ",
  march: "မတ်",
  april: "ဧပြီ",
  may: "မေ",
  june: "ဇွန်",
  july: "ဇူလိုင်",
  august: "ဩဂုတ်",
  september: "စက်တင်ဘာ",
  october: "အောက်တိုဘာ",
  november: "နိုဝင်ဘာ",
  december: "ဒီဇင်ဘာ",
};

const MM_DIGITS: Record<string, string> = {
  "0": "၀", "1": "၁", "2": "၂", "3": "၃", "4": "၄",
  "5": "၅", "6": "၆", "7": "၇", "8": "၈", "9": "၉",
};

function toMyanmarNumerals(str: string): string {
  return str.replace(/[0-9]/g, (d) => MM_DIGITS[d]);
}

function getIntakeNameMM(name: string, year: number): string {
  const lower = name.toLowerCase();
  for (const [en, mm] of Object.entries(MONTH_MM)) {
    if (lower.includes(en)) {
      return `${mm} ${toMyanmarNumerals(String(year))} သင်တန်း`;
    }
  }
  return `${toMyanmarNumerals(String(year))} သင်တန်း`;
}

// ─── Level badge colors ──────────────────────────────────────────────────────

const LEVEL_COLORS: Record<JlptLevel, string> = {
  N5: "bg-emerald-100 text-emerald-800",
  N4: "bg-blue-100 text-blue-800",
  N3: "bg-purple-100 text-purple-800",
  N2: "bg-orange-100 text-orange-800",
  N1: "bg-red-100 text-red-800",
};

// ─── Seats badge ─────────────────────────────────────────────────────────────

function SeatsBadge({ remaining }: { remaining: number }) {
  if (remaining === 0) {
    return (
      <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
        Full
      </span>
    );
  }
  const color =
    remaining < 5
      ? "bg-orange-100 text-orange-700"
      : "bg-green-100 text-green-700";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
      {remaining} seats left
    </span>
  );
}

// ─── Loading skeleton ────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="mx-auto mb-8 h-8 w-64 rounded bg-gray-200" />
      <div className="mx-auto mb-10 h-4 w-48 rounded bg-gray-100" />
      <div className="grid gap-4 sm:grid-cols-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-48 rounded-xl border border-gray-200 bg-gray-50 p-6">
            <div className="mb-4 h-6 w-16 rounded-full bg-gray-200" />
            <div className="mb-3 h-6 w-32 rounded bg-gray-200" />
            <div className="mb-3 h-4 w-24 rounded bg-gray-100" />
            <div className="h-4 w-20 rounded bg-gray-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Error page ──────────────────────────────────────────────────────────────

function ErrorPage({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center py-20 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-50">
        <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </div>
      <h2 className="mb-2 text-xl font-semibold text-gray-900">Intake Not Found</h2>
      <p className="font-myanmar text-gray-500">သင်တန်းရှာမတွေ့ပါ</p>
      <p className="mt-4 max-w-sm text-sm text-gray-500">{message}</p>
    </div>
  );
}

// ─── Class card ──────────────────────────────────────────────────────────────

function ClassCard({ cls, onSelect }: { cls: PublicClass; onSelect: (id: string) => void }) {
  const isFull = cls.status === "full" || cls.seat_remaining === 0;

  const closeDate = cls.enrollment_close_at
    ? new Date(cls.enrollment_close_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <div
      className={`relative overflow-hidden rounded-xl border transition-all ${
        isFull
          ? "cursor-not-allowed border-gray-200 bg-gray-50 opacity-60"
          : "cursor-pointer border-gray-200 bg-white shadow-sm hover:border-[#1a6b3c] hover:shadow-md"
      }`}
      onClick={() => !isFull && onSelect(cls.id)}
      role={isFull ? undefined : "button"}
      tabIndex={isFull ? undefined : 0}
      onKeyDown={(e) => {
        if (!isFull && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(cls.id);
        }
      }}
    >
      {/* Full overlay */}
      {isFull && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60">
          <div className="rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-white">
            Class Full / <span className="font-myanmar">နေရာပြည့်သွားပြီ</span>
          </div>
        </div>
      )}

      <div className="p-5">
        {/* Level badge */}
        <div className="mb-3 flex items-center justify-between">
          <span
            className={`rounded-full px-3 py-1 text-sm font-bold ${LEVEL_COLORS[cls.level]}`}
          >
            {cls.level}
          </span>
          <SeatsBadge remaining={cls.seat_remaining} />
        </div>

        {/* Fee */}
        <p className="font-myanmar mb-1 text-2xl font-bold text-gray-900">
          {cls.fee_formatted}
        </p>
        <p className="mb-3 text-sm text-gray-500">
          {formatMMK(cls.fee_mmk).replace(" MMK", "")} Kyat
        </p>

        {/* Enrollment close date */}
        {closeDate && (
          <p className="text-xs text-gray-400">
            Enrollment closes: {closeDate}
          </p>
        )}

        {/* CTA hint */}
        {!isFull && (
          <div className="mt-4 flex items-center text-sm font-medium text-[#1a6b3c]">
            Enroll Now
            <svg className="ml-1 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Enrollment closed page ──────────────────────────────────────────────────

function EnrollmentClosedPage({ intake }: { intake?: PublicIntake }) {
  const intakeNameMM = intake ? getIntakeNameMM(intake.name, intake.year) : null;

  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
        <svg className="h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      </div>

      {intake && (
        <p className="mb-2 text-sm text-gray-500">{intake.name}</p>
      )}

      <h1 className="text-2xl font-bold text-gray-900">Enrollment Closed</h1>
      <p className="font-myanmar mt-1 text-lg text-gray-600">
        စာရင်းသွင်းချိန် ကျော်လွန်သွားပြီ
      </p>
      {intakeNameMM && (
        <p className="font-myanmar mt-1 text-sm text-gray-400">{intakeNameMM}</p>
      )}

      <div className="mt-8 max-w-sm rounded-xl border border-gray-200 bg-gray-50 p-5">
        <p className="text-sm text-gray-600">
          Enrollment for this intake has ended. Please check back for the next intake.
        </p>
        <p className="font-myanmar mt-2 text-sm text-gray-500">
          ဤသင်တန်းအတွက် စာရင်းသွင်းချိန် ပိတ်သိမ်းပြီးဖြစ်သည်။ နောက်သင်တန်းအတွက် ပြန်လည်စစ်ဆေးပါ။
        </p>
      </div>
    </div>
  );
}

// ─── All classes full page ───────────────────────────────────────────────────

function AllClassesFullPage({ intake }: { intake: PublicIntake }) {
  const intakeNameMM = getIntakeNameMM(intake.name, intake.year);

  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-orange-50">
        <svg className="h-8 w-8 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </div>

      <p className="mb-2 text-sm text-gray-500">
        {intake.name} / <span className="font-myanmar">{intakeNameMM}</span>
      </p>

      <h1 className="text-2xl font-bold text-gray-900">All Classes Full</h1>
      <p className="font-myanmar mt-1 text-lg text-gray-600">
        အတန်းအားလုံး နေရာပြည့်သွားပြီ
      </p>

      <div className="mt-8 max-w-sm rounded-xl border border-orange-200 bg-orange-50 p-5">
        <p className="text-sm text-gray-600">
          All classes for this intake are currently full. Please check back for the next enrollment period.
        </p>
        <p className="font-myanmar mt-2 text-sm text-gray-500">
          ဤသင်တန်း၏ အတန်းများ အားလုံး နေရာပြည့်သွားပြီဖြစ်သည်။ နောက်စာရင်းသွင်းချိန်အတွက် ပြန်လည်စစ်ဆေးပါ။
        </p>
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function IntakeLandingPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const [data, setData] = useState<ApiResponse | null>(null);
  const [errorInfo, setErrorInfo] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchIntake() {
      try {
        const res = await fetch(`/api/public/enroll/${params.slug}`);
        if (!res.ok) {
          const body: ApiError = await res.json().catch(() => ({ error: `Error (${res.status})` }));
          setErrorInfo(body);
          return;
        }
        const json: ApiResponse = await res.json();
        setData(json);
      } catch {
        setErrorInfo({ error: "Failed to load intake. Please try again later." });
      } finally {
        setLoading(false);
      }
    }
    fetchIntake();
  }, [params.slug]);

  function handleSelectClass(classId: string) {
    router.push(`/enroll/form?class_id=${classId}&slug=${params.slug}`);
  }

  if (loading) return <LoadingSkeleton />;

  // ── Handle error states ───────────────────────────────────────
  if (errorInfo) {
    if (errorInfo.code === "INTAKE_CLOSED" || errorInfo.code === "INTAKE_DRAFT") {
      return <EnrollmentClosedPage intake={errorInfo.intake} />;
    }
    return <ErrorPage message={errorInfo.error || "Unknown error"} />;
  }

  if (!data) return <ErrorPage message="Unknown error" />;

  const { intake, classes } = data;
  const intakeNameMM = getIntakeNameMM(intake.name, intake.year);

  // ── All classes full ──────────────────────────────────────────
  const allFull = classes.length > 0 && classes.every((c) => c.seat_remaining === 0 || c.status === "full");
  if (allFull) {
    return <AllClassesFullPage intake={intake} />;
  }

  return (
    <div>
      {/* Intake header */}
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{intake.name}</h1>
        <p className="font-myanmar mt-1 text-lg text-gray-600">{intakeNameMM}</p>
      </div>

      {/* Class grid */}
      {classes.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-lg text-gray-500">No classes available for this intake yet.</p>
          <p className="font-myanmar mt-1 text-gray-400">
            ဤသင်တန်းအတွက် အတန်းများ မရှိသေးပါ
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {classes.map((cls) => (
            <ClassCard key={cls.id} cls={cls} onSelect={handleSelectClass} />
          ))}
        </div>
      )}
    </div>
  );
}
