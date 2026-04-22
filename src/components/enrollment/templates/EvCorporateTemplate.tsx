"use client";

import { useState } from "react";
import type { EventTemplateProps, TemplateClass } from "./types";
import { getCardState, fmtDate } from "./types";

function TicketCard({
  cls,
  primaryColor,
  cartMode,
  cartQty,
  onCartChange,
  onSelect,
  currency,
}: {
  cls: TemplateClass;
  primaryColor: string;
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

  const overlayLabel =
    overlayState === "full" ? "Sold Out" :
    overlayState === "not_open" ? "Coming Soon" :
    overlayState === "closed" ? "Registration Closed" : null;

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
    <div className={`relative bg-white rounded-xl overflow-hidden border transition-all duration-200 ${isDisabled && !cartMode ? "opacity-60" : "hover:shadow-lg hover:-translate-y-0.5 cursor-pointer"}`}
      style={{ borderColor: "#e2e8f0" }}>
      {cls.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cls.image_url} alt={cls.level} className="w-full h-36 object-cover" />
      )}
      <div className="h-1 w-full" style={{ backgroundColor: primaryColor }} />

      <div className="p-5">
        {sellingFast && !overlayLabel && (
          <div className="inline-block text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded mb-2 bg-red-50 text-red-600">
            Limited seats
          </div>
        )}

        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="text-lg font-bold text-gray-900">{cls.level}</h3>
            <p className="text-sm font-semibold font-myanmar mt-0.5" style={{ color: primaryColor }}>{cls.fee_formatted}</p>
          </div>
          <div className="text-right text-xs text-gray-400 mt-0.5">
            <div>{cls.seat_remaining} of {cls.seat_total}</div>
            <div>seats left</div>
          </div>
        </div>

        {/* Seat fill bar */}
        <div className="h-1 rounded-full bg-gray-100 overflow-hidden mb-3">
          <div className="h-full rounded-full" style={{ width: `${pctFilled}%`, backgroundColor: primaryColor }} />
        </div>

        {cls.event_date && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-400 mb-4">
            <span>📅 {fmtDate(cls.event_date, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</span>
            {cls.start_time && <span>🕐 {cls.start_time}{cls.end_time ? ` – ${cls.end_time}` : ""}</span>}
            {cls.venue && <span>📍 {cls.venue}</span>}
          </div>
        )}
        {cls.enrollment_close_at && !cls.event_date && (
          <p className="text-xs text-gray-400 mb-4">
            Register by {fmtDate(cls.enrollment_close_at, { day: "numeric", month: "long", year: "numeric" })}
          </p>
        )}

        {overlayLabel ? (
          <div className="w-full py-2.5 rounded-lg text-sm font-semibold text-center text-gray-400 bg-gray-50">
            {overlayLabel}
          </div>
        ) : cartMode ? (
          <div className="flex items-center gap-3">
            <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
              <button className="px-3 py-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 text-sm font-bold" onClick={() => handleCartChange(-1)}>−</button>
              <span className="px-3 py-2 text-sm font-bold text-gray-900 border-x border-gray-200">{effectiveQty}</span>
              <button className="px-3 py-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 text-sm font-bold" onClick={() => handleCartChange(1)}>+</button>
            </div>
            {effectiveQty > 0 && (
              <span className="text-xs text-gray-400 font-myanmar">
                {currency} {(cls.fee_amount * effectiveQty).toLocaleString()}
              </span>
            )}
          </div>
        ) : maxTix > 1 ? (
          <div className="flex items-center gap-3">
            <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
              <button className="px-3 py-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 text-sm font-bold" onClick={() => handleQtyChange(-1)}>−</button>
              <span className="px-3 py-2 text-sm font-bold text-gray-900 border-x border-gray-200">{qty}</span>
              <button className="px-3 py-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 text-sm font-bold" onClick={() => handleQtyChange(1)}>+</button>
            </div>
            <button
              className="flex-1 py-2.5 rounded-lg text-sm font-bold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: primaryColor }}
              onClick={() => onSelect(cls.id, qty)}
            >
              Register
            </button>
          </div>
        ) : (
          <button
            className="w-full py-2.5 rounded-lg text-sm font-bold text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: primaryColor }}
            onClick={() => onSelect(cls.id, 1)}
          >
            Register Now
          </button>
        )}
      </div>
    </div>
  );
}

export default function EvCorporateTemplate({
  appearance, intake, classes, labels, currency, onSelect, onCartCheckout,
}: EventTemplateProps) {
  const primary = appearance.primary_color || "#0f172a";
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
  const cartTotal = Object.values(cart).reduce((s, v) => s + v.qty * v.fee, 0);

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
    <div className="min-h-screen bg-gray-50">

      {/* ── Top bar ─────────────────────────────────────────────── */}
      <div className="w-full py-4 px-6 bg-white border-b border-gray-200 shadow-sm">
        <div className="mx-auto max-w-5xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" className="h-8 w-auto object-contain" />
            ) : (
              <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-black" style={{ backgroundColor: primary }}>
                {intake.name.charAt(0)}
              </div>
            )}
            <div>
              <p className="font-bold text-gray-900 text-sm">{intake.name}</p>
              <p className="text-xs text-gray-400">{intake.year}</p>
            </div>
          </div>
          <span className="hidden sm:block text-xs font-semibold px-3 py-1 rounded-full"
            style={{ backgroundColor: `${primary}12`, color: primary }}>
            {labels.intake} Registration
          </span>
        </div>
      </div>

      {/* ── Hero ────────────────────────────────────────────────── */}
      {heroUrl ? (
        <div className="relative h-48 sm:h-64 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={heroUrl} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-gray-50" />
        </div>
      ) : (
        <div className="py-10 px-6 text-center" style={{ borderBottom: "1px solid #e2e8f0", backgroundColor: "#fff" }}>
          <h1 className="text-3xl sm:text-4xl font-black text-gray-900 mb-2">{intake.name} <span style={{ color: primary }}>{intake.year}</span></h1>
          {tagline && <p className="text-gray-500 text-sm max-w-lg mx-auto">{tagline}</p>}
        </div>
      )}

      {/* ── Registration cards ──────────────────────────────────── */}
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-10">
        {heroUrl && tagline && (
          <p className="text-center text-gray-500 text-sm mb-8">{tagline}</p>
        )}

        <h2 className="text-xs font-bold tracking-widest uppercase text-gray-400 mb-6">
          Available {labels.class}s
        </h2>

        {classes.length === 0 ? (
          <div className="text-center py-16 text-gray-400">No sessions available at this time.</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {classes.map((cls) => (
              <TicketCard
                key={cls.id}
                cls={cls}
                primaryColor={primary}
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
          <div className="mx-auto max-w-lg bg-white rounded-xl shadow-xl p-4 flex items-center justify-between gap-4 border border-gray-200">
            <div>
              <p className="text-gray-900 font-bold text-sm">{cartCount} ticket{cartCount > 1 ? "s" : ""} selected</p>
              <p className="text-xs text-gray-500 font-myanmar">{currency} {cartTotal.toLocaleString()}</p>
            </div>
            <button
              className="px-6 py-2.5 rounded-lg text-sm font-bold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: primary }}
              onClick={handleCheckout}
            >
              Proceed to Register →
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="py-8 text-center text-xs text-gray-300 border-t border-gray-100">
        {intake.name} {intake.year}
      </div>
    </div>
  );
}
