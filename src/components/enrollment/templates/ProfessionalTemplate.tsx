"use client";

import type { TemplateProps, TemplateClass } from "./types";
import { getCardState, fmtDate, LEVEL_COLORS } from "./types";

// ─── Professional Template ────────────────────────────────────────────────────
// Two-column layout: sidebar (school info) + main (class list).
// Clean, structured, corporate feel. Collapses to single column on mobile.

function ClassRow({
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
    ? fmtDate(cls.enrollment_close_at)
    : null;
  const openLabel = cls.enrollment_open_at && notYetOpen
    ? fmtDate(cls.enrollment_open_at, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div
      className={`flex items-center gap-4 border-b border-gray-100 py-4 transition-colors last:border-0 ${
        isDisabled ? "opacity-60" : "hover:bg-gray-50"
      }`}
    >
      {/* Level */}
      <div className="w-16 shrink-0 text-center">
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${levelColor}`}>{cls.level}</span>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-gray-900">{cls.fee_formatted}</span>
          <span className="text-xs text-gray-400">
            {(cls.mode ?? "offline") === "online" ? "Online" : "Offline"}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-gray-400">
          {closeLabel && !isDisabled && <span>Closes {closeLabel}</span>}
          {openLabel && <span className="text-amber-600">Opens {openLabel}</span>}
          {overlayState === "full" && <span className="font-myanmar text-gray-500">နေရာပြည့်သွားပြီ</span>}
          {overlayState === "closed" && <span className="text-red-500">Closed</span>}
          <span>
            {cls.seat_remaining > 0
              ? `${cls.seat_remaining} seat${cls.seat_remaining !== 1 ? "s" : ""} available`
              : "Full"}
          </span>
        </div>
      </div>

      {/* Image if any */}
      {cls.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cls.image_url} alt={cls.level} className="h-12 w-16 shrink-0 rounded object-cover" />
      )}

      {/* CTA */}
      <div className="shrink-0">
        {!isDisabled ? (
          <button
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            style={{ background: primaryColor }}
            onClick={() => onSelect(cls.id)}
          >
            {ctaText}
          </button>
        ) : (
          <span className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-400">
            {overlayState === "full" ? "Full" : "Closed"}
          </span>
        )}
      </div>
    </div>
  );
}

export default function ProfessionalTemplate({ appearance, intake, classes, labels, slug, onSelectClass }: TemplateProps) {
  const { primary_color, logo_url, hero_url, tagline, cta_button_text } = appearance;
  const heroSrc = hero_url ?? intake.hero_image_url;

  const openCount = classes.filter((c) => c.seat_remaining > 0 && c.status === "open").length;
  const totalSeats = classes.reduce((s, c) => s + c.seat_remaining, 0);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <div className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            {logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo_url} alt="logo" className="h-10 w-10 rounded-full object-cover" />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-full text-white font-bold text-lg" style={{ background: primary_color }}>
                {intake.name[0]}
              </div>
            )}
            <div>
              <p className="font-semibold text-gray-900 leading-tight">{intake.name}</p>
              {tagline && <p className="text-xs text-gray-500">{tagline}</p>}
            </div>
          </div>
          <a
            href={`/enroll/${slug}/status`}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium sm:flex"
            style={{ borderColor: primary_color, color: primary_color }}
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
            </svg>
            Track Status
          </a>
        </div>
      </div>

      {/* Hero image if present */}
      {heroSrc && (
        <div className="overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={heroSrc} alt={intake.name} className="w-full object-cover" style={{ maxHeight: "30vh" }} />
        </div>
      )}

      {/* Main content */}
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="gap-8 lg:flex lg:items-start">
          {/* ── Sidebar ── */}
          <aside className="mb-8 shrink-0 lg:mb-0 lg:w-64">
            <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="mb-1 text-base font-bold text-gray-900">{intake.name}</h2>
              <p className="mb-5 text-xs text-gray-500">{intake.year}</p>

              {/* Stats */}
              <div className="mb-5 space-y-2">
                <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
                  <span className="text-xs text-gray-500">{labels.class}s Available</span>
                  <span className="text-sm font-bold text-gray-900">{openCount}</span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
                  <span className="text-xs text-gray-500">Total {labels.seat}s</span>
                  <span className="text-sm font-bold text-gray-900">{totalSeats}</span>
                </div>
              </div>

              {/* How to enroll steps */}
              <div>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">How to Enroll</p>
                <ol className="space-y-2.5">
                  {[
                    "Choose a class below",
                    "Fill in your details",
                    "Submit payment proof",
                    "Get confirmation",
                  ].map((step, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-xs text-gray-600">
                      <span
                        className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                        style={{ background: primary_color }}
                      >
                        {i + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
              </div>

              {/* Mobile track status */}
              <a
                href={`/enroll/${slug}/status`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-5 flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-medium lg:hidden"
                style={{ borderColor: primary_color, color: primary_color }}
              >
                📋 Track Your Status
              </a>
            </div>
          </aside>

          {/* ── Class list ── */}
          <main className="flex-1 min-w-0">
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
              <div className="border-b border-gray-100 px-6 py-4">
                <h2 className="text-base font-bold text-gray-900">
                  Available {labels.class}s
                </h2>
                <p className="text-xs text-gray-400">{intake.name} · {intake.year}</p>
              </div>

              {classes.length === 0 ? (
                <div className="py-16 text-center text-gray-400">
                  No classes available yet. Please check back soon.
                </div>
              ) : (
                <div className="divide-y divide-gray-50 px-6">
                  {classes.map((cls) => (
                    <ClassRow
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
          </main>
        </div>
      </div>

      <footer className="py-6 text-center text-xs text-gray-400">
        Powered by{" "}
        <a href="https://www.kuunyi.com" target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: primary_color }}>
          KuuNyi
        </a>
      </footer>
    </div>
  );
}
