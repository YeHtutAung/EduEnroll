"use client";

// ─── A legal document in a pop-up over the order form ───────────────────────
//
// Lets a buyer read the Terms of Sale or Privacy Policy without leaving the
// form they are part-way through. Rendered into <body> through a portal so it
// sits above the fixed cart bar on the ticket-picker page, whatever that bar's
// stacking context. Closes on Escape, the backdrop, or either Close button.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import LegalDocument from "./LegalDocument";
import type { LegalDocumentData } from "./content";

export default function LegalDocumentModal({
  doc,
  fullPageHref,
  onClose,
}: {
  doc: LegalDocumentData;
  /** The same document as a page, for anyone who wants it in its own tab. */
  fullPageHref: string;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMounted(true);

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);

    // The page behind must not scroll while the document is being read.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  // Focus the close control once the dialog exists, so keyboard and screen
  // reader users land inside it.
  useEffect(() => {
    if (mounted) closeRef.current?.focus();
  }, [mounted]);

  // No portal target during server rendering; the pop-up only ever opens
  // after a click, so there is nothing to render before mount.
  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-document-title"
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />

      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-t-2xl bg-[#faf9f7] shadow-xl sm:rounded-2xl">
        <div className="flex items-start gap-3 border-b border-gray-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id="legal-document-title" className="text-lg font-semibold text-gray-900">
              {doc.title.en}
            </h2>
            <p className="font-myanmar text-sm text-gray-600">{doc.title.mm}</p>
            <p className="mt-1 text-[11px] font-mono text-gray-400">{doc.subtitle.en}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-5">
          <LegalDocument doc={doc} compact />
        </div>

        <div className="flex items-center gap-3 border-t border-gray-200 px-5 py-3">
          <a
            href={fullPageHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-gray-500 underline underline-offset-2"
          >
            Open as a page
          </a>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg bg-gray-900 px-5 py-2 text-sm font-semibold text-white"
          >
            Close / <span className="font-myanmar">ပိတ်မည်</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
