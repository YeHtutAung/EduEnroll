import type { Metadata } from "next";
import LegalDocument from "@/components/legal/LegalDocument";
import { PRIVACY_POLICY } from "@/components/legal/content";

export const metadata: Metadata = {
  title: "Privacy Policy - KuuNyi",
  description:
    "Learn how KuuNyi collects, uses, and protects your information when using our enrollment management platform.",
};

// The words live in src/components/legal/content.ts. Kept on the site (Meta's
// Messenger platform needs a privacy URL) but not linked from the order forms.

export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto max-w-[740px] py-10 sm:py-16">
      <p className="mb-4 text-[11px] font-mono uppercase tracking-[0.2em] text-gray-500">
        Legal Document
      </p>
      <h1 className="text-3xl sm:text-[40px] font-semibold leading-tight tracking-tight text-gray-900 mb-1">
        {PRIVACY_POLICY.title.en}
      </h1>
      <p className="font-myanmar text-xl text-gray-700 mb-3">{PRIVACY_POLICY.title.mm}</p>
      <p className="text-xs font-mono text-gray-500 mb-1">{PRIVACY_POLICY.subtitle.en}</p>
      <p className="font-myanmar text-xs text-gray-500 mb-12 pb-8 border-b border-gray-200">
        {PRIVACY_POLICY.subtitle.mm}
      </p>
      <LegalDocument doc={PRIVACY_POLICY} />
    </div>
  );
}
