"use client";

import type { TemplateProps, TemplateClass } from "./types";
import { getCardState, fmtDate } from "./types";

function ClassCard({ cls, primaryColor, onSelect }: { cls: TemplateClass; primaryColor: string; onSelect: (id: string) => void }) {
  const { isDisabled, overlayState } = getCardState(cls);

  const overlayLabel =
    overlayState === "full" ? "Full" :
    overlayState === "not_open" ? "Opening Soon" :
    overlayState === "closed" ? "Closed" : null;

  const seatPct = cls.seat_total > 0 ? Math.round(((cls.seat_total - cls.seat_remaining) / cls.seat_total) * 100) : 0;

  return (
    <div
      className={`relative bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden transition-all ${isDisabled ? "opacity-60" : "hover:shadow-lg hover:-translate-y-1 cursor-pointer"}`}
      onClick={() => !isDisabled && onSelect(cls.id)}
    >
      {cls.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cls.image_url} alt={`${cls.level} ticket`} className="block w-full h-auto max-h-[420px] object-contain" loading="lazy" decoding="async" />
      )}
      {/* Top color accent */}
      <div className="h-1 w-full" style={{ backgroundColor: primaryColor }} />

      <div className="p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-2xl font-black text-gray-900">{cls.level}</span>
          <span className="text-lg font-bold font-myanmar" style={{ color: primaryColor }}>{cls.fee_formatted}</span>
        </div>

        {/* Seat progress */}
        <div className="mb-4">
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>{cls.seat_remaining} seats left</span>
            <span>{seatPct}% filled</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${seatPct}%`, backgroundColor: primaryColor }} />
          </div>
        </div>

        {cls.enrollment_close_at && (
          <p className="text-xs text-gray-400 mb-4">
            Closes {fmtDate(cls.enrollment_close_at, { day: "numeric", month: "short", year: "numeric" })}
          </p>
        )}

        {!isDisabled ? (
          <button
            className="w-full py-2.5 rounded-xl text-sm font-bold text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: primaryColor }}
          >
            Enroll Now
          </button>
        ) : (
          <div className="w-full py-2.5 rounded-xl text-sm font-semibold text-center text-gray-400 bg-gray-100">
            {overlayLabel}
          </div>
        )}
      </div>
    </div>
  );
}

export default function LsModernTemplate({ appearance, intake, classes, labels, onSelectClass }: TemplateProps) {
  const primary = appearance.primary_color || "#2563eb";
  const logoUrl = appearance.logo_url;
  const heroUrl = appearance.hero_url;
  const tagline = appearance.tagline;
  const ctaText = appearance.cta_button_text || "Enroll Now";

  return (
    <div className="min-h-screen bg-gray-50">

      {/* ── Header bar ──────────────────────────────────────────── */}
      <div className="w-full py-5 px-6 shadow-sm" style={{ backgroundColor: primary }}>
        <div className="mx-auto max-w-5xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" className="h-9 w-auto object-contain brightness-0 invert" />
            ) : null}
            <span className="text-white font-black text-xl tracking-tight">{intake.name} {intake.year}</span>
          </div>
          <span className="text-white/70 text-sm hidden sm:block">{labels.intake} Enrollment</span>
        </div>
      </div>

      {/* ── Hero ────────────────────────────────────────────────── */}
      {heroUrl ? (
        <div className="relative h-52 sm:h-72 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={heroUrl} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-gray-50" />
        </div>
      ) : (
        <div className="py-12 px-6 text-center">
          <h1 className="text-4xl sm:text-5xl font-black text-gray-900 mb-3">
            {intake.name} <span style={{ color: primary }}>{intake.year}</span>
          </h1>
          {tagline && <p className="text-gray-500 text-base max-w-lg mx-auto">{tagline}</p>}
        </div>
      )}

      {/* ── Classes ─────────────────────────────────────────────── */}
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-10">
        {heroUrl && tagline && (
          <p className="text-center text-gray-500 mb-8">{tagline}</p>
        )}

        <h2 className="text-xs font-bold tracking-[0.2em] uppercase text-gray-400 mb-6 text-center">
          Available {labels.class}s
        </h2>

        {classes.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p>No classes available at this time.</p>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {classes.map((cls) => (
              <ClassCard key={cls.id} cls={cls} primaryColor={primary} onSelect={onSelectClass} />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="py-6 text-center text-xs text-gray-300">
        {intake.name} {intake.year} · {ctaText}
      </div>
    </div>
  );
}
