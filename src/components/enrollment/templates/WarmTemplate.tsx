"use client";

import type { TemplateProps, TemplateClass } from "./types";
import { getCardState, fmtDate, LEVEL_COLORS } from "./types";

// ─── Warm Template ────────────────────────────────────────────────────────────
// Soft tinted background, rounded-2xl cards, gentle shadows, italic tagline.
// Friendly and approachable feel.

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
  seatLabel,
  onSelect,
}: {
  cls: TemplateClass;
  primaryColor: string;
  ctaText: string;
  seatLabel: string;
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
      className={`overflow-hidden rounded-2xl bg-white transition-all ${
        isDisabled
          ? "cursor-not-allowed opacity-70 shadow-sm"
          : "cursor-pointer shadow-md hover:-translate-y-0.5 hover:shadow-lg"
      }`}
      style={{ borderTop: `3px solid rgba(${rgb}, ${isDisabled ? 0.3 : 0.7})` }}
    >
      {overlayState === "full" && (
        <div className="px-4 py-1.5 text-center text-xs font-medium text-gray-500" style={{ background: `rgba(${rgb}, 0.05)` }}>
          Full / <span className="font-myanmar">နေရာပြည့်သွားပြီ</span>
        </div>
      )}
      {overlayState === "not_open" && (
        <div className="bg-amber-50 px-4 py-1.5 text-center text-xs font-medium text-amber-600">
          {openLabel}
        </div>
      )}
      {overlayState === "closed" && (
        <div className="bg-red-50 px-4 py-1.5 text-center text-xs font-medium text-red-500">
          Enrollment Closed
        </div>
      )}

      <div className="p-6">
        <div className="mb-4 flex items-start justify-between">
          <span className={`rounded-full px-3 py-1 text-sm font-bold ${levelColor}`}>{cls.level}</span>
          <div className="text-right">
            {cls.seat_remaining > 0 ? (
              <span className="text-xs font-medium text-gray-500">
                {cls.seat_remaining} {seatLabel.toLowerCase()}{cls.seat_remaining !== 1 ? "s" : ""} left
              </span>
            ) : (
              <span className="text-xs font-medium text-gray-400">Full</span>
            )}
          </div>
        </div>

        {cls.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cls.image_url} alt={`${cls.level} ticket`} className="mb-4 block w-full h-auto max-h-[420px] rounded-xl object-contain" loading="lazy" decoding="async" />
        )}

        <p className="text-2xl font-bold text-gray-900">{cls.fee_formatted}</p>
        <p className="mt-1 text-sm text-gray-400">
          {(cls.mode ?? "offline") === "online" ? "💻 Online" : "🏫 Offline"}
        </p>

        {closeLabel && <p className="mt-2 text-xs text-gray-400">{closeLabel}</p>}

        {!isDisabled && (
          <button
            className="mt-5 w-full rounded-xl py-2.5 text-sm font-semibold text-white transition-all hover:opacity-90"
            style={{ background: `linear-gradient(135deg, rgba(${rgb}, 1), rgba(${rgb}, 0.8))` }}
            onClick={(e) => { e.stopPropagation(); onSelect(cls.id); }}
          >
            {ctaText} ✨
          </button>
        )}
      </div>
    </div>
  );
}

export default function WarmTemplate({ appearance, intake, classes, labels, slug, onSelectClass }: TemplateProps) {
  const { primary_color, logo_url, hero_url, tagline, cta_button_text } = appearance;
  const heroSrc = hero_url ?? intake.hero_image_url;
  const rgb = hexToRgb(primary_color);

  return (
    <div className="min-h-screen" style={{ background: `rgba(${rgb}, 0.04)` }}>
      {/* Hero */}
      {heroSrc ? (
        <div className="relative overflow-hidden rounded-b-3xl">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={heroSrc} alt={intake.name} className="mx-auto block w-full h-auto object-contain" style={{ maxHeight: "45vh" }} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 px-6 pb-10 text-white">
            {logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo_url} alt="logo" className="mb-3 h-12 w-12 rounded-full object-cover shadow-md border-2 border-white/60" />
            )}
            <h1 className="text-2xl font-bold sm:text-4xl">{intake.name}</h1>
            {tagline && <p className="mt-1 text-base italic text-white/75">{tagline}</p>}
          </div>
        </div>
      ) : (
        <div className="px-6 py-12 text-center" style={{ background: `rgba(${rgb}, 0.08)` }}>
          {logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo_url} alt="logo" className="mx-auto mb-4 h-16 w-16 rounded-full object-cover shadow-md" />
          )}
          <h1 className="text-2xl font-bold text-gray-900 sm:text-4xl">{intake.name}</h1>
          {tagline && <p className="mt-2 italic text-gray-500">{tagline}</p>}
        </div>
      )}

      {/* Track status */}
      <div className="py-3 text-center">
        <a
          href={`/enroll/${slug}/status`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90"
          style={{ background: primary_color }}
        >
          📋 Track your enrollment status
        </a>
      </div>

      {/* Classes */}
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h2 className="mb-6 text-center text-sm font-semibold uppercase tracking-widest" style={{ color: primary_color }}>
          Available {labels.class}s
        </h2>
        {classes.length === 0 ? (
          <div className="rounded-2xl bg-white py-16 text-center shadow-sm">
            <p className="text-gray-400">No classes available yet. Check back soon! 🌸</p>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            {classes.map((cls) => (
              <ClassCard
                key={cls.id}
                cls={cls}
                primaryColor={primary_color}
                ctaText={cta_button_text}
                seatLabel={labels.seat}
                onSelect={onSelectClass}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="py-8 text-center text-xs text-gray-400">
        Made with ❤️ · Powered by{" "}
        <a href="https://www.kuunyi.com" target="_blank" rel="noopener noreferrer" className="hover:underline" style={{ color: primary_color }}>
          KuuNyi
        </a>
      </footer>
    </div>
  );
}
