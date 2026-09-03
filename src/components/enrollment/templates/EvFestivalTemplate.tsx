"use client";

import { useState } from "react";
import type { EventTemplateProps, TemplateClass } from "./types";
import { getCardState, fmtDate } from "./types";

function TicketCard({
  cls,
  accentColor,
  cartMode,
  cartQty,
  onCartChange,
  onSelect,
  currency,
}: {
  cls: TemplateClass;
  accentColor: string;
  cartMode?: boolean;
  cartQty?: number;
  onCartChange?: (classId: string, level: string, qty: number, fee: number, imageUrl: string | null) => void;
  onSelect: (id: string, quantity: number) => void;
  currency: string;
}) {
  const { isDisabled, overlayState } = getCardState(cls);
  const maxTix = (cls as TemplateClass & { max_tickets_per_person?: number }).max_tickets_per_person ?? 1;
  const [qty, setQty] = useState(1);
  const effectiveQty = cartMode ? (cartQty ?? 0) : qty;
  const isSoldOut = overlayState === "full";

  const overlayLabel =
    overlayState === "full" ? "SOLD OUT" :
    overlayState === "not_open" ? "COMING SOON" :
    overlayState === "closed" ? "ENDED" : null;

  const pctFilled = cls.seat_total > 0 ? Math.round(((cls.seat_total - cls.seat_remaining) / cls.seat_total) * 100) : 0;
  const sellingFast = cls.seat_remaining > 0 && cls.seat_remaining / cls.seat_total <= 0.3;

  function handleQtyChange(delta: number) {
    const next = Math.max(1, Math.min(maxTix, qty + delta));
    setQty(next);
  }

  function handleCartChange(delta: number) {
    const next = Math.max(0, Math.min(maxTix, (cartQty ?? 0) + delta));
    onCartChange?.(cls.id, cls.level, next, cls.fee_amount, cls.image_url ?? null);
  }

  return (
    <div className={`relative rounded-2xl overflow-hidden transition-all duration-300 ${isDisabled && !cartMode ? "opacity-60" : ""}`}
      style={{ background: "rgba(255,255,255,0.07)", border: "1.5px solid rgba(255,255,255,0.12)", backdropFilter: "blur(12px)" }}>
      {cls.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cls.image_url} alt={`${cls.level} ticket`} className="block w-full h-auto max-h-[420px] object-contain" loading="lazy" decoding="async" />
      )}

      {sellingFast && !isSoldOut && (
        <div className="absolute top-3 left-3 text-[10px] font-bold tracking-[2px] uppercase px-2.5 py-1 rounded-full animate-pulse"
          style={{ background: "rgba(239,68,68,0.9)", color: "#fff" }}>
          🔥 Selling Fast
        </div>
      )}

      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="text-xl font-black text-white mb-0.5">{cls.level}</h3>
            <p className="text-sm font-bold" style={{ color: accentColor }}>{cls.fee_formatted}</p>
          </div>
          <div className="text-right text-xs text-white/50">
            {cls.seat_remaining} / {cls.seat_total} left
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden mb-3">
          <div className="h-full rounded-full transition-all" style={{ width: `${pctFilled}%`, backgroundColor: accentColor }} />
        </div>

        {cls.event_date && (
          <p className="text-xs text-white/40 mb-4">
            {fmtDate(cls.event_date, { weekday: "short", day: "numeric", month: "short" })}
            {cls.start_time && ` · ${cls.start_time}`}
            {cls.venue && ` · ${cls.venue}`}
          </p>
        )}
        {cls.enrollment_close_at && !cls.event_date && (
          <p className="text-xs text-white/40 mb-4">Closes {fmtDate(cls.enrollment_close_at, { day: "numeric", month: "short" })}</p>
        )}

        {overlayLabel ? (
          <div className="w-full py-2.5 rounded-xl text-sm font-bold text-center text-white/40 bg-white/5">
            {overlayLabel}
          </div>
        ) : cartMode ? (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-1.5">
              <button className="text-white/60 hover:text-white text-lg leading-none font-bold w-6 text-center" onClick={() => handleCartChange(-1)}>−</button>
              <span className="text-white font-bold text-sm w-4 text-center">{effectiveQty}</span>
              <button className="text-white/60 hover:text-white text-lg leading-none font-bold w-6 text-center" onClick={() => handleCartChange(1)}>+</button>
            </div>
            {effectiveQty > 0 && (
              <span className="text-xs text-white/50 font-myanmar">
                {currency} {(cls.fee_amount * effectiveQty).toLocaleString()}
              </span>
            )}
          </div>
        ) : maxTix > 1 ? (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-1.5">
              <button className="text-white/60 hover:text-white text-lg leading-none font-bold w-6 text-center" onClick={() => handleQtyChange(-1)}>−</button>
              <span className="text-white font-bold text-sm w-4 text-center">{qty}</span>
              <button className="text-white/60 hover:text-white text-lg leading-none font-bold w-6 text-center" onClick={() => handleQtyChange(1)}>+</button>
            </div>
            <button
              className="flex-1 py-2.5 rounded-xl text-sm font-black text-white transition-all hover:brightness-110 active:scale-95"
              style={{ background: `linear-gradient(135deg, ${accentColor}, ${accentColor}cc)` }}
              onClick={() => onSelect(cls.id, qty)}
            >
              Get Tickets
            </button>
          </div>
        ) : (
          <button
            className="w-full py-2.5 rounded-xl text-sm font-black text-white transition-all hover:brightness-110 active:scale-95"
            style={{ background: `linear-gradient(135deg, ${accentColor}, ${accentColor}cc)` }}
            onClick={() => onSelect(cls.id, 1)}
          >
            Get Ticket
          </button>
        )}
      </div>
    </div>
  );
}

export default function EvFestivalTemplate({
  appearance, intake, classes, labels, currency, onSelect, onCartCheckout,
}: EventTemplateProps) {
  const accent = appearance.primary_color || "#f59e0b";
  const logoUrl = appearance.logo_url;
  const heroUrl = intake.hero_image_url || appearance.hero_url;
  const tagline = appearance.tagline;

  const cartableClasses = classes.filter((c) => {
    const max = (c as TemplateClass & { max_tickets_per_person?: number }).max_tickets_per_person ?? 1;
    return max > 1;
  });
  const isCartMode = cartableClasses.length > 0;

  const [cart, setCart] = useState<Record<string, { level: string; qty: number; fee: number; imageUrl: string | null }>>({});

  function handleCartChange(classId: string, level: string, qty: number, fee: number, imageUrl: string | null) {
    setCart((prev) => {
      if (qty === 0) {
        const next = { ...prev };
        delete next[classId];
        return next;
      }
      return { ...prev, [classId]: { level, qty, fee, imageUrl } };
    });
  }

  const cartCount = Object.values(cart).reduce((s, v) => s + v.qty, 0);

  function handleCheckout() {
    onCartCheckout(
      Object.entries(cart).map(([class_id, v]) => ({
        class_id,
        level: v.level,
        quantity: v.qty,
        fee_amount: v.fee,
        image_url: v.imageUrl,
      }))
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "linear-gradient(160deg, #0d0d14 0%, #1a0a2e 50%, #0d1a2e 100%)" }}>

      {/* ── Hero ────────────────────────────────────────────────── */}
      <div className="relative min-h-[50vh] flex flex-col items-center justify-center text-center px-6 py-20 overflow-hidden">
        {heroUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={heroUrl} alt="" className="absolute inset-0 w-full h-full object-cover opacity-40" />
        ) : (
          /* Animated gradient orbs */
          <>
            <div className="absolute top-1/4 left-1/4 w-72 h-72 rounded-full blur-[80px] opacity-20 animate-pulse" style={{ backgroundColor: accent }} />
            <div className="absolute bottom-1/4 right-1/4 w-96 h-96 rounded-full blur-[100px] opacity-15 animate-pulse" style={{ backgroundColor: accent, animationDelay: "1s" }} />
          </>
        )}
        <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, transparent 40%, #0d0d14 100%)" }} />

        <div className="relative z-10 flex flex-col items-center gap-4">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-16 w-auto object-contain mb-2 drop-shadow-lg" />
          ) : null}

          <div className="px-4 py-1.5 rounded-full text-xs font-bold tracking-[3px] uppercase border"
            style={{ borderColor: `${accent}60`, backgroundColor: `${accent}15`, color: accent }}>
            {labels.intake} · {intake.year}
          </div>

          <h1 className="text-5xl sm:text-7xl font-black text-white leading-tight" style={{ letterSpacing: "-0.02em" }}>
            {intake.name}
          </h1>

          {tagline && (
            <p className="text-white/60 text-lg max-w-lg mt-2">{tagline}</p>
          )}
        </div>
      </div>

      {/* ── Tickets ─────────────────────────────────────────────── */}
      <div className="mx-auto max-w-5xl px-4 sm:px-6 pb-24">
        <h2 className="text-center text-sm font-bold tracking-[3px] uppercase mb-8"
          style={{ color: `${accent}99` }}>
          ✦ Tickets ✦
        </h2>

        {classes.length === 0 ? (
          <div className="text-center py-16 text-white/30">No tickets available right now.</div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {classes.map((cls) => (
              <TicketCard
                key={cls.id}
                cls={cls}
                accentColor={accent}
                currency={currency}
                cartMode={isCartMode && ((cls as TemplateClass & { max_tickets_per_person?: number }).max_tickets_per_person ?? 1) > 1}
                cartQty={cart[cls.id]?.qty ?? 0}
                onCartChange={handleCartChange}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Cart bar ────────────────────────────────────────────── */}
      {isCartMode && cartCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 px-4 pb-6">
          <div className="mx-auto max-w-lg rounded-2xl p-4 flex items-center justify-between gap-4"
            style={{ background: "rgba(20,20,30,0.95)", border: `1.5px solid ${accent}40`, backdropFilter: "blur(20px)" }}>
            <div>
              <p className="text-white font-bold text-sm">{cartCount} ticket{cartCount > 1 ? "s" : ""}</p>
              <p className="text-xs font-myanmar" style={{ color: accent }}>
                {currency} {Object.values(cart).reduce((s, v) => s + v.qty * v.fee, 0).toLocaleString()}
              </p>
            </div>
            <button
              className="px-6 py-2.5 rounded-xl text-sm font-black text-white transition-all hover:brightness-110 active:scale-95"
              style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}
              onClick={handleCheckout}
            >
              Checkout →
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="py-6 text-center text-xs text-white/20">{intake.name} {intake.year}</div>
    </div>
  );
}
