"use client";

import type { TemplateProps, TemplateClass } from "./types";
import { getCardState, fmtDate } from "./types";

function ClassCard({ cls, primaryColor, onSelect }: { cls: TemplateClass; primaryColor: string; onSelect: (id: string) => void }) {
  const { isDisabled, overlayState } = getCardState(cls);

  const overlayLabel =
    overlayState === "full" ? "FULL" :
    overlayState === "not_open" ? "OPENING SOON" :
    overlayState === "closed" ? "CLOSED" : null;

  return (
    <div
      className={`relative rounded-xl border overflow-hidden transition-all duration-200 ${isDisabled ? "opacity-60" : "hover:scale-[1.02] cursor-pointer"}`}
      style={{ borderColor: "rgba(255,255,255,0.12)", backgroundColor: "rgba(255,255,255,0.05)" }}
      onClick={() => !isDisabled && onSelect(cls.id)}
    >
      {cls.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cls.image_url} alt={cls.level} className="w-full h-32 object-cover opacity-70" />
      )}
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold tracking-[0.2em] uppercase mb-1" style={{ color: primaryColor }}>
              Level
            </p>
            <h3 className="text-2xl font-bold text-white" style={{ fontFamily: "'Cormorant Garamond', serif" }}>
              {cls.level}
            </h3>
          </div>
          <div className="text-right">
            <p className="text-xs font-bold tracking-[0.2em] uppercase mb-1" style={{ color: primaryColor }}>
              Fee
            </p>
            <p className="text-lg font-semibold text-white font-myanmar">{cls.fee_formatted}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between text-xs" style={{ color: "rgba(255,255,255,0.45)" }}>
          <span>{cls.seat_remaining} / {cls.seat_total} seats</span>
          {cls.enrollment_close_at && (
            <span>Closes {fmtDate(cls.enrollment_close_at, { day: "numeric", month: "short" })}</span>
          )}
        </div>

        {!isDisabled && (
          <button
            className="mt-4 w-full py-2.5 text-sm font-bold tracking-[0.1em] uppercase rounded-lg transition-opacity hover:opacity-80"
            style={{ backgroundColor: primaryColor, color: "#0a0e1a" }}
          >
            Enroll
          </button>
        )}
      </div>

      {overlayLabel && (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl" style={{ backgroundColor: "rgba(10,14,26,0.6)" }}>
          <span className="text-xs font-bold tracking-[0.3em] uppercase px-4 py-1.5 rounded-full border" style={{ borderColor: primaryColor, color: primaryColor }}>
            {overlayLabel}
          </span>
        </div>
      )}
    </div>
  );
}

export default function LsClassicTemplate({ appearance, intake, classes, labels, onSelectClass }: TemplateProps) {
  const primary = appearance.primary_color || "#c9a84c";
  const logoUrl = appearance.logo_url;
  const heroUrl = appearance.hero_url;
  const tagline = appearance.tagline;
  const ctaText = appearance.cta_button_text || "Enroll Now";

  // Derive intake month/year display
  const intakeDisplay = `${intake.name} ${intake.year}`;

  return (
    <div className="min-h-screen" style={{ background: "#0a0e1a", color: "#f0ece4" }}>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap"
        rel="stylesheet"
      />

      {/* ── Hero ────────────────────────────────────────────────── */}
      <div
        className="relative flex flex-col items-center justify-center text-center px-6 py-24 sm:py-36"
        style={{
          backgroundImage: heroUrl ? `url(${heroUrl})` : undefined,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        {/* Overlay */}
        <div className="absolute inset-0" style={{ background: heroUrl ? "rgba(10,14,26,0.72)" : "linear-gradient(160deg,#0a0e1a 0%,#111827 100%)" }} />

        {/* Gold decorative line */}
        <div className="relative z-10 flex flex-col items-center gap-6">
          <div className="h-px w-16 mb-2" style={{ backgroundColor: primary }} />

          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-14 w-auto object-contain" />
          ) : null}

          <p className="text-xs font-bold tracking-[0.35em] uppercase" style={{ color: primary }}>
            {intakeDisplay}
          </p>

          <h1
            className="text-5xl sm:text-7xl font-light"
            style={{ fontFamily: "'Cormorant Garamond', serif", lineHeight: 1.05, letterSpacing: "0.02em" }}
          >
            {labels.intake} Enrollment
          </h1>

          {tagline && (
            <p className="text-base font-light max-w-md" style={{ color: "rgba(240,236,228,0.65)", fontFamily: "'DM Sans', sans-serif" }}>
              {tagline}
            </p>
          )}

          <div className="h-px w-16 mt-2" style={{ backgroundColor: primary }} />
        </div>
      </div>

      {/* ── Classes ─────────────────────────────────────────────── */}
      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-16">
        <p className="text-center text-xs font-bold tracking-[0.35em] uppercase mb-12" style={{ color: primary }}>
          Available {labels.class}s
        </p>

        {classes.length === 0 ? (
          <div className="text-center py-16" style={{ color: "rgba(240,236,228,0.4)" }}>
            <p className="text-lg">No classes available at this time.</p>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {classes.map((cls) => (
              <ClassCard key={cls.id} cls={cls} primaryColor={primary} onSelect={onSelectClass} />
            ))}
          </div>
        )}

        {/* CTA */}
        <div className="mt-16 text-center">
          <p className="text-xs tracking-[0.2em] uppercase mb-4" style={{ color: "rgba(240,236,228,0.35)" }}>
            Ready to begin?
          </p>
          <p className="text-sm" style={{ color: "rgba(240,236,228,0.45)", fontFamily: "'DM Sans', sans-serif" }}>
            Select a level above to {ctaText.toLowerCase()}.
          </p>
        </div>
      </div>

      {/* Bottom accent */}
      <div className="h-px w-full" style={{ backgroundColor: primary, opacity: 0.3 }} />
      <div className="py-8 text-center text-xs tracking-widest uppercase" style={{ color: "rgba(240,236,228,0.2)" }}>
        {intake.name} {intake.year}
      </div>
    </div>
  );
}
