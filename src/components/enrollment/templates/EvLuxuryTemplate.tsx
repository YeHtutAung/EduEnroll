"use client";

import { useState } from "react";
import { formatCurrency, formatAmount } from "@/lib/utils";
import { getCardState } from "./types";
import type { EventTemplateProps, TemplateClass } from "./types";

// ─── Seat badge ───────────────────────────────────────────────────────────────

function EventSeatsBadge({ remaining, total, gold }: { remaining: number; total: number; gold: string }) {
  if (remaining === 0) {
    return (
      <span className="text-[11px] tracking-wider px-2.5 py-1 rounded-sm border border-red-500/30 bg-red-500/10 text-red-300">
        SOLD OUT
      </span>
    );
  }
  const pctLeft = total > 0 ? (remaining / total) * 100 : 100;
  const isSellingFast = pctLeft <= 30 && remaining > 0;
  return (
    <div className="flex flex-col items-end gap-1">
      {isSellingFast && (
        <span className="text-[9px] tracking-[2px] uppercase font-semibold px-2 py-0.5 rounded-sm animate-pulse"
          style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}>
          Selling Fast
        </span>
      )}
      <span className="text-[11px] tracking-wider px-2.5 py-1 rounded-sm border whitespace-nowrap"
        style={remaining < 10
          ? { borderColor: `${gold}4d`, backgroundColor: `${gold}1a`, color: gold, animation: "pulse 2s infinite" }
          : remaining < 100
            ? { borderColor: "rgba(251,191,36,0.2)", backgroundColor: "rgba(251,191,36,0.08)", color: "#fcd34d" }
            : { borderColor: "rgba(74,222,128,0.2)", backgroundColor: "rgba(74,222,128,0.08)", color: "#86efac" }}>
        {remaining.toLocaleString()} left
      </span>
    </div>
  );
}

// ─── Ticket card ──────────────────────────────────────────────────────────────

function TicketCard({
  cls, onSelect, isHighestTier, index, cartMode, cartQty, onCartChange, currency, gold, goldLight,
}: {
  cls: TemplateClass;
  onSelect: (id: string, quantity: number) => void;
  isHighestTier: boolean;
  index: number;
  cartMode?: boolean;
  cartQty?: number;
  onCartChange?: (classId: string, level: string, qty: number, fee: number, imageUrl: string | null) => void;
  currency: string;
  gold: string;
  goldLight: string;
}) {
  const maxTix = cls.max_tickets_per_person ?? 1;
  const [qty, setQty] = useState(1);
  const effectiveQty = cartMode ? (cartQty ?? 0) : qty;
  // Card state comes from the shared helper rather than being recomputed here.
  // This template used to inline the same four booleans, and that is exactly
  // how it drifted: the priority window shipped, getCardState learned to honour
  // priority_unlocked, and this copy went on locking token holders out.
  const { isDisabled, overlayState } = getCardState(cls);
  const fmtOpts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  const closeDate = cls.enrollment_close_at ? new Date(cls.enrollment_close_at).toLocaleDateString("en-GB", fmtOpts) : null;
  const openDate = cls.enrollment_open_at ? new Date(cls.enrollment_open_at).toLocaleDateString("en-GB", { ...fmtOpts, hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <div
      className={`group relative overflow-hidden transition-all duration-500 cursor-pointer ${
        isHighestTier ? "bg-gradient-to-br from-[#171208] to-[#1a1508]" : "bg-[#111]"
      } ${isDisabled ? "opacity-60 cursor-not-allowed" : "hover:-translate-y-1.5"}`}
      style={{ animationDelay: `${index * 0.1}s` }}
      onClick={() => { if (!isDisabled && !cartMode && maxTix <= 1) onSelect(cls.id, 1); }}
    >
      {/* Hover gold overlay */}
      <div className={`absolute inset-0 bg-gradient-to-br from-[${gold}]/[0.08] to-transparent transition-opacity duration-500 ${isHighestTier ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`} />

      {/* Shimmer border */}
      <div className="absolute inset-0 border border-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ background: `linear-gradient(#111, #111) padding-box, linear-gradient(135deg, ${gold}, transparent 60%) border-box` }} />

      {/* Watermark */}
      <div className="absolute -bottom-5 -right-2 select-none pointer-events-none leading-none"
        style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: "140px", letterSpacing: "4px", color: isHighestTier ? `${gold}0a` : "rgba(255,255,255,0.02)" }}>
        {cls.level}
      </div>

      {/* Status banners */}
      {overlayState === "full" && (
        <div className="relative z-10 bg-white/5 px-6 py-2.5 text-center text-[11px] font-medium tracking-[3px] text-white/60 uppercase">
          SOLD OUT / <span className="font-myanmar font-normal tracking-normal">နေရာပြည့်သွားပြီ</span>
        </div>
      )}
      {overlayState === "not_open" && (
        <div className="relative z-10 px-6 py-2.5 text-center" style={{ background: `${gold}26` }}>
          <p className="text-[11px] font-medium tracking-[3px] uppercase" style={{ color: goldLight }}>OPENS {openDate?.toUpperCase()}</p>
          <p className="font-myanmar text-[10px] mt-0.5" style={{ color: `${gold}99` }}>စာရင်းသွင်းချိန် မရောက်သေးပါ</p>
        </div>
      )}
      {overlayState === "closed" && (
        <div className="relative z-10 bg-red-500/10 px-6 py-2.5 text-center">
          <p className="text-[11px] font-medium tracking-[3px] text-red-300 uppercase">ENROLLMENT CLOSED</p>
          <p className="font-myanmar text-[10px] text-red-400/60 mt-0.5">စာရင်းသွင်းချိန် ကုန်ဆုံးသွားပြီ</p>
        </div>
      )}

      {cls.image_url && (
        <div className="relative z-10 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cls.image_url} alt={cls.level} className="w-full h-auto object-cover max-h-52 sm:max-h-64" />
          <div className="absolute inset-0 bg-gradient-to-t from-[#111] via-transparent to-transparent" />
        </div>
      )}

      <div className={`relative z-10 px-8 ${cls.image_url ? "pt-6 pb-10" : "py-10"} sm:px-10 ${cls.image_url ? "sm:pt-8 sm:pb-12" : "sm:py-12"}`}>
        <div className="flex items-start justify-between mb-8">
          <span className={`text-[11px] font-medium tracking-[3px] uppercase px-3 py-1.5 rounded-sm border`}
            style={isHighestTier ? { borderColor: `${gold}66`, color: gold } : { borderColor: "rgba(255,255,255,0.1)", color: "#888880" }}>
            {cls.level}
          </span>
          <EventSeatsBadge remaining={cls.seat_remaining} total={cls.seat_total} gold={gold} />
        </div>

        <div className="mb-8">
          <div className="text-[52px] sm:text-[56px] font-bold leading-none mb-1.5 tracking-wider"
            style={{
              fontFamily: "'Bebas Neue', sans-serif",
              ...(isHighestTier
                ? { background: `linear-gradient(135deg, ${goldLight}, ${gold})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }
                : { color: "#F8F4EE" }),
            }}>
            {cls.fee_amount.toLocaleString()}
          </div>
          <div className="font-myanmar text-base tracking-wider" style={{ color: "#888880" }}>
            {currency === "MMK" ? `${formatAmount(cls.fee_amount)} ကျပ် · MMK` : formatCurrency(cls.fee_amount, currency)}
          </div>
        </div>

        <div className="w-full h-px mb-7"
          style={{ background: isHighestTier ? `linear-gradient(to right, ${gold}33, transparent)` : "linear-gradient(to right, rgba(255,255,255,0.06), transparent)" }} />

        <div className="flex flex-col gap-3 mb-8 text-[13px]" style={{ color: "#888880" }}>
          <div className="flex items-center gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" style={{ boxShadow: "0 0 6px rgba(255,107,107,0.5)" }} />
            {(cls.mode ?? "offline") === "online" ? "Online Event" : "Offline Event"}
          </div>
          {closeDate && !isDisabled && (
            <div className="flex items-center gap-3">
              <svg className="w-3.5 h-3.5 opacity-50 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5" />
              </svg>
              Closes {closeDate}
            </div>
          )}
          {cls.event_date && (
            <div className="flex items-center gap-3">
              <svg className="w-3.5 h-3.5 opacity-50 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5" />
              </svg>
              {new Date(cls.event_date + "T00:00:00").toLocaleDateString("en-GB", fmtOpts)}
            </div>
          )}
          {cls.venue && (
            <div className="flex items-center gap-3">
              <svg className="w-3.5 h-3.5 opacity-50 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
              </svg>
              {cls.venue}
            </div>
          )}
        </div>

        {/* Cart qty selector */}
        {!isDisabled && cartMode && (
          <div className="flex items-center justify-between mb-6 px-1">
            <span className="text-[12px] tracking-[1px] uppercase" style={{ color: "#888880" }}>
              Qty <span className="font-myanmar tracking-normal">(အရေအတွက်)</span>
            </span>
            {effectiveQty === 0 ? (
              <button type="button" onClick={(e) => { e.stopPropagation(); onCartChange?.(cls.id, cls.level, 1, cls.fee_amount, cls.image_url ?? null); }}
                className="px-4 py-2 rounded-sm text-[11px] font-medium tracking-[1.5px] uppercase border transition-all duration-300"
                style={isHighestTier ? { borderColor: `${gold}66`, color: goldLight } : { borderColor: "rgba(255,255,255,0.12)", color: "#F8F4EE" }}>
                Add to Cart
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <button type="button" onClick={(e) => { e.stopPropagation(); onCartChange?.(cls.id, cls.level, effectiveQty - 1, cls.fee_amount, cls.image_url ?? null); }}
                  className="w-8 h-8 rounded-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white flex items-center justify-center transition-colors text-lg">−</button>
                <span className="text-xl font-bold min-w-[2ch] text-center" style={{ fontFamily: "'Bebas Neue', sans-serif", color: isHighestTier ? goldLight : "#F8F4EE" }}>{effectiveQty}</span>
                <button type="button" onClick={(e) => { e.stopPropagation(); const max = Math.min(maxTix, cls.seat_remaining); if (effectiveQty < max) onCartChange?.(cls.id, cls.level, effectiveQty + 1, cls.fee_amount, cls.image_url ?? null); }}
                  className="w-8 h-8 rounded-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white flex items-center justify-center transition-colors text-lg">+</button>
              </div>
            )}
          </div>
        )}

        {/* Non-cart multi-ticket qty */}
        {!isDisabled && !cartMode && maxTix > 1 && (
          <div className="flex items-center justify-between mb-6 px-1">
            <span className="text-[12px] tracking-[1px] uppercase" style={{ color: "#888880" }}>Qty</span>
            <div className="flex items-center gap-3">
              <button type="button" onClick={(e) => { e.stopPropagation(); setQty((q) => Math.max(1, q - 1)); }}
                className="w-8 h-8 rounded-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white flex items-center justify-center transition-colors text-lg">−</button>
              <span className="text-xl font-bold min-w-[2ch] text-center" style={{ fontFamily: "'Bebas Neue', sans-serif", color: isHighestTier ? goldLight : "#F8F4EE" }}>{qty}</span>
              <button type="button" onClick={(e) => { e.stopPropagation(); setQty((q) => Math.min(maxTix, cls.seat_remaining, q + 1)); }}
                className="w-8 h-8 rounded-sm border border-white/15 text-white/70 hover:border-white/30 hover:text-white flex items-center justify-center transition-colors text-lg">+</button>
            </div>
          </div>
        )}

        {!isDisabled && cartMode && effectiveQty > 1 && (
          <div className="mb-6 text-right text-[13px]" style={{ color: "#888880" }}>
            Total: <span style={{ color: isHighestTier ? goldLight : "#F8F4EE" }} className="font-semibold">{formatCurrency(cls.fee_amount * effectiveQty, currency)}</span>
          </div>
        )}
        {!isDisabled && !cartMode && maxTix > 1 && qty > 1 && (
          <div className="mb-6 text-right text-[13px]" style={{ color: "#888880" }}>
            Total: <span style={{ color: isHighestTier ? goldLight : "#F8F4EE" }} className="font-semibold">{formatCurrency(cls.fee_amount * qty, currency)}</span>
          </div>
        )}

        {!isDisabled && !cartMode && (
          <button onClick={(e) => { e.stopPropagation(); onSelect(cls.id, qty); }}
            className="group/btn relative w-full flex items-center justify-between px-6 py-4 text-[13px] font-medium tracking-[2px] uppercase rounded-sm border overflow-hidden transition-all duration-300"
            style={isHighestTier
              ? { borderColor: `${gold}66`, color: goldLight, background: `linear-gradient(to right, ${gold}26, ${gold}0d)` }
              : { borderColor: "rgba(255,255,255,0.12)", color: "#F8F4EE" }}>
            <span className="absolute left-0 top-0 bottom-0 w-0 bg-white/5 transition-all duration-500 group-hover/btn:w-full" />
            <span className="relative">{maxTix > 1 && qty > 1 ? `Buy ${qty} Tickets` : "Buy Now"}</span>
            <svg className="relative w-5 h-5 transition-transform duration-300 group-hover/btn:translate-x-1" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12h15m0 0l-6.75-6.75M19.5 12l-6.75 6.75" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main template ────────────────────────────────────────────────────────────

export default function EvLuxuryTemplate({ appearance, intake, classes, slug, currency, onSelect, onCartCheckout }: EventTemplateProps) {
  const gold = appearance.primary_color || "#C9A84C";
  const goldLight = appearance.primary_color ? appearance.primary_color : "#E8C97A";
  const logoUrl = appearance.logo_url;
  const heroUrl = intake.hero_image_url || appearance.hero_url;
  const tagline = appearance.tagline;

  const [cart, setCart] = useState<Map<string, { classId: string; level: string; qty: number; fee: number; imageUrl: string | null }>>(new Map());
  const cartTotal = Array.from(cart.values()).reduce((sum, i) => sum + i.fee * i.qty, 0);
  const cartItemCount = Array.from(cart.values()).reduce((sum, i) => sum + i.qty, 0);
  const hasMultipleTickets = classes.filter((c) => c.seat_remaining > 0 && c.status === "open").length > 1;
  const maxFee = classes.length > 0 ? Math.max(...classes.map((c) => c.fee_amount)) : 0;

  function handleAddToCart(classId: string, level: string, qty: number, fee: number, imageUrl: string | null) {
    setCart((prev) => {
      const next = new Map(prev);
      if (qty <= 0) next.delete(classId);
      else next.set(classId, { classId, level, qty, fee, imageUrl });
      return next;
    });
  }

  function handleCartCheckout() {
    onCartCheckout(Array.from(cart.values()).map((item) => ({
      class_id: item.classId, level: item.level, quantity: item.qty, fee_amount: item.fee, image_url: item.imageUrl,
    })));
  }

  const firstWithEvent = classes.find((c) => c.event_date || c.venue);
  const fmtOpts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };
  const eventDateStr = firstWithEvent?.event_date ? new Date(firstWithEvent.event_date + "T00:00:00").toLocaleDateString("en-GB", fmtOpts) : null;
  const closeDateStr = classes.find((c) => c.enrollment_close_at)?.enrollment_close_at
    ? new Date(classes.find((c) => c.enrollment_close_at)!.enrollment_close_at!).toLocaleDateString("en-GB", fmtOpts) : null;
  const venue = firstWithEvent?.venue ?? null;
  const nameParts = intake.name.split(" ");
  const titleMain = nameParts.slice(0, -1).join(" ") || intake.name;
  const titleSub = nameParts.length > 1 ? nameParts[nameParts.length - 1] : "";

  return (
    <div className="min-h-screen" style={{ background: "#080808", color: "#F8F4EE" }}>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet" />

      {/* Grain overlay */}
      <div className="fixed inset-0 pointer-events-none z-[9999] opacity-[0.35]"
        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E")` }} />

      {/* ── HERO ─────────────────────────────────────────────────── */}
      {heroUrl ? (
        <>
          <section className="relative overflow-hidden">
            <a href={`/enroll/${slug}/status`} target="_blank" rel="noopener noreferrer"
              className="absolute top-6 right-6 sm:top-8 sm:right-12 z-10 flex items-center gap-2 text-[13px] font-medium tracking-[1.5px] uppercase px-4 py-2.5 rounded-sm border transition-all duration-300 hover:bg-white/10"
              style={{ color: "#fff", borderColor: "rgba(255,255,255,0.3)", backdropFilter: "blur(8px)", background: "rgba(0,0,0,0.3)" }}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Track Status
            </a>
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" className="absolute top-6 left-6 h-10 w-auto object-contain z-10 opacity-80" />
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={heroUrl} alt={intake.name} className="w-full object-cover" style={{ maxHeight: "55vh" }} />
          </section>
          {(eventDateStr || closeDateStr || venue) && (
            <section className="px-6 py-8 sm:px-12" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-12">
                {eventDateStr && <div className="text-center"><div className="text-[10px] tracking-[3px] uppercase mb-1.5" style={{ color: gold }}>Date</div><div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "20px", fontWeight: 600 }}>{eventDateStr}</div></div>}
                {eventDateStr && closeDateStr && <div className="w-1 h-1 rounded-full" style={{ background: gold, opacity: 0.4 }} />}
                {closeDateStr && <div className="text-center"><div className="text-[10px] tracking-[3px] uppercase mb-1.5" style={{ color: gold }}>Registration Closes</div><div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "20px", fontWeight: 600 }}>{closeDateStr}</div></div>}
                {(eventDateStr || closeDateStr) && venue && <div className="w-1 h-1 rounded-full" style={{ background: gold, opacity: 0.4 }} />}
                {venue && <div className="text-center"><div className="text-[10px] tracking-[3px] uppercase mb-1.5" style={{ color: gold }}>Venue</div><div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "20px", fontWeight: 600 }}>{venue}</div></div>}
              </div>
            </section>
          )}
        </>
      ) : (
        <section className="relative min-h-[85vh] flex flex-col items-center justify-center overflow-hidden px-6 py-24 sm:px-12">
          <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse 80% 50% at 50% 0%, ${gold}1f 0%, transparent 60%)` }} />
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute left-[15%] top-0 w-px h-full" style={{ background: `linear-gradient(to bottom, transparent, ${gold}26, transparent)` }} />
            <div className="absolute right-[15%] top-0 w-px h-full" style={{ background: `linear-gradient(to bottom, transparent, ${gold}26, transparent)`, animationDelay: "2s" }} />
          </div>

          <a href={`/enroll/${slug}/status`} target="_blank" rel="noopener noreferrer"
            className="absolute top-6 right-6 sm:top-8 sm:right-12 z-10 flex items-center gap-2 text-[13px] font-medium tracking-[1.5px] uppercase px-4 py-2.5 rounded-sm border transition-all duration-300"
            style={{ color: gold, borderColor: `${gold}4d` }}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            Track Status
          </a>

          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="relative mb-8 h-14 w-auto object-contain opacity-80" />
          )}

          {venue && (
            <div className="relative flex items-center gap-4 mb-6" style={{ fontSize: "11px", letterSpacing: "5px", textTransform: "uppercase", color: gold }}>
              <span className="w-10 h-px opacity-50" style={{ background: gold }} />{venue}<span className="w-10 h-px opacity-50" style={{ background: gold }} />
            </div>
          )}

          <h1 className="relative text-center animate-[fadeUp_0.8s_ease_0.15s_forwards] opacity-0"
            style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: "clamp(64px, 12vw, 150px)", lineHeight: 0.9, letterSpacing: "4px" }}>
            {titleMain}<br />
            <span style={{ WebkitTextStroke: "1px #F8F4EE", color: "transparent" }}>{intake.year}</span>
            {titleSub && (
              <span className="block mt-2" style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "clamp(22px, 4vw, 44px)", fontWeight: 300, fontStyle: "italic", letterSpacing: "8px", color: goldLight }}>
                {titleSub}
              </span>
            )}
          </h1>

          {tagline && (
            <p className="relative mt-6 text-center max-w-md" style={{ color: "rgba(248,244,238,0.5)", fontFamily: "'DM Sans', sans-serif", fontWeight: 300, letterSpacing: "1px" }}>
              {tagline}
            </p>
          )}

          {(eventDateStr || closeDateStr || venue) && (
            <div className="relative mt-10 flex flex-wrap items-center justify-center gap-6 sm:gap-8 animate-[fadeUp_0.8s_ease_0.3s_forwards] opacity-0">
              {eventDateStr && <div className="text-center"><div className="text-[10px] tracking-[3px] uppercase mb-1" style={{ color: "#888880" }}>Date</div><div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "18px", fontWeight: 600 }}>{eventDateStr}</div></div>}
              {eventDateStr && closeDateStr && <div className="w-1 h-1 rounded-full opacity-50" style={{ background: gold }} />}
              {closeDateStr && <div className="text-center"><div className="text-[10px] tracking-[3px] uppercase mb-1" style={{ color: "#888880" }}>Closes</div><div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "18px", fontWeight: 600 }}>{closeDateStr}</div></div>}
              {(eventDateStr || closeDateStr) && venue && <div className="w-1 h-1 rounded-full opacity-50" style={{ background: gold }} />}
              {venue && <div className="text-center"><div className="text-[10px] tracking-[3px] uppercase mb-1" style={{ color: "#888880" }}>Venue</div><div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "18px", fontWeight: 600 }}>{venue}</div></div>}
            </div>
          )}

          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 animate-[fadeUp_1s_ease_0.6s_forwards] opacity-0">
            <span className="text-[10px] tracking-[3px] uppercase" style={{ color: "#888880" }}>Tickets</span>
            <div className="w-px h-10 animate-pulse" style={{ background: `linear-gradient(to bottom, ${gold}, transparent)` }} />
          </div>
        </section>
      )}

      {/* ── TICKETS ──────────────────────────────────────────────── */}
      <section id="tickets" className="px-6 py-16 sm:px-12 sm:py-20 scroll-mt-4">
        <div className="text-center mb-16">
          <div className="text-[10px] tracking-[5px] uppercase mb-3" style={{ color: gold }}>Select Your Experience</div>
          <h2 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: "38px", fontWeight: 300, fontStyle: "italic" }}>Choose Your Tier</h2>
        </div>

        {classes.length === 0 ? (
          <div className="py-16 text-center"><p className="text-lg" style={{ color: "#888880" }}>Nothing available yet.</p></div>
        ) : (
          <div className="relative max-w-[1200px] mx-auto">
            <div className="absolute inset-[-1px] pointer-events-none opacity-20"
              style={{ background: `linear-gradient(135deg, ${gold} 0%, transparent 40%, transparent 60%, ${gold} 100%)` }} />
            <div className={`grid gap-px ${classes.length === 1 ? "grid-cols-1 max-w-md mx-auto" : classes.length === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"}`}>
              {classes.map((cls, i) => (
                <TicketCard key={cls.id} cls={cls} onSelect={onSelect} isHighestTier={cls.fee_amount === maxFee && classes.length > 1}
                  index={i} cartMode={hasMultipleTickets} cartQty={cart.get(cls.id)?.qty ?? 0} onCartChange={handleAddToCart}
                  currency={currency} gold={gold} goldLight={goldLight} />
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── FOOTER ───────────────────────────────────────────────── */}
      <footer className="px-6 py-12 sm:px-12 border-t border-white/5">
        <div className="max-w-[1200px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: "22px", letterSpacing: "4px", opacity: 0.5 }}>{intake.name}</div>
          <div className="text-[12px] tracking-wider" style={{ color: "#888880" }}>
            Powered by <a href="https://www.kuunyi.com" target="_blank" rel="noopener noreferrer" style={{ color: gold }}>KuuNyi</a>
          </div>
        </div>
      </footer>

      {/* Sticky CTA */}
      {hasMultipleTickets && cartItemCount > 0 ? (
        <div className="fixed bottom-0 left-0 right-0 z-50" style={{ background: "linear-gradient(to top, rgba(8,8,8,0.98), rgba(8,8,8,0.9))", backdropFilter: "blur(12px)" }}>
          <div className="px-4 py-3 sm:px-8 flex items-center justify-between max-w-[1200px] mx-auto">
            <div>
              <div className="text-[11px] tracking-[2px] uppercase" style={{ color: gold }}>{cartItemCount} ticket{cartItemCount !== 1 ? "s" : ""} in cart</div>
              <div className="text-[15px] font-semibold" style={{ color: "#F8F4EE" }}>{formatCurrency(cartTotal, currency)}</div>
            </div>
            <button onClick={handleCartCheckout} className="px-6 py-2.5 rounded-sm text-[12px] font-semibold tracking-[1.5px] uppercase transition-all"
              style={{ background: `linear-gradient(135deg, ${gold}, ${goldLight})`, color: "#080808" }}>
              Checkout
            </button>
          </div>
        </div>
      ) : classes.some((c) => c.seat_remaining > 0 && c.status === "open") ? (
        <div className="fixed bottom-0 left-0 right-0 z-50 sm:hidden" style={{ background: "linear-gradient(to top, rgba(8,8,8,0.98), rgba(8,8,8,0.9))", backdropFilter: "blur(12px)" }}>
          <div className="px-4 py-3 flex items-center justify-between">
            <div>
              <div className="text-[11px] tracking-[2px] uppercase" style={{ color: gold }}>Tickets available</div>
              <div className="text-[13px] text-white/60">From {formatCurrency(Math.min(...classes.filter((c) => c.seat_remaining > 0).map((c) => c.fee_amount)), currency)}</div>
            </div>
            <a href="#tickets" className="px-5 py-2.5 rounded-sm text-[12px] font-semibold tracking-[1.5px] uppercase"
              style={{ background: `linear-gradient(135deg, ${gold}, ${goldLight})`, color: "#080808" }}>
              Buy Tickets
            </a>
          </div>
        </div>
      ) : null}

      <style>{`@keyframes fadeUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
