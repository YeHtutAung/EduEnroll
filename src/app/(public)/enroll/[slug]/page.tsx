"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import type { ClassStatus, TenantAppearance } from "@/types/database";
import { DEFAULT_APPEARANCE } from "@/types/database";
import {
  LsClassicTemplate,
  LsModernTemplate,
  LsWarmTemplate,
  EvLuxuryTemplate,
  EvFestivalTemplate,
  EvCorporateTemplate,
} from "@/components/enrollment/templates";
import type { TemplateProps, EventTemplateProps } from "@/components/enrollment/templates";

// Shell wrapper for non-template states (loading, error, coming-soon, etc.)
function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6 sm:py-10">
        {children}
      </main>
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PublicClass {
  id: string;
  level: string;
  fee_amount: number;
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
  currency: string;
}

const DEFAULT_LABELS: TenantLabels = {
  intake: "Intake", class: "Level", student: "Student",
  seat: "Seat", fee: "Fee", orgType: "language_school", currency: "MMK",
};

interface ApiResponse {
  intake: PublicIntake;
  classes: PublicClass[];
  labels?: TenantLabels;
  appearance?: Omit<TenantAppearance, "id" | "tenant_id" | "updated_at">;
}

interface ApiError {
  error: string;
  code?: string;
  intake?: PublicIntake;
  opens_at?: string | null;
}

// ─── Myanmar translations for intake names ───────────────────────────────────

const MONTH_MM: Record<string, string> = {
  january: "ဇန်နဝါရီ", february: "ဖေဖော်ဝါရီ", march: "မတ်", april: "ဧပြီ",
  may: "မေ", june: "ဇွန်", july: "ဇူလိုင်", august: "ဩဂုတ်",
  september: "စက်တင်ဘာ", october: "အောက်တိုဘာ", november: "နိုဝင်ဘာ", december: "ဒီဇင်ဘာ",
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
    if (lower.includes(en)) return `${mm} ${toMyanmarNumerals(String(year))} သင်တန်း`;
  }
  return `${toMyanmarNumerals(String(year))} သင်တန်း`;
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
            <div className="h-4 w-20 rounded bg-gray-100" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Error/state pages ───────────────────────────────────────────────────────

function ErrorPage({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center py-20 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-50">
        <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <h2 className="mb-2 text-xl font-semibold text-gray-900">Intake Not Found</h2>
      <p className="font-myanmar text-gray-500">သင်တန်းရှာမတွေ့ပါ</p>
      <p className="mt-4 max-w-sm text-sm text-gray-500">{message}</p>
    </div>
  );
}

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
      {intake && <p className="mb-2 text-base font-semibold text-gray-700">{intake.name} ({intake.year})</p>}
      <h1 className="text-2xl font-bold text-gray-900">Coming Soon</h1>
      <p className="font-myanmar mt-1 text-lg text-gray-600">မကြာမီ ဖွင့်လှစ်မည်</p>
      {intakeNameMM && <p className="font-myanmar mt-1 text-sm text-gray-400">{intakeNameMM}</p>}
      {opensFormatted && (
        <div className="mt-6 inline-flex items-center gap-2 rounded-full bg-purple-50 px-4 py-2 text-sm font-medium text-purple-700">
          📅 Opens {opensFormatted}
        </div>
      )}
      <a href="/enroll" className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-[#1a3f8a] hover:underline">
        ← Check Other Intakes
      </a>
    </div>
  );
}

function EnrollmentClosedPage({ intake }: { intake?: PublicIntake }) {
  const intakeNameMM = intake ? getIntakeNameMM(intake.name, intake.year) : null;
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
        <span className="text-3xl">🔒</span>
      </div>
      {intake && <p className="mb-2 text-base font-semibold text-gray-700">{intake.name} ({intake.year})</p>}
      <h1 className="text-2xl font-bold text-gray-900">Enrollment Closed</h1>
      <p className="font-myanmar mt-1 text-lg text-gray-600">စာရင်းသွင်းချိန် ကျော်လွန်သွားပြီ</p>
      {intakeNameMM && <p className="font-myanmar mt-1 text-sm text-gray-400">{intakeNameMM}</p>}
      <a href="/enroll" className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-[#1a3f8a] hover:underline">
        ← Check Other Intakes
      </a>
    </div>
  );
}

function AllClassesFullPage({ intake, labels }: { intake: PublicIntake; labels: TenantLabels }) {
  const isLanguageSchool = labels.orgType === "language_school";
  const intakeNameMM = isLanguageSchool ? getIntakeNameMM(intake.name, intake.year) : null;
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-orange-50">
        <span className="text-3xl">🎟</span>
      </div>
      <p className="mb-2 text-sm text-gray-500">
        {intake.name}{intakeNameMM ? <> / <span className="font-myanmar">{intakeNameMM}</span></> : null}
      </p>
      <h1 className="text-2xl font-bold text-gray-900">Fully Booked</h1>
      {isLanguageSchool && <p className="font-myanmar mt-1 text-lg text-gray-600">အတန်းအားလုံး နေရာပြည့်သွားပြီ</p>}
      <div className="mt-8 max-w-sm rounded-xl border border-orange-200 bg-orange-50 p-5">
        <p className="text-sm text-gray-600">
          All {labels.seat.toLowerCase()}s are currently taken. Please check back later.
        </p>
      </div>
    </div>
  );
}

// ─── Template routing helpers ─────────────────────────────────────────────────

function defaultTemplateForOrg(orgType: string): string {
  if (orgType === "event") return "ev-luxury";
  return "ls-classic";
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

  const psid = searchParams.get("psid");

  function handleSelectClass(classId: string, quantity: number = 1) {
    const qParam = quantity > 1 ? `&quantity=${quantity}` : "";
    const psidParam = psid ? `&psid=${psid}` : "";
    router.push(`/enroll/form?class_id=${classId}&slug=${params.slug}${qParam}${psidParam}`);
  }

  function handleCartCheckout(cartItems: { class_id: string; level: string; quantity: number; fee_amount: number; image_url: string | null }[]) {
    const cartKey = `cart_${Date.now()}`;
    sessionStorage.setItem(cartKey, JSON.stringify(cartItems));
    const psidParam = psid ? `&psid=${psid}` : "";
    router.push(`/enroll/form?slug=${params.slug}&cart_key=${cartKey}${psidParam}`);
  }

  if (loading) return <PageShell><LoadingSkeleton /></PageShell>;

  if (errorInfo) {
    if (errorInfo.code === "INTAKE_DRAFT") return <PageShell><ComingSoonPage intake={errorInfo.intake} opensAt={errorInfo.opens_at} /></PageShell>;
    if (errorInfo.code === "INTAKE_CLOSED") return <PageShell><EnrollmentClosedPage intake={errorInfo.intake} /></PageShell>;
    return <PageShell><ErrorPage message={errorInfo.error || "Unknown error"} /></PageShell>;
  }

  if (!data) return <PageShell><ErrorPage message="Unknown error" /></PageShell>;

  const { intake, classes: allClasses } = data;
  const classes = levelFilter ? allClasses.filter((c) => c.level === levelFilter) : allClasses;
  const tl = data.labels ?? DEFAULT_LABELS;
  const appearance = data.appearance ?? DEFAULT_APPEARANCE;

  // All classes full — show generic full page
  const allFull = allClasses.length > 0 && allClasses.every((c) => c.seat_remaining === 0 || c.status === "full");
  if (allFull) return <PageShell><AllClassesFullPage intake={intake} labels={tl} /></PageShell>;

  // Determine which template to render.
  // If appearance has a new-style template_id use it; otherwise fall back by org type.
  const newStyleIds = ["ls-classic", "ls-modern", "ls-warm", "ev-luxury", "ev-festival", "ev-corporate"];
  const effectiveTemplateId = newStyleIds.includes(appearance.template_id ?? "")
    ? appearance.template_id
    : defaultTemplateForOrg(tl.orgType);

  // ── Event templates ────────────────────────────────────────────
  if (effectiveTemplateId === "ev-luxury" || effectiveTemplateId === "ev-festival" || effectiveTemplateId === "ev-corporate") {
    const eventProps: EventTemplateProps = {
      appearance,
      intake,
      classes,
      labels: tl,
      slug: params.slug,
      currency: tl.currency,
      onSelect: handleSelectClass,
      onCartCheckout: handleCartCheckout,
    };
    if (effectiveTemplateId === "ev-festival") return <EvFestivalTemplate {...eventProps} />;
    if (effectiveTemplateId === "ev-corporate") return <EvCorporateTemplate {...eventProps} />;
    return <EvLuxuryTemplate {...eventProps} />;
  }

  // ── Language school / default templates ───────────────────────
  const templateProps: TemplateProps = {
    appearance,
    intake,
    classes,
    labels: tl,
    slug: params.slug,
    onSelectClass: handleSelectClass,
  };
  if (effectiveTemplateId === "ls-modern") return <LsModernTemplate {...templateProps} />;
  if (effectiveTemplateId === "ls-warm") return <LsWarmTemplate {...templateProps} />;
  return <LsClassicTemplate {...templateProps} />;
}
