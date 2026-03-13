"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { formatMMK } from "@/lib/utils";
import type { ClassStatus } from "@/types/database";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PublicClass {
  id: string;
  level: string;
  fee_mmk: number;
  fee_formatted: string;
  seat_remaining: number;
  seat_total: number;
  enrollment_open_at: string | null;
  enrollment_close_at: string | null;
  status: ClassStatus;
  mode?: "online" | "offline";
  event_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  venue?: string | null;
  image_url?: string | null;
  max_tickets_per_person?: number;
}

interface PublicIntake {
  id: string;
  name: string;
  year: number;
  status: string;
  hero_image_url?: string | null;
}

interface TenantLabels {
  intake: string;
  class: string;
  student: string;
  seat: string;
  fee: string;
  orgType: string;
}

const DEFAULT_LABELS: TenantLabels = {
  intake: "Intake", class: "Class Type", student: "Student",
  seat: "Seat", fee: "Fee", orgType: "language_school",
};

interface ApiResponse {
  intake: PublicIntake;
  classes: PublicClass[];
  labels?: TenantLabels;
}

interface ApiError {
  error: string;
  code?: string;
  intake?: PublicIntake;
  opens_at?: string | null;
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

const LEVEL_COLORS: Record<string, string> = {
  N5: "bg-emerald-100 text-emerald-800",
  N4: "bg-blue-100 text-blue-800",
  N3: "bg-purple-100 text-purple-800",
  N2: "bg-orange-100 text-orange-800",
  N1: "bg-red-100 text-red-800",
};

const DEFAULT_LEVEL_COLOR = "bg-gray-100 text-gray-800";

// ─── Seats badge (default / language_school) ────────────────────────────────

function SeatsBadge({ remaining, seatLabel }: { remaining: number; seatLabel: string }) {
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
      {remaining} {seatLabel.toLowerCase()}{remaining !== 1 ? "s" : ""} left
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

// ─── Class card (default / language_school / training_center) ────────────────

function ClassCard({ cls, onSelect, labels }: { cls: PublicClass; onSelect: (id: string) => void; labels: TenantLabels }) {
  const isFull = cls.status === "full" || cls.seat_remaining === 0;
  const now = new Date();
  const notYetOpen = cls.enrollment_open_at ? now < new Date(cls.enrollment_open_at) : false;
  const alreadyClosed = cls.enrollment_close_at ? now > new Date(cls.enrollment_close_at) : false;
  const isDisabled = isFull || notYetOpen || alreadyClosed;

  const fmtOpts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };

  const closeDate = cls.enrollment_close_at
    ? new Date(cls.enrollment_close_at).toLocaleDateString("en-GB", fmtOpts)
    : null;

  const openDate = cls.enrollment_open_at
    ? new Date(cls.enrollment_open_at).toLocaleDateString("en-GB", {
        ...fmtOpts,
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  // Determine overlay state
  const overlayState = isFull
    ? "full"
    : notYetOpen
      ? "not_open"
      : alreadyClosed
        ? "closed"
        : null;

  return (
    <div
      className={`relative overflow-hidden rounded-xl border-2 transition-all ${
        isDisabled
          ? overlayState === "not_open"
            ? "cursor-not-allowed border-amber-200 bg-amber-50/30"
            : overlayState === "closed"
              ? "cursor-not-allowed border-red-200 bg-red-50/30"
              : "cursor-not-allowed border-gray-200 bg-gray-50"
          : "cursor-pointer border-gray-200 bg-white shadow-sm hover:border-[#1a6b3c] hover:shadow-md"
      }`}
      onClick={() => !isDisabled && onSelect(cls.id)}
      role={isDisabled ? undefined : "button"}
      tabIndex={isDisabled ? undefined : 0}
      onKeyDown={(e) => {
        if (!isDisabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(cls.id);
        }
      }}
    >
      {/* ── Status banner (top strip) ── */}
      {overlayState === "full" && (
        <div className="bg-gray-700 px-4 py-2 text-center text-xs font-semibold text-white tracking-wide">
          FULL / <span className="font-myanmar font-normal">နေရာပြည့်သွားပြီ</span>
        </div>
      )}
      {overlayState === "not_open" && (
        <div className="bg-amber-500 px-4 py-2 text-center">
          <p className="text-xs font-semibold text-white tracking-wide">
            OPENS {openDate?.toUpperCase()}
          </p>
          <p className="font-myanmar text-[10px] text-amber-100 mt-0.5">စာရင်းသွင်းချိန် မရောက်သေးပါ</p>
        </div>
      )}
      {overlayState === "closed" && (
        <div className="bg-red-500 px-4 py-2 text-center">
          <p className="text-xs font-semibold text-white tracking-wide">ENROLLMENT CLOSED</p>
          <p className="font-myanmar text-[10px] text-red-100 mt-0.5">စာရင်းသွင်းချိန် ကုန်ဆုံးသွားပြီ</p>
        </div>
      )}

      <div className={`p-5 ${isDisabled ? "opacity-50" : ""}`}>
        {/* Level badge + seats */}
        <div className="mb-3 flex items-center justify-between">
          <span
            className={`rounded-full px-3 py-1 text-sm font-bold ${LEVEL_COLORS[cls.level] ?? DEFAULT_LEVEL_COLOR}`}
          >
            {cls.level}
          </span>
          <SeatsBadge remaining={cls.seat_remaining} seatLabel={labels.seat} />
        </div>

        {/* Content area: side-by-side when image exists */}
        <div className={cls.image_url ? "flex gap-4" : ""}>
          {/* Text content */}
          <div className={cls.image_url ? "flex-1 min-w-0" : ""}>
            {/* Mode badge */}
            <div className="mb-3">
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                (cls.mode ?? "offline") === "online"
                  ? "bg-blue-50 text-blue-700"
                  : "bg-emerald-50 text-emerald-700"
              }`}>
                {(cls.mode ?? "offline") === "online" ? "💻 Online" : "🏫 Offline"}
              </span>
            </div>

            {/* Fee */}
            <p className="mb-1 text-2xl font-bold text-gray-900">
              {cls.fee_formatted}
            </p>
            <p className="font-myanmar mb-3 text-sm text-gray-500">
              {formatMMK(cls.fee_mmk).replace(" MMK", "")} ကျပ်
            </p>

            {/* Enrollment window info */}
            {(cls.enrollment_open_at || cls.enrollment_close_at) && !isDisabled && (
              <div className="mb-2 flex items-center gap-1.5 text-xs text-gray-400">
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {closeDate ? `Closes ${closeDate}` : openDate ? `Opens ${openDate}` : null}
              </div>
            )}

            {/* Event details */}
            {(cls.event_date || cls.venue) && (
              <div className="mt-2 space-y-1 text-xs text-gray-500">
                {cls.event_date && (
                  <p className="flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
                    </svg>
                    {new Date(cls.event_date + "T00:00:00").toLocaleDateString("en-GB", fmtOpts)}
                    {cls.start_time && (
                      <span className="ml-1">
                        {cls.start_time.slice(0, 5)}{cls.end_time ? ` – ${cls.end_time.slice(0, 5)}` : ""}
                      </span>
                    )}
                  </p>
                )}
                {cls.venue && (
                  <p className="flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                    </svg>
                    {cls.venue}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Ticket image — right side */}
          {cls.image_url && (
            <div className="w-28 shrink-0 self-center overflow-hidden rounded-lg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={cls.image_url}
                alt={cls.level}
                className="w-full h-full object-cover rounded-lg"
              />
            </div>
          )}
        </div>

        {/* CTA hint */}
        {!isDisabled && (
          <div className="mt-4 flex items-center text-sm font-medium text-[#1a6b3c]">
            Register Now
            <svg className="ml-1 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Coming Soon page (draft intake) ────────────────────────────────────────

function ComingSoonPage({ intake, opensAt }: { intake?: PublicIntake; opensAt?: string | null }) {
  const intakeNameMM = intake ? getIntakeNameMM(intake.name, intake.year) : null;

  const opensFormatted = opensAt
    ? new Date(opensAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : null;

  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-purple-50">
        <span className="text-3xl">🕐</span>
      </div>

      {intake && (
        <p className="mb-2 text-base font-semibold text-gray-700">
          {intake.name} ({intake.year})
        </p>
      )}

      <h1 className="text-2xl font-bold text-gray-900">Coming Soon</h1>
      <p className="font-myanmar mt-1 text-lg text-gray-600">
        မကြာမီ ဖွင့်လှစ်မည်
      </p>
      {intakeNameMM && (
        <p className="font-myanmar mt-1 text-sm text-gray-400">{intakeNameMM}</p>
      )}

      {opensFormatted && (
        <div className="mt-6 inline-flex items-center gap-2 rounded-full bg-purple-50 px-4 py-2 text-sm font-medium text-purple-700">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
          </svg>
          Opens {opensFormatted}
        </div>
      )}

      <div className="mt-8 max-w-sm rounded-xl border border-purple-200 bg-purple-50 p-5">
        <p className="text-sm text-gray-600">
          Enrollment for this intake has not opened yet. Please check back soon!
        </p>
        <p className="font-myanmar mt-2 text-sm text-gray-500">
          ဤသင်တန်းအတွက် စာရင်းသွင်းချိန် မဖွင့်လှစ်ရသေးပါ။ နောက်မှ ပြန်လည်စစ်ဆေးပါ။
        </p>
      </div>

      <a
        href="/enroll"
        className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-[#1a3f8a] hover:underline"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Check Other Intakes
      </a>
    </div>
  );
}

// ─── Enrollment closed page ─────────────────────────────────────────────────

function EnrollmentClosedPage({ intake }: { intake?: PublicIntake }) {
  const intakeNameMM = intake ? getIntakeNameMM(intake.name, intake.year) : null;

  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
        <span className="text-3xl">🔒</span>
      </div>

      {intake && (
        <p className="mb-2 text-base font-semibold text-gray-700">
          {intake.name} ({intake.year})
        </p>
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

      <a
        href="/enroll"
        className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-[#1a3f8a] hover:underline"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Check Other Intakes
      </a>
    </div>
  );
}

// ─── All classes full page ───────────────────────────────────────────────────

function AllClassesFullPage({ intake, labels }: { intake: PublicIntake; labels: TenantLabels }) {
  const isLanguageSchool = labels.orgType === "language_school";
  const intakeNameMM = isLanguageSchool ? getIntakeNameMM(intake.name, intake.year) : null;

  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-orange-50">
        <svg className="h-8 w-8 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </div>

      <p className="mb-2 text-sm text-gray-500">
        {intake.name}{intakeNameMM ? <> / <span className="font-myanmar">{intakeNameMM}</span></> : null}
      </p>

      <h1 className="text-2xl font-bold text-gray-900">Fully Booked</h1>
      {isLanguageSchool && (
        <p className="font-myanmar mt-1 text-lg text-gray-600">
          အတန်းအားလုံး နေရာပြည့်သွားပြီ
        </p>
      )}

      <div className="mt-8 max-w-sm rounded-xl border border-orange-200 bg-orange-50 p-5">
        <p className="text-sm text-gray-600">
          All {labels.seat.toLowerCase()}s are currently taken. Please check back later.
        </p>
        {isLanguageSchool && (
          <p className="font-myanmar mt-2 text-sm text-gray-500">
            ဤသင်တန်း၏ အတန်းများ အားလုံး နေရာပြည့်သွားပြီဖြစ်သည်။ နောက်စာရင်းသွင်းချိန်အတွက် ပြန်လည်စစ်ဆေးပါ။
          </p>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── EVENT ORG TYPE — Dark Luxury Theme ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const GOLD = "#C9A84C";
const GOLD_LIGHT = "#E8C97A";

function EventSeatsBadge({ remaining, total }: { remaining: number; total: number }) {
  if (remaining === 0) {
    return (
      <span className="text-[11px] tracking-wider px-2.5 py-1 rounded-sm border border-red-500/30 bg-red-500/10 text-red-300">
        SOLD OUT
      </span>
    );
  }
  const pctLeft = total > 0 ? (remaining / total) * 100 : 100;
  const isSellingFast = pctLeft <= 30 && remaining > 0;
  const style =
    remaining < 10
      ? "border-[#C9A84C]/30 bg-[#C9A84C]/10 text-[#E8C97A] animate-pulse"
      : remaining < 100
        ? "border-amber-400/20 bg-amber-400/8 text-amber-200"
        : "border-green-400/20 bg-green-400/8 text-green-300";
  return (
    <div className="flex flex-col items-end gap-1">
      {isSellingFast && (
        <span className="text-[9px] tracking-[2px] uppercase font-semibold px-2 py-0.5 rounded-sm animate-pulse"
          style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}>
          Selling Fast
        </span>
      )}
      <span className={`text-[11px] tracking-wider px-2.5 py-1 rounded-sm border whitespace-nowrap ${style}`}>
        {remaining.toLocaleString()} left
      </span>
    </div>
  );
}

function EventTicketCard({
  cls,
  onSelect,
  isHighestTier,
  index,
}: {
  cls: PublicClass;
  onSelect: (id: string, quantity: number) => void;
  isHighestTier: boolean;
  index: number;
}) {
  const maxTix = cls.max_tickets_per_person ?? 1;
  const [qty, setQty] = useState(1);
  const isFull = cls.status === "full" || cls.seat_remaining === 0;
  const now = new Date();
  const notYetOpen = cls.enrollment_open_at ? now < new Date(cls.enrollment_open_at) : false;
  const alreadyClosed = cls.enrollment_close_at ? now > new Date(cls.enrollment_close_at) : false;
  const isDisabled = isFull || notYetOpen || alreadyClosed;

  const fmtOpts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  const closeDate = cls.enrollment_close_at
    ? new Date(cls.enrollment_close_at).toLocaleDateString("en-GB", fmtOpts)
    : null;
  const openDate = cls.enrollment_open_at
    ? new Date(cls.enrollment_open_at).toLocaleDateString("en-GB", { ...fmtOpts, hour: "2-digit", minute: "2-digit" })
    : null;

  const overlayState = isFull ? "full" : notYetOpen ? "not_open" : alreadyClosed ? "closed" : null;

  const priceNum = cls.fee_mmk.toLocaleString();

  return (
    <div
      className={`group relative overflow-hidden transition-all duration-500 cursor-pointer ${
        isHighestTier
          ? "bg-gradient-to-br from-[#171208] to-[#1a1508]"
          : "bg-[#111]"
      } ${isDisabled ? "opacity-60 cursor-not-allowed" : "hover:-translate-y-1.5"}`}
      style={{ animationDelay: `${index * 0.1}s` }}
      onClick={() => { if (!isDisabled && maxTix <= 1) onSelect(cls.id, 1); }}
      role={isDisabled ? undefined : "button"}
      tabIndex={isDisabled ? undefined : 0}
      onKeyDown={(e) => {
        if (!isDisabled && maxTix <= 1 && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(cls.id, 1);
        }
      }}
    >
      {/* Gold gradient overlay on hover */}
      <div className={`absolute inset-0 bg-gradient-to-br from-[#C9A84C]/[0.08] to-transparent transition-opacity duration-500 ${
        isHighestTier ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      }`} />

      {/* Shimmer border on hover */}
      <div className="absolute inset-0 rounded-none border border-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          background: "linear-gradient(#111, #111) padding-box, linear-gradient(135deg, #C9A84C, transparent 60%) border-box",
        }}
      />

      {/* Large watermark label */}
      <div className="absolute -bottom-5 -right-2 select-none pointer-events-none leading-none"
        style={{
          fontFamily: "'Bebas Neue', sans-serif",
          fontSize: "140px",
          letterSpacing: "4px",
          color: isHighestTier ? "rgba(201,168,76,0.04)" : "rgba(255,255,255,0.02)",
        }}
      >
        {cls.level}
      </div>

      {/* Status banner */}
      {overlayState === "full" && (
        <div className="relative z-10 bg-white/5 px-6 py-2.5 text-center text-[11px] font-medium tracking-[3px] text-white/60 uppercase">
          SOLD OUT / <span className="font-myanmar font-normal tracking-normal">နေရာပြည့်သွားပြီ</span>
        </div>
      )}
      {overlayState === "not_open" && (
        <div className="relative z-10 px-6 py-2.5 text-center" style={{ background: "rgba(201,168,76,0.15)" }}>
          <p className="text-[11px] font-medium tracking-[3px] uppercase" style={{ color: GOLD_LIGHT }}>
            OPENS {openDate?.toUpperCase()}
          </p>
          <p className="font-myanmar text-[10px] mt-0.5" style={{ color: "rgba(201,168,76,0.6)" }}>
            စာရင်းသွင်းချိန် မရောက်သေးပါ
          </p>
        </div>
      )}
      {overlayState === "closed" && (
        <div className="relative z-10 bg-red-500/10 px-6 py-2.5 text-center">
          <p className="text-[11px] font-medium tracking-[3px] text-red-300 uppercase">ENROLLMENT CLOSED</p>
          <p className="font-myanmar text-[10px] text-red-400/60 mt-0.5">စာရင်းသွင်းချိန် ကုန်ဆုံးသွားပြီ</p>
        </div>
      )}

      {/* Ticket image — hero position */}
      {cls.image_url && (
        <div className="relative z-10 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={cls.image_url}
            alt={cls.level}
            className="w-full h-auto object-cover max-h-52 sm:max-h-64"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#111] via-transparent to-transparent" />
        </div>
      )}

      <div className={`relative z-10 px-8 ${cls.image_url ? "pt-6 pb-10" : "py-10"} sm:px-10 ${cls.image_url ? "sm:pt-8 sm:pb-12" : "sm:py-12"}`}>
        {/* Tier + Seats */}
        <div className="flex items-start justify-between mb-8">
          <span className={`text-[11px] font-medium tracking-[3px] uppercase px-3 py-1.5 rounded-sm border ${
            isHighestTier
              ? "border-[#C9A84C]/40 text-[#C9A84C]"
              : "border-white/10 text-[#888880]"
          }`}>
            {cls.level}
          </span>
          <EventSeatsBadge remaining={cls.seat_remaining} total={cls.seat_total} />
        </div>

        {/* Price */}
        <div className="mb-8">
          <div
            className="text-[52px] sm:text-[56px] font-bold leading-none mb-1.5 tracking-wider"
            style={{
              fontFamily: "'Bebas Neue', sans-serif",
              ...(isHighestTier
                ? { background: `linear-gradient(135deg, ${GOLD_LIGHT}, ${GOLD})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }
                : { color: "#F8F4EE" }),
            }}
          >
            {priceNum}
          </div>
          <div className="font-myanmar text-base tracking-wider" style={{ color: "#888880" }}>
            {formatMMK(cls.fee_mmk).replace(" MMK", "")} ကျပ် · MMK
          </div>
        </div>

        {/* Divider */}
        <div className="w-full h-px mb-7" style={{
          background: isHighestTier
            ? "linear-gradient(to right, rgba(201,168,76,0.2), transparent)"
            : "linear-gradient(to right, rgba(255,255,255,0.06), transparent)",
        }} />

        {/* Meta rows */}
        <div className="flex flex-col gap-3 mb-8">
          <div className="flex items-center gap-3 text-[13px]" style={{ color: "#888880" }}>
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" style={{ boxShadow: "0 0 6px rgba(255,107,107,0.5)" }} />
            {(cls.mode ?? "offline") === "online" ? "Online Event" : "Offline Event"}
          </div>
          {closeDate && !isDisabled && (
            <div className="flex items-center gap-3 text-[13px]" style={{ color: "#888880" }}>
              <svg className="w-3.5 h-3.5 opacity-50 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5" />
              </svg>
              Closes {closeDate}
            </div>
          )}
          {cls.event_date && (
            <div className="flex items-center gap-3 text-[13px]" style={{ color: "#888880" }}>
              <svg className="w-3.5 h-3.5 opacity-50 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5" />
              </svg>
              {new Date(cls.event_date + "T00:00:00").toLocaleDateString("en-GB", fmtOpts)}
            </div>
          )}
          {cls.venue && (
            <div className="flex items-center gap-3 text-[13px]" style={{ color: "#888880" }}>
              <svg className="w-3.5 h-3.5 opacity-50 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
              </svg>
              {cls.venue}
            </div>
          )}
        </div>

        {/* Quantity selector (only for multi-ticket) */}
        {!isDisabled && maxTix > 1 && (
          <div className="flex items-center justify-between mb-6 px-1">
            <span className="text-[12px] tracking-[1px] uppercase" style={{ color: "#888880" }}>
              Qty <span className="font-myanmar tracking-normal">(အရေအတွက်)</span>
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setQty((q) => Math.max(1, q - 1)); }}
                className="w-8 h-8 rounded-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white flex items-center justify-center transition-colors text-lg"
              >
                −
              </button>
              <span className="text-xl font-bold min-w-[2ch] text-center" style={{
                fontFamily: "'Bebas Neue', sans-serif",
                color: isHighestTier ? GOLD_LIGHT : "#F8F4EE",
              }}>
                {qty}
              </span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setQty((q) => Math.min(maxTix, cls.seat_remaining, q + 1)); }}
                className="w-8 h-8 rounded-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white flex items-center justify-center transition-colors text-lg"
              >
                +
              </button>
            </div>
          </div>
        )}

        {/* Total price for multi-ticket */}
        {!isDisabled && maxTix > 1 && qty > 1 && (
          <div className="mb-6 text-right text-[13px]" style={{ color: "#888880" }}>
            Total: <span style={{ color: isHighestTier ? GOLD_LIGHT : "#F8F4EE" }} className="font-semibold">{formatMMK(cls.fee_mmk * qty)}</span>
          </div>
        )}

        {/* Register button */}
        {!isDisabled && (
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(cls.id, qty); }}
            className={`group/btn relative w-full flex items-center justify-between px-6 py-4 text-[13px] font-medium tracking-[2px] uppercase rounded-sm border overflow-hidden transition-all duration-300 ${
              isHighestTier
                ? "border-[#C9A84C]/40 text-[#E8C97A] hover:border-[#C9A84C] bg-gradient-to-r from-[#C9A84C]/15 to-[#C9A84C]/5 hover:from-[#C9A84C]/25 hover:to-[#C9A84C]/10"
                : "border-white/12 text-[#F8F4EE] hover:border-white/30"
            }`}
          >
            <span className="absolute left-0 top-0 bottom-0 w-0 bg-white/5 transition-all duration-500 group-hover/btn:w-full" />
            <span className="relative">{maxTix > 1 && qty > 1 ? `Buy ${qty} Tickets` : "Buy Now"}</span>
            <svg className="relative w-5 h-5 transition-transform duration-300 group-hover/btn:translate-x-1" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12h15m0 0l-6.75-6.75M19.5 12l-6.75 6.75" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function EventEnrollmentPage({
  intake,
  classes,
  slug,
  onSelect,
}: {
  intake: PublicIntake;
  classes: PublicClass[];
  slug: string;
  onSelect: (id: string) => void;
}) {
  // Extract event info from first class that has it
  const firstWithEvent = classes.find((c) => c.event_date || c.venue);
  const fmtOpts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };
  const eventDateStr = firstWithEvent?.event_date
    ? new Date(firstWithEvent.event_date + "T00:00:00").toLocaleDateString("en-GB", fmtOpts)
    : null;
  const closeDateStr = classes.find((c) => c.enrollment_close_at)?.enrollment_close_at
    ? new Date(classes.find((c) => c.enrollment_close_at)!.enrollment_close_at!).toLocaleDateString("en-GB", fmtOpts)
    : null;
  const venue = firstWithEvent?.venue ?? null;

  // Find the highest priced tier for special styling
  const maxFee = Math.max(...classes.map((c) => c.fee_mmk));

  // Parse event name — split into title words
  const nameParts = intake.name.split(" ");
  const titleMain = nameParts.slice(0, -1).join(" ") || intake.name;
  const titleSub = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";

  return (
    <div className="-mx-4 sm:-mx-6 -my-6 sm:-my-10" style={{ background: "#080808", color: "#F8F4EE" }}>
      {/* Google Fonts */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap"
        rel="stylesheet"
      />

      {/* Grain overlay */}
      <div className="fixed inset-0 pointer-events-none z-[9999] opacity-[0.35]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E")`,
        }}
      />

      {/* ── HERO ────────────────────────────────────────────────────── */}
      {intake.hero_image_url ? (
        <>
          {/* Banner image — clean, no text overlay */}
          <section className="relative overflow-hidden">
            {/* Track status button */}
            <a
              href={`/enroll/${slug}/status`}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute top-6 right-6 sm:top-8 sm:right-12 z-10 flex items-center gap-2 text-[13px] font-medium tracking-[1.5px] uppercase px-4 py-2.5 rounded-sm border transition-all duration-300 hover:bg-white/10"
              style={{ color: "#fff", borderColor: "rgba(255,255,255,0.3)", backdropFilter: "blur(8px)", background: "rgba(0,0,0,0.3)" }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Track Status
            </a>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={intake.hero_image_url}
              alt={intake.name}
              className="w-full object-cover"
              style={{ maxHeight: "55vh" }}
            />
          </section>

          {/* Info strip — separate dark section below banner */}
          {(eventDateStr || closeDateStr || venue) && (
            <section className="px-6 py-8 sm:px-12" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-12 animate-[fadeUp_0.8s_ease_forwards]">
                {eventDateStr && (
                  <div className="text-center">
                    <div className="text-[10px] tracking-[3px] uppercase mb-1.5" style={{ color: GOLD }}>Date</div>
                    <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "20px", fontWeight: 600 }}>{eventDateStr}</div>
                  </div>
                )}
                {eventDateStr && closeDateStr && <div className="w-1 h-1 rounded-full" style={{ background: GOLD, opacity: 0.4 }} />}
                {closeDateStr && (
                  <div className="text-center">
                    <div className="text-[10px] tracking-[3px] uppercase mb-1.5" style={{ color: GOLD }}>Registration Closes</div>
                    <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "20px", fontWeight: 600 }}>{closeDateStr}</div>
                  </div>
                )}
                {(eventDateStr || closeDateStr) && venue && <div className="w-1 h-1 rounded-full" style={{ background: GOLD, opacity: 0.4 }} />}
                {venue && (
                  <div className="text-center">
                    <div className="text-[10px] tracking-[3px] uppercase mb-1.5" style={{ color: GOLD }}>Venue</div>
                    <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "20px", fontWeight: 600 }}>{venue}</div>
                  </div>
                )}
              </div>
            </section>
          )}
        </>
      ) : (
        /* No hero image — original full-height gradient hero */
        <section className="relative min-h-[85vh] flex flex-col items-center justify-center overflow-hidden px-6 py-24 sm:px-12">
          <div className="absolute inset-0" style={{
            background: `
              radial-gradient(ellipse 80% 50% at 50% 0%, rgba(201,168,76,0.12) 0%, transparent 60%),
              radial-gradient(ellipse 40% 40% at 80% 60%, rgba(201,168,76,0.05) 0%, transparent 50%),
              radial-gradient(ellipse 60% 60% at 20% 80%, rgba(201,168,76,0.04) 0%, transparent 50%)`,
          }} />
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute left-[15%] top-0 w-px h-full animate-pulse"
              style={{ background: "linear-gradient(to bottom, transparent, rgba(201,168,76,0.15), transparent)" }} />
            <div className="absolute right-[15%] top-0 w-px h-full animate-pulse" style={{
              background: "linear-gradient(to bottom, transparent, rgba(201,168,76,0.15), transparent)",
              animationDelay: "2s",
            }} />
          </div>

          {/* Track status button */}
          <a
            href={`/enroll/${slug}/status`}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute top-6 right-6 sm:top-8 sm:right-12 z-10 flex items-center gap-2 text-[13px] font-medium tracking-[1.5px] uppercase px-4 py-2.5 rounded-sm border transition-all duration-300 hover:bg-[#C9A84C]/10"
            style={{ color: GOLD, borderColor: "rgba(201,168,76,0.3)" }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            Track Status
          </a>

          {venue && (
            <div className="relative flex items-center gap-4 mb-6 animate-[fadeUp_0.8s_ease_forwards]"
              style={{ fontSize: "11px", letterSpacing: "5px", textTransform: "uppercase", color: GOLD }}>
              <span className="w-10 h-px opacity-50" style={{ background: GOLD }} />
              {venue}
              <span className="w-10 h-px opacity-50" style={{ background: GOLD }} />
            </div>
          )}

          <h1 className="relative text-center animate-[fadeUp_0.8s_ease_0.15s_forwards] opacity-0"
            style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: "clamp(64px, 12vw, 150px)", lineHeight: 0.9, letterSpacing: "4px" }}>
            {titleMain}
            <br />
            <span style={{ WebkitTextStroke: "1px #F8F4EE", color: "transparent" }}>{intake.year}</span>
            {titleSub && (
              <span className="block mt-2" style={{
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: "clamp(22px, 4vw, 44px)",
                fontWeight: 300,
                fontStyle: "italic",
                letterSpacing: "8px",
                color: GOLD_LIGHT,
              }}>
                {titleSub}
              </span>
            )}
          </h1>

          {(eventDateStr || closeDateStr || venue) && (
            <div className="relative mt-10 flex flex-wrap items-center justify-center gap-6 sm:gap-8 animate-[fadeUp_0.8s_ease_0.3s_forwards] opacity-0">
              {eventDateStr && (
                <div className="text-center">
                  <div className="text-[10px] tracking-[3px] uppercase mb-1" style={{ color: "#888880" }}>Date</div>
                  <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "18px", fontWeight: 600 }}>{eventDateStr}</div>
                </div>
              )}
              {eventDateStr && closeDateStr && <div className="w-1 h-1 rounded-full opacity-50" style={{ background: GOLD }} />}
              {closeDateStr && (
                <div className="text-center">
                  <div className="text-[10px] tracking-[3px] uppercase mb-1" style={{ color: "#888880" }}>Registration Closes</div>
                  <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "18px", fontWeight: 600 }}>{closeDateStr}</div>
                </div>
              )}
              {(eventDateStr || closeDateStr) && venue && <div className="w-1 h-1 rounded-full opacity-50" style={{ background: GOLD }} />}
              {venue && (
                <div className="text-center">
                  <div className="text-[10px] tracking-[3px] uppercase mb-1" style={{ color: "#888880" }}>Venue</div>
                  <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "18px", fontWeight: 600 }}>{venue}</div>
                </div>
              )}
            </div>
          )}

          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 animate-[fadeUp_1s_ease_0.6s_forwards] opacity-0">
            <span className="text-[10px] tracking-[3px] uppercase" style={{ color: "#888880" }}>Tickets</span>
            <div className="w-px h-10 animate-pulse" style={{ background: `linear-gradient(to bottom, ${GOLD}, transparent)` }} />
          </div>
        </section>
      )}

      {/* ── TICKETS SECTION ─────────────────────────────────────────── */}
      <section id="tickets" className="px-6 py-16 sm:px-12 sm:py-20 scroll-mt-4">
        {/* Section header */}
        <div className="text-center mb-16">
          <div className="text-[10px] tracking-[5px] uppercase mb-3" style={{ color: GOLD }}>Select Your Experience</div>
          <h2 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "38px", fontWeight: 300, fontStyle: "italic" }}>
            Choose Your Tier
          </h2>
        </div>

        {/* Ticket grid */}
        {classes.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-lg" style={{ color: "#888880" }}>Nothing available yet. Please check back soon.</p>
          </div>
        ) : (
          <div className="relative max-w-[1200px] mx-auto">
            {/* Decorative gold corner frame */}
            <div className="absolute inset-[-1px] pointer-events-none opacity-20" style={{
              background: `linear-gradient(135deg, ${GOLD} 0%, transparent 40%, transparent 60%, ${GOLD} 100%)`,
            }} />
            <div className={`grid gap-px ${
              classes.length === 1
                ? "grid-cols-1 max-w-md mx-auto"
                : classes.length === 2
                  ? "grid-cols-1 sm:grid-cols-2"
                  : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
            }`}>
              {classes.map((cls, i) => (
                <EventTicketCard
                  key={cls.id}
                  cls={cls}
                  onSelect={onSelect}
                  isHighestTier={cls.fee_mmk === maxFee && classes.length > 1}
                  index={i}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── FOOTER ──────────────────────────────────────────────────── */}
      <footer className="px-6 py-12 sm:px-12 border-t border-white/5">
        <div className="max-w-[1200px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
          <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: "22px", letterSpacing: "4px", opacity: 0.5 }}>
            {intake.name}
          </div>
          <div className="text-[12px] tracking-wider" style={{ color: "#888880" }}>
            Powered by{" "}
            <a href="https://www.kuunyi.com" target="_blank" rel="noopener noreferrer" className="transition-opacity hover:opacity-70" style={{ color: GOLD }}>
              KuuNyi
            </a>
          </div>
        </div>
      </footer>

      {/* Sticky mobile CTA */}
      {classes.some((c) => c.seat_remaining > 0 && c.status === "open") && (
        <div className="fixed bottom-0 left-0 right-0 z-50 sm:hidden"
          style={{ background: "linear-gradient(to top, rgba(8,8,8,0.98), rgba(8,8,8,0.9))", backdropFilter: "blur(12px)" }}>
          <div className="px-4 py-3 flex items-center justify-between">
            <div>
              <div className="text-[11px] tracking-[2px] uppercase" style={{ color: GOLD }}>
                {classes.filter((c) => c.seat_remaining > 0).length} ticket{classes.filter((c) => c.seat_remaining > 0).length !== 1 ? "s" : ""} available
              </div>
              <div className="text-[13px] text-white/60">
                From {formatMMK(Math.min(...classes.filter((c) => c.seat_remaining > 0).map((c) => c.fee_mmk)))}
              </div>
            </div>
            <a href="#tickets" className="px-5 py-2.5 rounded-sm text-[12px] font-semibold tracking-[1.5px] uppercase transition-all"
              style={{ background: `linear-gradient(135deg, ${GOLD}, ${GOLD_LIGHT})`, color: "#080808" }}>
              Buy Tickets
            </a>
          </div>
        </div>
      )}

      {/* Keyframes */}
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function IntakeLandingPage() {
  return (
    <Suspense fallback={<LoadingSkeleton />}>
      <IntakeLandingContent />
    </Suspense>
  );
}

function IntakeLandingContent() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const levelFilter = searchParams.get("level");
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

  function handleSelectClass(classId: string, quantity: number = 1) {
    const qParam = quantity > 1 ? `&quantity=${quantity}` : "";
    router.push(`/enroll/form?class_id=${classId}&slug=${params.slug}${qParam}`);
  }

  if (loading) return <LoadingSkeleton />;

  // ── Handle error states ───────────────────────────────────────
  if (errorInfo) {
    if (errorInfo.code === "INTAKE_DRAFT") {
      return <ComingSoonPage intake={errorInfo.intake} opensAt={errorInfo.opens_at} />;
    }
    if (errorInfo.code === "INTAKE_CLOSED") {
      return <EnrollmentClosedPage intake={errorInfo.intake} />;
    }
    return <ErrorPage message={errorInfo.error || "Unknown error"} />;
  }

  if (!data) return <ErrorPage message="Unknown error" />;

  const { intake, classes: allClasses } = data;
  const classes = levelFilter
    ? allClasses.filter((c) => c.level === levelFilter)
    : allClasses;
  const tl = data.labels ?? DEFAULT_LABELS;
  const isLanguageSchool = tl.orgType === "language_school";
  const intakeNameMM = isLanguageSchool ? getIntakeNameMM(intake.name, intake.year) : null;

  // ── All classes full ──────────────────────────────────────────
  const allFull = allClasses.length > 0 && allClasses.every((c) => c.seat_remaining === 0 || c.status === "full");
  if (allFull) {
    return <AllClassesFullPage intake={intake} labels={tl} />;
  }

  // ── Event org type → dark luxury theme ────────────────────────
  if (tl.orgType === "event") {
    return (
      <EventEnrollmentPage
        intake={intake}
        classes={classes}
        slug={params.slug}
        onSelect={handleSelectClass}
      />
    );
  }

  // ── Default theme (language_school, training_center) ──────────
  return (
    <div>
      {/* Intake header */}
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{intake.name}</h1>
        {intakeNameMM && (
          <p className="font-myanmar mt-1 text-lg text-gray-600">{intakeNameMM}</p>
        )}
      </div>

      {/* Track status link */}
      <div className="mb-6 text-center">
        <a
          href={`/enroll/${params.slug}/status`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[#1a3f8a] hover:underline"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15a2.25 2.25 0 012.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
          </svg>
          Track your enrollment status
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
          </svg>
        </a>
      </div>

      {/* Class grid */}
      {classes.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-lg text-gray-500">Nothing available yet. Please check back soon.</p>
          {isLanguageSchool && (
            <p className="font-myanmar mt-1 text-gray-400">
              ဤသင်တန်းအတွက် အတန်းများ မရှိသေးပါ
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {classes.map((cls) => (
            <ClassCard key={cls.id} cls={cls} onSelect={handleSelectClass} labels={tl} />
          ))}
        </div>
      )}
    </div>
  );
}
