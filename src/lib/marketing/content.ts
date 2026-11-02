// ─── Marketing page content ──────────────────────────────────────────────────
// Browser-safe: imported by the page, the editor and the validator. Server-only
// data access lives in store.ts and published.ts.

export const MARKETING_SCHEMA_VERSION = 1;
export const MARKETING_BUCKET = "marketing-assets";
export const MARKETING_CACHE_TAG = "marketing-page";

export type Localized = { en: string; mm: string };

/** Never a free-form URL: a file under public/, or an object in our bucket. */
export type ImageRef = {
  kind: "static" | "bucket";
  path: string;
  width: number;
  height: number;
};

export const SECTION_KEYS = [
  "organizers",
  "payments",
  "solutions",
  "pos",
  "howItWorks",
  "industries",
  "cta",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export type OrganizerItem = { id: string; name: string; image: ImageRef; hidden: boolean };
export type PaymentItem = { id: string; name: string; images: ImageRef[]; hidden: boolean };
export type SolutionItem = {
  id: string;
  label: string;
  title: Localized;
  description: string;
  /** null renders the accepted-payment logos instead of a photo. */
  image: ImageRef | null;
  hidden: boolean;
};
export type StepItem = { id: string; title: Localized; hidden: boolean };
export type IndustryItem = { id: string; name: Localized; image: ImageRef; hidden: boolean };

export interface MarketingContent {
  schemaVersion: number;
  seo: { title: string; description: string };
  sections: Record<SectionKey, boolean>;
  hero: {
    image: ImageRef;
    signIn: string;
    getStarted: string;
    eyebrow: string;
    headline: Localized;
    subtext: string;
    primaryCta: string;
    secondaryCta: string;
    trust: Localized;
  };
  organizers: { heading: Localized; intro: string; items: OrganizerItem[] };
  payments: { heading: Localized; items: PaymentItem[] };
  solutions: { eyebrow: string; heading: Localized; intro: string; items: SolutionItem[] };
  pos: { image: ImageRef; eyebrow: string; title: Localized; description: string; bullets: string[] };
  howItWorks: { image: ImageRef; heading: Localized; intro: string; steps: StepItem[] };
  industries: { heading: Localized; intro: string; items: IndustryItem[] };
  cta: { image: ImageRef; heading: Localized; intro: string; primary: string; secondary: string };
  footer: {
    tagline: string;
    productHeading: string;
    howItWorksLink: string;
    organisersHeading: string;
    getStartedLink: string;
    signInLink: string;
    legalHeading: string;
    privacyLink: string;
    copyright: string;
  };
}

/** Public URLs are built here so stored content never carries a host. */
export function marketingImageSrc(image: ImageRef): string {
  if (image.kind === "static") return image.path;
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${MARKETING_BUCKET}/${image.path}`;
}
