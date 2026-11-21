"use client";

// ─── Sky Festival walk-in notice pop-up ─────────────────────────────────────
//
// Online sales have closed; tells visitors walk-in tickets are sold at the
// gate, with the doors time, a map link and the venue poster. See
// src/lib/tenantNotice.ts for where it shows.
//
// Opens on every visit: every load, refresh or new tab. Nothing is stored
// after Close; it stays closed only while the visitor moves between pages in
// the same visit (in-app navigation), so it doesn't reopen on each click.
// Closes on Escape, the backdrop, or either Close button.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { walkInNoticeApplies } from "@/lib/tenantNotice";

const MAP_URL = "https://maps.app.goo.gl/PMzq7WBwPKRvTRip6";
const POSTER_URL = "/tenants/skyfestival/venue-map.webp";

export default function WalkInNotice({ tenantSlug }: { tenantSlug: string | null }) {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const closedThisVisit = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Decided after mount: the clock is the browser's. Re-checked on each page so
  // it also closes when the visitor moves to an order or ticket page.
  useEffect(() => {
    const applies = walkInNoticeApplies(tenantSlug, pathname, Date.now());
    setOpen(applies && !closedThisVisit.current);
  }, [tenantSlug, pathname]);

  const close = useCallback(() => {
    closedThisVisit.current = true;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, close]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="walk-in-notice-title"
    >
      <div className="absolute inset-0 bg-black/50" onClick={close} aria-hidden="true" />

      <div className="relative flex max-h-[90vh] w-full max-w-md flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl">
        <div className="flex items-start gap-3 border-b border-gray-200 px-5 py-4">
          <h2 id="walk-in-notice-title" className="font-myanmar text-lg font-semibold leading-relaxed text-gray-900">
            အွန်လိုင်း လက်မှတ်ရောင်းချမှု ပိတ်သိမ်းပြီးပါပြီ
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label="Close"
            className="ml-auto shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          <p className="font-myanmar text-base leading-loose text-gray-800">
            Walk-In လက်မှတ်များကို တစ်စောင်လျှင် <strong>55,000 ကျပ်</strong>နှုန်းဖြင့် ဝင်ပေါက် ကောင်တာတွင် ဝယ်ယူ
            ရရှိနိုင်မှာပဲ ဖြစ်ပါတယ် 😉
          </p>
          <p className="mt-3 text-base font-semibold text-gray-900">Doors Open – 6:00 PM</p>

          <a
            href={MAP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-[#1a6b3c] px-4 py-3 text-sm font-semibold text-white"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
            </svg>
            <span className="font-myanmar">ပွဲနေရာကြည့်ရှုရန်</span>
          </a>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={POSTER_URL}
            alt="Sky Festival နှင့် Sky Deck နေရာ မြေပုံ"
            width={1440}
            height={1800}
            className="mt-4 h-auto w-full rounded-lg"
          />
        </div>

        <div className="border-t border-gray-200 px-5 py-3">
          <button
            type="button"
            onClick={close}
            className="w-full rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white"
          >
            Close / <span className="font-myanmar">ပိတ်မည်</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
