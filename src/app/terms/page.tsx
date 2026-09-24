import type { Metadata } from "next";
import LegalDocument from "@/components/legal/LegalDocument";
import { TERMS_OF_SALE } from "@/components/legal/content";

export const metadata: Metadata = {
  title: "Terms of Sale - KuuNyi",
  description:
    "The terms that apply when you buy a ticket or place an order through KuuNyi.",
};

// The words live in src/components/legal/content.ts, shared with the pop-up on
// the order forms. Changing them must bump TERMS_VERSION.

export default function TermsOfSalePage() {
  return (
    <div className="mx-auto max-w-[740px] py-10 sm:py-16">
      <LegalPageHeader />
      <LegalDocument doc={TERMS_OF_SALE} />
    </div>
  );
}

function LegalPageHeader() {
  return (
    <>
      <p className="mb-4 text-[11px] font-mono uppercase tracking-[0.2em] text-gray-500">
        Legal Document
      </p>
      <h1 className="text-3xl sm:text-[40px] font-semibold leading-tight tracking-tight text-gray-900 mb-1">
        {TERMS_OF_SALE.title.en}
      </h1>
      <p className="font-myanmar text-xl text-gray-700 mb-3">{TERMS_OF_SALE.title.mm}</p>
      <p className="text-xs font-mono text-gray-500 mb-12 pb-8 border-b border-gray-200">
        {TERMS_OF_SALE.subtitle.en}
      </p>
    </>
  );
}
