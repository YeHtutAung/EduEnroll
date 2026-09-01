"use client";

import type { TemplateProps, TemplateClass } from "./types";
import { getCardState, fmtDate, LEVEL_COLORS } from "./types";

// ─── Minimal Template ─────────────────────────────────────────────────────────
// Clean white layout. Centered content. Thin borders. Primary color for accents.

function ClassCard({
  cls,
  primaryColor,
  ctaText,
  onSelect,
}: {
  cls: TemplateClass;
  primaryColor: string;
  ctaText: string;
  onSelect: (id: string) => void;
}) {
  const { isDisabled, overlayState, notYetOpen, alreadyClosed } = getCardState(cls);
  const levelColor = LEVEL_COLORS[cls.level] ?? "bg-gray-100 text-gray-700";

  const closeLabel = cls.enrollment_close_at && !alreadyClosed
    ? `Closes ${fmtDate(cls.enrollment_close_at)}`
    : null;
  const openLabel = cls.enrollment_open_at && notYetOpen
    ? `Opens ${fmtDate(cls.enrollment_open_at, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`
    : null;

  return (
    <div
      role={isDisabled ? undefined : "button"}
      tabIndex={isDisabled ? undefined : 0}
      onClick={() => !isDisabled && onSelect(cls.id)}
      onKeyDown={(e) => { if (!isDisabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(cls.id); } }}
      className={`rounded-xl border bg-white transition-all ${
        isDisabled
          ? "cursor-not-allowed border-gray-200 opacity-70"
          : "cursor-pointer border-gray-200 hover:shadow-md"
      }`}
      style={!isDisabled ? { ["--hover-border" as string]: primaryColor } : undefined}
    >
      {/* Status banner */}
      {overlayState === "full" && (
        <div className="rounded-t-xl bg-gray-100 px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-gray-500">
          FULL — <span className="font-myanmar font-normal">နေရာပြည့်သွားပြီ</span>
        </div>
      )}
      {overlayState === "not_open" && (
        <div className="rounded-t-xl bg-amber-50 px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-amber-600">
          {openLabel}
        </div>
      )}
      {overlayState === "closed" && (
        <div className="rounded-t-xl bg-red-50 px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-red-500">
          ENROLLMENT CLOSED
        </div>
      )}

      <div className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <span className={`rounded-full px-3 py-1 text-sm font-bold ${levelColor}`}>{cls.level}</span>
          {cls.seat_remaining > 0 ? (
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              cls.seat_remaining < 5 ? "bg-orange-100 text-orange-700" : "bg-green-100 text-green-700"
            }`}>
              {cls.seat_remaining} left
            </span>
          ) : (
            <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">Full</span>
          )}
        </div>

        {cls.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cls.image_url} alt={`${cls.level} ticket`} className="mb-4 block w-full h-auto max-h-[420px] rounded-lg object-contain" loading="lazy" decoding="async" />
        )}

        <p className="text-2xl font-bold text-gray-900">{cls.fee_formatted}</p>
        <p className="mb-1 text-sm text-gray-400">
          {(cls.mode ?? "offline") === "online" ? "💻 Online" : "🏫 Offline"}
        </p>

        {closeLabel && (
          <p className="mb-3 text-xs text-gray-400">{closeLabel}</p>
        )}

        {!isDisabled && (
          <div className="mt-4 flex items-center text-sm font-semibold" style={{ color: primaryColor }}>
            {ctaText}
            <svg className="ml-1.5 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MinimalTemplate({ appearance, intake, classes, labels, slug, onSelectClass }: TemplateProps) {
  const { primary_color, logo_url, hero_url, tagline, cta_button_text } = appearance;
  const heroSrc = hero_url ?? intake.hero_image_url;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero */}
      {heroSrc ? (
        <div className="relative overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={heroSrc} alt={intake.name} className="mx-auto block w-full h-auto object-contain" style={{ maxHeight: "40vh" }} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 px-4 pb-8 text-center text-white">
            {logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo_url} alt="logo" className="mx-auto mb-3 h-12 w-12 rounded-full object-cover shadow" />
            )}
            <h1 className="text-2xl font-bold drop-shadow sm:text-3xl">{intake.name}</h1>
            {tagline && <p className="mt-1 text-sm text-white/80">{tagline}</p>}
          </div>
        </div>
      ) : (
        <div className="border-b border-gray-200 bg-white px-4 py-10 text-center">
          {logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo_url} alt="logo" className="mx-auto mb-4 h-14 w-14 rounded-full object-cover shadow-sm" />
          )}
          <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{intake.name}</h1>
          {tagline && <p className="mt-2 text-gray-500">{tagline}</p>}
        </div>
      )}

      {/* Track status */}
      <div className="border-b border-gray-100 bg-white py-3 text-center">
        <a
          href={`/enroll/${slug}/status`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium hover:underline"
          style={{ color: primary_color }}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
          </svg>
          Track enrollment status
        </a>
      </div>

      {/* Classes */}
      <div className="mx-auto max-w-3xl px-4 py-10">
        <h2 className="mb-6 text-center text-sm font-semibold uppercase tracking-widest text-gray-400">
          {labels.class} Options
        </h2>
        {classes.length === 0 ? (
          <p className="py-16 text-center text-gray-400">No classes available yet. Check back soon.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {classes.map((cls) => (
              <ClassCard
                key={cls.id}
                cls={cls}
                primaryColor={primary_color}
                ctaText={cta_button_text}
                onSelect={onSelectClass}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="py-8 text-center text-xs text-gray-400">
        Powered by{" "}
        <a href="https://www.kuunyi.com" target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: primary_color }}>
          KuuNyi
        </a>
      </footer>
    </div>
  );
}
