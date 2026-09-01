"use client";

import type { TemplateProps, TemplateClass } from "./types";
import { getCardState, fmtDate, LEVEL_COLORS } from "./types";

// ─── Bold Template ────────────────────────────────────────────────────────────
// Strong primary-color header. Big typography. High contrast. Energetic.

function hexToRgb(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

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
  const rgb = hexToRgb(primaryColor);

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
      className={`overflow-hidden rounded-2xl shadow-md transition-all ${
        isDisabled ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:-translate-y-1 hover:shadow-xl"
      }`}
    >
      {/* Colored header strip */}
      <div
        className="flex items-center justify-between px-5 py-3"
        style={{ background: `rgba(${rgb}, ${isDisabled ? 0.5 : 1})` }}
      >
        <span className={`rounded-full px-3 py-0.5 text-sm font-bold ${levelColor}`}>{cls.level}</span>
        {cls.seat_remaining > 0 ? (
          <span className="text-xs font-semibold text-white/90">
            {cls.seat_remaining} {cls.seat_remaining === 1 ? "seat" : "seats"} left
          </span>
        ) : (
          <span className="text-xs font-semibold text-white/70">Full</span>
        )}
      </div>

      {/* Status banner */}
      {overlayState === "full" && (
        <div className="bg-gray-700 px-4 py-1.5 text-center text-xs font-bold tracking-widest text-white">
          FULL / <span className="font-myanmar font-normal">နေရာပြည့်သွားပြီ</span>
        </div>
      )}
      {overlayState === "not_open" && (
        <div className="bg-amber-500 px-4 py-1.5 text-center text-xs font-bold tracking-wide text-white">
          {openLabel}
        </div>
      )}
      {overlayState === "closed" && (
        <div className="bg-red-500 px-4 py-1.5 text-center text-xs font-bold tracking-wide text-white">
          ENROLLMENT CLOSED
        </div>
      )}

      <div className="bg-white p-5">
        {cls.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cls.image_url} alt={`${cls.level} ticket`} className="mb-4 block w-full h-auto max-h-[420px] rounded-lg object-contain" loading="lazy" decoding="async" />
        )}

        <p className="text-3xl font-black text-gray-900">{cls.fee_formatted}</p>
        <p className="mb-2 text-sm text-gray-400">
          {(cls.mode ?? "offline") === "online" ? "💻 Online" : "🏫 Offline"}
        </p>
        {closeLabel && <p className="mb-3 text-xs text-gray-400">{closeLabel}</p>}

        {!isDisabled && (
          <button
            className="mt-3 w-full rounded-xl py-3 text-sm font-bold text-white shadow-sm transition-opacity hover:opacity-90"
            style={{ background: primaryColor }}
            onClick={(e) => { e.stopPropagation(); onSelect(cls.id); }}
          >
            {ctaText}
          </button>
        )}
      </div>
    </div>
  );
}

export default function BoldTemplate({ appearance, intake, classes, labels, slug, onSelectClass }: TemplateProps) {
  const { primary_color, logo_url, hero_url, tagline, cta_button_text } = appearance;
  const heroSrc = hero_url ?? intake.hero_image_url;
  const rgb = hexToRgb(primary_color);

  return (
    <div className="min-h-screen bg-white">
      {/* Hero / Header */}
      {heroSrc ? (
        <div className="relative overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={heroSrc} alt={intake.name} className="mx-auto block w-full h-auto object-contain" style={{ maxHeight: "50vh" }} />
          <div className="absolute inset-0" style={{ background: `linear-gradient(to top, rgba(${rgb},0.85) 0%, rgba(${rgb},0.4) 50%, transparent 100%)` }} />
          <div className="absolute bottom-0 left-0 right-0 px-6 pb-10">
            {logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo_url} alt="logo" className="mb-3 h-14 w-14 rounded-full object-cover shadow-lg border-2 border-white" />
            )}
            <h1 className="text-3xl font-black text-white drop-shadow-lg sm:text-5xl">{intake.name}</h1>
            {tagline && <p className="mt-2 text-lg font-semibold text-white/80">{tagline}</p>}
          </div>
        </div>
      ) : (
        <div className="px-6 py-16 sm:px-10" style={{ background: primary_color }}>
          <div className="mx-auto max-w-4xl">
            {logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo_url} alt="logo" className="mb-5 h-16 w-16 rounded-full object-cover shadow-lg border-2 border-white/30" />
            )}
            <h1 className="text-3xl font-black text-white sm:text-5xl">{intake.name}</h1>
            {tagline && <p className="mt-3 text-lg font-semibold text-white/75">{tagline}</p>}
          </div>
        </div>
      )}

      {/* Track status */}
      <div className="border-b border-gray-100 bg-gray-50 py-3 text-center">
        <a
          href={`/enroll/${slug}/status`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide hover:underline"
          style={{ color: primary_color }}
        >
          Track Enrollment Status →
        </a>
      </div>

      {/* Classes */}
      <div className="mx-auto max-w-4xl px-4 py-12">
        <h2 className="mb-8 text-2xl font-black text-gray-900">
          Choose Your {labels.class}
        </h2>
        {classes.length === 0 ? (
          <p className="py-16 text-center text-gray-400">No classes available yet.</p>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
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

      <footer
        className="py-6 text-center text-sm font-semibold text-white"
        style={{ background: primary_color }}
      >
        {intake.name} · Powered by{" "}
        <a href="https://www.kuunyi.com" target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">
          KuuNyi
        </a>
      </footer>
    </div>
  );
}
