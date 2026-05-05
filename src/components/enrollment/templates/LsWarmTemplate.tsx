"use client";

import type { TemplateProps, TemplateClass } from "./types";
import { getCardState, fmtDate } from "./types";

function ClassCard({ cls, primaryColor, onSelect }: { cls: TemplateClass; primaryColor: string; onSelect: (id: string) => void }) {
  const { isDisabled, overlayState } = getCardState(cls);

  const overlayLabel =
    overlayState === "full" ? "Class Full" :
    overlayState === "not_open" ? "Opening Soon" :
    overlayState === "closed" ? "Registration Closed" : null;

  return (
    <div
      className={`relative rounded-2xl overflow-hidden transition-all ${isDisabled ? "opacity-60" : "hover:shadow-xl hover:-translate-y-1 cursor-pointer"}`}
      style={{ backgroundColor: "#fffdf9", border: "1.5px solid #f0e6d3", boxShadow: "0 2px 12px rgba(180,120,60,0.06)" }}
      onClick={() => !isDisabled && onSelect(cls.id)}
    >
      {cls.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cls.image_url} alt={cls.level} className="w-full h-36 object-cover" />
      )}

      <div className="p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-xs font-semibold tracking-widest uppercase mb-1" style={{ color: primaryColor }}>
              {overlayLabel ? overlayLabel : "Open"}
            </p>
            <h3 className="text-3xl font-bold text-gray-800">{cls.level}</h3>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-400 mb-1">Course Fee</p>
            <p className="text-base font-bold text-gray-800 font-myanmar">{cls.fee_formatted}</p>
          </div>
        </div>

        <div className="text-xs text-gray-400 flex items-center gap-3 mb-4">
          <span>🪑 {cls.seat_remaining} of {cls.seat_total} seats</span>
          {cls.enrollment_close_at && (
            <span>📅 Until {fmtDate(cls.enrollment_close_at, { day: "numeric", month: "short" })}</span>
          )}
        </div>

        {!isDisabled && (
          <button
            className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-opacity hover:opacity-85"
            style={{ backgroundColor: primaryColor }}
          >
            Register Now
          </button>
        )}
        {isDisabled && overlayLabel && (
          <div className="w-full py-3 rounded-xl text-sm font-semibold text-center" style={{ backgroundColor: "#f5ede0", color: "#b07050" }}>
            {overlayLabel}
          </div>
        )}
      </div>
    </div>
  );
}

export default function LsWarmTemplate({ appearance, intake, classes, labels, onSelectClass }: TemplateProps) {
  const primary = appearance.primary_color || "#c2622e";
  const logoUrl = appearance.logo_url;
  const heroUrl = appearance.hero_url;
  const tagline = appearance.tagline;
  const ctaText = appearance.cta_button_text || "Register Now";

  return (
    <div className="min-h-screen" style={{ backgroundColor: "#fdf8f2" }}>

      {/* ── Header ──────────────────────────────────────────────── */}
      <header className="px-6 py-4 flex items-center justify-between" style={{ backgroundColor: "#fffdf9", borderBottom: "1px solid #f0e6d3" }}>
        <div className="flex items-center gap-3">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-8 w-auto object-contain" />
          ) : (
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold" style={{ backgroundColor: primary }}>
              {intake.name.charAt(0)}
            </div>
          )}
          <span className="font-semibold text-gray-800">{intake.name} {intake.year}</span>
        </div>
        <span className="text-sm px-3 py-1 rounded-full font-medium" style={{ backgroundColor: `${primary}18`, color: primary }}>
          Enrollment Open
        </span>
      </header>

      {/* ── Hero ────────────────────────────────────────────────── */}
      {heroUrl ? (
        <div className="relative h-56 sm:h-80 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={heroUrl} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, transparent 40%, #fdf8f2)" }} />
        </div>
      ) : (
        <div className="py-14 px-6 text-center">
          <div className="w-12 h-0.5 mx-auto mb-6 rounded-full" style={{ backgroundColor: primary }} />
          <h1 className="text-4xl sm:text-5xl font-bold text-gray-800 mb-4" style={{ fontFamily: "Georgia, serif" }}>
            {intake.name} {intake.year}
          </h1>
          {tagline && (
            <p className="text-gray-500 max-w-md mx-auto leading-relaxed">{tagline}</p>
          )}
          <div className="w-12 h-0.5 mx-auto mt-6 rounded-full" style={{ backgroundColor: primary }} />
        </div>
      )}

      {/* ── Classes ─────────────────────────────────────────────── */}
      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-10">
        {heroUrl && tagline && (
          <p className="text-center text-gray-500 mb-8 leading-relaxed">{tagline}</p>
        )}

        <h2 className="text-sm font-semibold text-center mb-8" style={{ color: primary }}>
          ✦ Choose Your {labels.class} ✦
        </h2>

        {classes.length === 0 ? (
          <div className="text-center py-16 text-gray-400">No classes available right now.</div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            {classes.map((cls) => (
              <ClassCard key={cls.id} cls={cls} primaryColor={primary} onSelect={onSelectClass} />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="py-8 text-center text-xs text-gray-300 border-t" style={{ borderColor: "#f0e6d3" }}>
        {intake.name} {intake.year} · {ctaText}
      </div>
    </div>
  );
}
