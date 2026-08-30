"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TenantAppearance } from "@/types/database";
import type { TemplateClass, TemplateIntake, TemplateLabels } from "./types";
import { getCardState } from "./types";
import {
  PresentingSponsorBanner,
  SponsorLogoWall,
} from "@/components/enrollment/SponsorPlacements";
import { resolveSponsorPlacements } from "@/lib/sponsors";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EvTrustedOfficialTemplateProps {
  appearance: Omit<TenantAppearance, "id" | "tenant_id" | "updated_at">;
  intake: TemplateIntake;
  classes: TemplateClass[];
  labels: TemplateLabels;
  slug: string;
  currency: string;
}

// ─── TicketCard ───────────────────────────────────────────────────────────────

function TicketCard({
  cls,
  qty,
  onQtyChange,
  featured,
  brand,
  priority,
}: {
  cls: TemplateClass;
  qty: number;
  onQtyChange: (classId: string, delta: number) => void;
  featured: boolean;
  brand: string;
  /** First card in the list — its artwork is above the fold, so it must not
   *  be lazy-loaded. */
  priority: boolean;
}) {
  const { isDisabled, overlayState } = getCardState(cls);
  const max = cls.max_tickets_per_person ?? 10;

  // Hides the "X seats remaining" line. Flip to true to show it again.
  const SHOW_SEAT_COUNT = false;

  const overlayLabel =
    overlayState === "full"
      ? "Sold Out"
      : overlayState === "not_open"
        ? "Coming Soon"
        : overlayState === "closed"
          ? "Sales Closed"
          : null;

  const subtotal = qty * cls.fee_amount;

  return (
    <div
      className="rounded-[10px] text-sm overflow-hidden"
      style={{
        background: featured ? "#fbf8ee" : "#ffffff",
        border: featured ? "1.5px solid #d4af5a" : "1px solid #e3e0d6",
        boxShadow: "0 1px 2px rgba(15,31,66,.05)",
      }}
    >
      {/* Ticket image — whole artwork, bounded height.
          It was a 74x100 portrait box with objectFit:cover, which centre-cropped
          the artwork: event posters are landscape (~1.91:1), so roughly a
          quarter of the width survived and the title, date, venue and price were
          all cropped away.

          Three properties together, each load-bearing:

          `w-full h-auto` lets a normal landscape poster compute its own height,
          so it is shown whole without hard-coding a ratio — each ticket type
          uploads its own image and they need not share one.

          `max-h` bounds it. Upload validation only checks file size (5 MB) and
          MIME type, never dimensions, so a portrait or panoramic image is
          accepted. Unbounded, a 1000x4000 upload would render a card several
          screens tall and push the quantity controls out of reach — with one
          such card per ticket type, the page stops being usable.

          `object-contain` is what keeps the image WHOLE once max-h clamps it.
          Height-clamping alone would squash it, and `cover` would crop it right
          back. Contain letterboxes instead: the bars are the card's own
          background, so they read as intentional padding.

          `block` kills the inline-element baseline gap under the image;
          `overflow-hidden` on the card clips the top corners to its radius. */}
      {cls.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={cls.image_url}
          alt={`${cls.level} ticket`}
          className="block w-full h-auto max-h-[420px] object-contain"
          // The first card's artwork is above the fold. Lazy-loading it delays
          // the main image and shifts the controls when it lands.
          loading={priority ? "eager" : "lazy"}
          decoding="async"
        />
      )}

      {/* Card body */}
      <div className="p-[13px]" style={{ minWidth: 0 }}>
        {/* Header row */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="font-bold text-[13px]" style={{ color: brand }}>
              {cls.level}
            </span>
            {featured && (
              <span
                className="text-[8.5px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded text-white"
                style={{ background: "#b7912b", borderRadius: 4 }}
              >
                POPULAR
              </span>
            )}
          </div>
          <span className="text-[12.5px] font-bold" style={{ color: brand }}>
            {cls.fee_formatted}
          </span>
        </div>

        {/* Seats remaining */}
        {SHOW_SEAT_COUNT && (
          <p className="text-[10.5px] mb-3" style={{ color: "#8b8f9a" }}>
            {cls.seat_remaining} seats remaining
          </p>
        )}

        {/* Controls */}
        {overlayLabel ? (
          <div
            className="text-center text-[11px] py-2 rounded"
            style={{ background: "#f5f5f5", color: "#9a9484" }}
          >
            {overlayLabel}
          </div>
        ) : isDisabled ? null : (
          <div className="flex items-center justify-between">
            {/* Stepper */}
            <div
              className="flex items-center overflow-hidden rounded-full"
              style={{ border: "1px solid #d8d5c9" }}
            >
              <button
                className="w-[26px] h-[26px] flex items-center justify-center text-sm font-bold hover:bg-gray-50"
                style={{ color: brand }}
                onClick={() => onQtyChange(cls.id, -1)}
                disabled={qty === 0}
              >
                −
              </button>
              <span
                className="w-[26px] text-center text-[12px] font-bold"
                style={{
                  color: brand,
                  borderLeft: "1px solid #d8d5c9",
                  borderRight: "1px solid #d8d5c9",
                }}
              >
                {qty}
              </span>
              <button
                className="w-[26px] h-[26px] flex items-center justify-center text-sm font-bold hover:bg-gray-50"
                style={{ color: brand }}
                onClick={() => onQtyChange(cls.id, 1)}
                disabled={qty >= max}
              >
                +
              </button>
            </div>
            {/* Subtotal */}
            {qty > 0 && (
              <span className="text-[11.5px] font-semibold" style={{ color: brand }}>
                {cls.fee_formatted.replace(/[\d,]+/, String(subtotal.toLocaleString()))}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── EvTrustedOfficialTemplate ────────────────────────────────────────────────

export default function EvTrustedOfficialTemplate({
  appearance,
  intake,
  classes,
  slug,
}: EvTrustedOfficialTemplateProps) {
  const router = useRouter();
  const logoUrl = appearance.logo_url;
  const brand = appearance.primary_color || "#0f1f42";
  const tagline = appearance.tagline ?? null;
  const sponsors = resolveSponsorPlacements(appearance.sponsor_config);
  // Event ticketing template: the CTA always reads "Buy Ticket" (ignores the
  // generic tenant cta_button_text, which defaults to "Enroll Now").
  const ctaText = "Buy Ticket";
  const [cart, setCart] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cartCount = Object.values(cart).reduce((s, q) => s + q, 0);
  const cartTotal = classes.reduce((s, cls) => s + (cart[cls.id] ?? 0) * cls.fee_amount, 0);

  function handleQtyChange(classId: string, delta: number) {
    const cls = classes.find((c) => c.id === classId);
    if (!cls) return;
    const max = cls.max_tickets_per_person ?? 10;
    setCart((prev) => {
      const next = Math.max(0, Math.min(max, (prev[classId] ?? 0) + delta));
      if (next === 0) {
        const copy = { ...prev };
        delete copy[classId];
        return copy;
      }
      return { ...prev, [classId]: next };
    });
  }

  async function handleCheckout() {
    if (cartCount === 0 || loading) return;
    setLoading(true);
    setError(null);

    const items = classes
      .filter((cls) => (cart[cls.id] ?? 0) > 0)
      .map((cls) => ({ class_id: cls.id, quantity: cart[cls.id] }));

    // Priority-access token captured earlier from the URL fragment (see
    // `[slug]/page.tsx`) and stashed in sessionStorage, keyed per slug. Sent
    // only in this POST body — never as a query param or link href.
    const priorityToken = sessionStorage.getItem(`pa_${slug}`);

    try {
      const res = await fetch("/api/public/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          ...(priorityToken ? { priority_token: priorityToken } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "Enrollment failed.");
      router.push(`/enroll/${slug}/checkout/?ref=${data.enrollment_ref}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen"
      style={{ background: "#f7f5ef", fontFamily: "var(--font-inter), sans-serif" }}
    >
      <div className="max-w-[480px] mx-auto pb-32">
        {/* ── Brand row ────────────────────────────────────── */}
        <div className="px-[22px] pt-5 pb-[14px] flex items-center gap-2.5">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="w-[30px] h-[30px] rounded-[6px] object-cover" />
          ) : (
            <div
              className="w-[30px] h-[30px] rounded-[6px] flex items-center justify-center text-[11px] font-black"
              style={{ background: brand, color: "#d4af5a" }}
            >
              {intake.name.charAt(0)}
            </div>
          )}
          <span className="text-[12.5px] font-semibold" style={{ color: brand }}>
            {intake.name}
          </span>
        </div>

        <PresentingSponsorBanner sponsor={sponsors.presenting} />

        {/* ── Title block ──────────────────────────────────── */}
        <div
          className="mx-[22px] px-4 py-[14px] mb-[18px] text-center"
          style={{ borderTop: "1.5px solid #d4af5a", borderBottom: "1.5px solid #d4af5a" }}
        >
          <p
            className="text-[10px] font-bold uppercase tracking-[2.5px] mb-1"
            style={{ color: "#b7912b" }}
          >
            {intake.year}
          </p>
          <h1 className="text-[19px] font-extrabold leading-tight" style={{ color: brand }}>
            Select Your Ticket
          </h1>
          {tagline && (
            <p className="text-[11px] mt-1" style={{ color: "#8b8f9a" }}>
              {tagline}
            </p>
          )}
        </div>

        {/* ── Ticket cards ─────────────────────────────────── */}
        <div className="px-[22px] flex flex-col gap-3">
          {classes.length === 0 ? (
            <p className="text-center py-12 text-sm" style={{ color: "#8b8f9a" }}>
              No tickets available at this time.
            </p>
          ) : (
            classes.map((cls, i) => (
              <TicketCard
                key={cls.id}
                cls={cls}
                qty={cart[cls.id] ?? 0}
                onQtyChange={handleQtyChange}
                featured={i === 0 && classes.length > 1}
                brand={brand}
                priority={i === 0}
              />
            ))
          )}
        </div>

        <SponsorLogoWall sponsors={sponsors.partners} />

        {/* ── Error ────────────────────────────────────────── */}
        {error && (
          <div
            className="mx-[22px] mt-4 p-3 rounded-lg border text-[12px]"
            style={{ background: "#fff5f5", borderColor: "#fca5a5", color: "#991b1b" }}
          >
            {error}
          </div>
        )}
      </div>

      {/* ── Sticky cart bar ──────────────────────────────── */}
      {cartCount > 0 && (
        <div
          className="fixed bottom-0 left-0 right-0 z-50"
          style={{
            background: "#ffffff",
            borderTop: "1px solid #e3e0d6",
            padding: "12px 22px 18px",
          }}
        >
          <div className="max-w-[480px] mx-auto">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11.5px] font-bold" style={{ color: brand }}>
                {cartCount} ticket{cartCount > 1 ? "s" : ""} selected
              </span>
              <span className="text-[12px] font-extrabold" style={{ color: brand }}>
                {cartTotal.toLocaleString()}
              </span>
            </div>
            <button
              className="w-full py-2.5 rounded-[7px] text-[12px] font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              style={{ background: brand }}
              onClick={handleCheckout}
              disabled={loading}
            >
              {loading ? "Processing..." : ctaText}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
