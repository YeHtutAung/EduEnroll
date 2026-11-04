# Marketing Page Content Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A superadmin Marketing section where the owner edits the homepage's text, partner logos, images, accepted payments, section visibility and SEO, previews a draft, and publishes it.

**Architecture:** One versioned JSON record per state (`draft`, `published`, `archived`) in `marketing_page_versions`, written only through superadmin API routes with the service role. `MarketingPage` renders a `MarketingContent` object, so the public page and the preview share markup. The public page reads the published row through `unstable_cache` and falls back to `defaultContent` on any failure.

**Tech Stack:** Next.js 14.2 App Router, TypeScript, Tailwind, Supabase (Postgres, Storage), Vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-02-marketing-page-cms-design.md`

---

## Decisions this plan adds to the spec

Each was found while reading the code for this plan. Codex and the owner should check them.

1. **The image-host check runs only for `next build`.** `.github/workflows/ci.yml` runs `npm run lint` with no env, and `next lint` loads `next.config.mjs`. It also loads the config in the production-build phase, so `phase` can't tell the two apart. The config checks `process.argv.includes("build")`.
2. **The harness defeats a direct table ACL assertion.** `src/__tests__/db/setup.ts` grants full DML on all public tables to `anon` and `authenticated` *after* migrations, so `relacl` would always show those grants. The DB test instead replays the whole migration in a rolled-back transaction, under default privileges that mirror hosted Supabase, then checks `has_table_privilege`. Function ACLs aren't touched by the harness, so `proacl` is also asserted directly on the applied database. Real privileges are checked on the dev database in Task 13.
3. **Hiding "How it works" also hides the links to it.** The hero button and the footer "Product" column point at `#how`.
4. **Step numbers come from visible position**, so hiding a step can't show `01, 02, 04`.
5. **The cache key includes the Supabase URL and schema version**, so environments sharing a Vercel data cache can't read each other's content.
6. **A missing published row logs `console.warn`, not an error.** It's the normal state until the first publish and would otherwise log an error on every homepage view. Query and validation failures use `console.error`.
7. **The preview page also calls `requireSuperadmin`**, as well as sitting behind the layout, because it reads the draft with the service role.
8. **Save and Publish are separate.** Preview and Publish are disabled while there are unsaved changes, so what's previewed and published is always a saved revision.
9. **Payment image alt text.** A payment is `{ name, images[] }`. The first image's alt is `name` and later images use `alt=""`, so "Visa & Mastercard" is announced once. This is the only intended markup difference from today's page.
10. **The solutions payment card keeps its logo chips.** A solution item's `image` can be `null`, which renders the first four visible payments.
11. **The hero eyebrow and subtext are single strings.** The spec's content model calls hero text "localised", and also says `{ en, mm }` applies "wherever the page shows both". Today's page shows these two in English only, and adding Myanmar lines would change the approved design.
12. **Direct `UPDATE` on the draft stays**, as the spec says. `service_role` keeps `SELECT, INSERT, UPDATE`. Moving saves into a function would need `SECURITY DEFINER` to drop those grants, which adds more risk than it removes for a key that's already fully trusted server-side. `writeDraft` is the only write path, and it always filters on status and revision.
13. **Uploads check headers, not the whole file.** A corrupt file with a valid header would show as a broken image, which the uploader sees in the tab and in preview. It can't change the served type or run script, and only superadmins can upload, so a full decoder isn't worth adding.

Commands are written for Git Bash, which the Bash tool uses on this Windows machine.

## File structure

**Create**

| File | Responsibility |
|---|---|
| `src/lib/marketing/content.ts` | Types, constants, `marketingImageSrc`. Safe to import in the browser. |
| `src/lib/marketing/defaultContent.ts` | Today's page as data |
| `src/lib/marketing/validate.ts` | `validateMarketingContent` |
| `src/lib/marketing/imageBytes.ts` | Type and dimension detection from file bytes |
| `src/lib/marketing/imageHost.mjs` | Builds `remotePatterns`; imported by `next.config.mjs` |
| `src/lib/marketing/store.ts` | Server-only data access for drafts and versions |
| `src/lib/marketing/published.ts` | Cached public loader with fallback |
| `src/lib/marketing/editorOps.ts` | Pure editor helpers (path get/set, move) |
| `src/lib/marketing/textFields.ts` | Which text fields the Texts tab shows |
| `src/components/marketing/MarketingPage.tsx` | The page markup |
| `src/components/marketing/editor/MarketingEditor.tsx` | Editor state, header actions, tabs |
| `src/components/marketing/editor/fields.tsx` | `ImageField`, `TextInput`, `RowActions` |
| `src/components/marketing/editor/tabs.tsx` | The five tab bodies |
| `src/app/superadmin/marketing/page.tsx` | Editor route |
| `src/app/superadmin/marketing/preview/page.tsx` | Draft preview |
| `src/app/api/superadmin/marketing/route.ts` | `GET /` |
| `src/app/api/superadmin/marketing/draft/route.ts` | `PUT /draft` |
| `src/app/api/superadmin/marketing/publish/route.ts` | `POST /publish` |
| `src/app/api/superadmin/marketing/restore/route.ts` | `POST /restore` |
| `src/app/api/superadmin/marketing/upload/route.ts` | `POST /upload` |
| `supabase/migrations/20261102120000_marketing_page_versions.sql` | Table, functions, bucket |
| Tests | Listed per task |

**Modify**

- `src/app/page.tsx`: becomes a thin server component
- `next.config.mjs`: adds `images.remotePatterns`
- `src/types/database.ts`: adds the table and functions
- `src/app/superadmin/page.tsx`: adds a link to Marketing

---

## Task 0: Preflight

- [ ] **Step 1: Confirm identity, branch and base**

```bash
git config user.email
git status --short --branch
git fetch origin
git log --oneline -1 origin/dev
git merge-base --is-ancestor origin/dev HEAD && echo up-to-date
```

Expected: `yehtutaung.yha@gmail.com`; branch `feature/marketing-page-cms`; `up-to-date`. If the email differs, stop and say so. If `origin/dev` has moved, rebase onto it before starting.

- [ ] **Step 2: Baseline**

```bash
npx vitest run src/__tests__/migrations/storage-buckets.test.ts src/__tests__/api/superadmin/tenantGtm.test.ts
```

Expected: exit 0.

---

## Task 1: Content types

**Files:**
- Create: `src/lib/marketing/content.ts`
- Test: `src/__tests__/marketing/content.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { marketingImageSrc } from "@/lib/marketing/content";

describe("marketingImageSrc", () => {
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
  });

  it("returns a static path unchanged", () => {
    expect(marketingImageSrc({ kind: "static", path: "/marketing/hero.jpg", width: 1, height: 1 })).toBe(
      "/marketing/hero.jpg",
    );
  });

  it("builds a bucket URL from the current environment's host", () => {
    expect(marketingImageSrc({ kind: "bucket", path: "x.png", width: 1, height: 1 })).toBe(
      "https://abc.supabase.co/storage/v1/object/public/marketing-assets/x.png",
    );
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/__tests__/marketing/content.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
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
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/__tests__/marketing/content.test.ts`
Expected: PASS. (Commit together with Task 2.)

---

## Task 2: Default content

**Files:**
- Create: `src/lib/marketing/defaultContent.ts`

Text is copied exactly from `src/app/page.tsx`; Task 6's markup comparison proves it. Photo sizes were measured from `public/marketing` on 2026-11-02.

- [ ] **Step 1: Write the file**

```ts
import type { ImageRef, MarketingContent } from "./content";
import { MARKETING_SCHEMA_VERSION } from "./content";

// Photos in /public/marketing are from Unsplash (Unsplash License). Sources are
// listed in docs/superpowers/specs/2026-11-01-festival-marketing-homepage-design.md.
// Organizer logos supplied by the owner, with each organizer's permission (2026-11-01).

const img = (path: string, width: number, height: number): ImageRef => ({
  kind: "static",
  path,
  width,
  height,
});

export const defaultContent: MarketingContent = {
  schemaVersion: MARKETING_SCHEMA_VERSION,
  seo: {
    title: "KuuNyi — Festival & Event Ticketing for Myanmar",
    description:
      "Sell tickets, take KBZPay, MMQR and card payments, and scan QR e-tickets at the gate. " +
      "Built for Myanmar festivals and events.",
  },
  sections: {
    organizers: true,
    payments: true,
    solutions: true,
    pos: true,
    howItWorks: true,
    industries: true,
    cta: true,
  },
  hero: {
    image: img("/marketing/hero.jpg", 2000, 1125),
    signIn: "Sign In",
    getStarted: "Get Started",
    eyebrow: "Festival & event ticketing",
    headline: {
      en: "Sell out your festival.",
      mm: "ပွဲတော်လက်မှတ်ရောင်းချမှု၊ ငွေပေးချေမှုနှင့် ဝင်ပေါက်စစ်ဆေးမှု — တစ်နေရာတည်းတွင်",
    },
    subtext: "Tickets, payments and gate scanning — one platform for Myanmar music festivals.",
    primaryCta: "Start selling tickets",
    secondaryCta: "See how it works",
    trust: {
      en: "Free to set up — a small fee only when you sell online.",
      mm: "စတင်ရန် အခမဲ့ — အွန်လိုင်းရောင်းချမှုအတွက်သာ အနည်းငယ် ကောက်ခံပါသည်",
    },
  },
  organizers: {
    heading: { en: "Trusted by top event organizers", mm: "ထိပ်တန်း ပွဲစီစဉ်သူများ၏ ယုံကြည်မှု" },
    intro: "Myanmar's festival and concert organizers run their events with KuuNyi.",
    items: [
      { id: "h-life", name: "H-Life Entertainment", image: img("/marketing/organizers/h-life.png", 611, 611), hidden: false },
      { id: "brave", name: "Brave Entertainment", image: img("/marketing/organizers/brave.png", 960, 960), hidden: false },
      { id: "louder", name: "Louder Myanmar", image: img("/marketing/organizers/louder.webp", 1500, 1500), hidden: false },
      { id: "tmf", name: "Thingyan Music Festival", image: img("/marketing/organizers/tmf.png", 1080, 1080), hidden: false },
      { id: "sky-festival", name: "Sky Festival", image: img("/marketing/organizers/sky-festival.png", 1080, 1080), hidden: false },
      { id: "rock-in-mandalay", name: "Rock In Mandalay", image: img("/marketing/organizers/rock-in-mandalay.webp", 1080, 1080), hidden: false },
    ],
  },
  payments: {
    heading: { en: "Accepted payments", mm: "လက်ခံသော ငွေပေးချေမှုများ" },
    items: [
      { id: "kbzpay", name: "KBZPay", images: [img("/kbzpay-logo.png", 800, 800)], hidden: false },
      { id: "cb-bank", name: "CB Bank", images: [img("/cbmmqr/cb-bank-logo.png", 371, 160)], hidden: false },
      { id: "mmqr", name: "MMQR", images: [img("/mmqr-logo.png", 1920, 2943)], hidden: false },
      {
        id: "cards",
        name: "Visa & Mastercard",
        images: [img("/visa.svg", 60, 20), img("/mastercard.svg", 48, 32)],
        hidden: false,
      },
    ],
  },
  solutions: {
    eyebrow: "Solutions",
    heading: { en: "Everything your festival needs", mm: "ပွဲတော်တစ်ခုအတွက် လိုအပ်သမျှ" },
    intro: "Everything you need to sell tickets and run the gate — without spreadsheets or payment screenshots.",
    items: [
      {
        id: "ticketing",
        label: "Ticketing",
        title: { en: "QR e-tickets & gate scanning", mm: "QR အီး-လက်မှတ်နှင့် ဝင်ပေါက်စစ်ဆေးမှု" },
        description:
          "Every ticket carries a unique QR, shown on the payment page and sent by email. Staff scan it at the gate, and each QR works once.",
        image: img("/marketing/scan.jpg", 1000, 1500),
        hidden: false,
      },
      {
        id: "payments",
        label: "Payments",
        title: { en: "Local + card payments", mm: "ပြည်တွင်းနှင့် ကတ်ငွေပေးချေမှု" },
        description:
          "KBZPay and CB MMQR for fans in Myanmar, Visa and Mastercard for fans overseas. Payment is confirmed automatically.",
        image: null,
        hidden: false,
      },
      {
        id: "sales-control",
        label: "Sales control",
        title: { en: "Ticket tiers & sell-out control", mm: "လက်မှတ်အဆင့်များနှင့် အရေအတွက်ထိန်းချုပ်မှု" },
        description: "Early Bird, GA and VIP with a limit per tier, plus a priority window for your fans before public sale.",
        image: img("/marketing/tiers.jpg", 1000, 667),
        hidden: false,
      },
      {
        id: "branding",
        label: "Branding",
        title: { en: "Your event, your brand", mm: "သင့်ကိုယ်ပိုင် အမှတ်တံဆိပ်" },
        description: "Your own domain, sponsor logos on e-tickets, and your Meta, TikTok and Google pixels via Google Tag Manager.",
        image: img("/marketing/brand.jpg", 1000, 667),
        hidden: false,
      },
    ],
  },
  pos: {
    image: img("/marketing/pos.jpg", 1000, 900),
    eyebrow: "On-site payments",
    title: { en: "Cashless bars & food stalls", mm: "ငွေသားမလိုသော ဘားနှင့် စားသောက်ကောင်တာများ" },
    description:
      "Fans top up a prepaid QR card at the cash counter, then pay for drinks, snacks and water at every bar with one scan.",
    bullets: [
      "Staff phones, stock and sales for every counter — VVIP, VIP, GA",
      "Income, stock and card-balance reports after the show",
      "Running at Myanmar festivals since 2017",
    ],
  },
  howItWorks: {
    image: img("/marketing/how.jpg", 2000, 1333),
    heading: { en: "How it works", mm: "အလုပ်လုပ်ပုံ" },
    intro: "From ticket sale to the front gate, in four steps. No screenshots to check.",
    steps: [
      { id: "pick", title: { en: "Fan picks a ticket tier", mm: "လက်မှတ်အမျိုးအစား ရွေးချယ်သည်" }, hidden: false },
      { id: "pay", title: { en: "Pays with KBZPay, MMQR or card", mm: "KBZPay၊ MMQR သို့မဟုတ် ကတ်ဖြင့် ပေးချေသည်" }, hidden: false },
      { id: "ticket", title: { en: "Gets a QR e-ticket", mm: "QR အီး-လက်မှတ် ရရှိသည်" }, hidden: false },
      { id: "scan", title: { en: "Staff scan it at the gate", mm: "ဝင်ပေါက်တွင် စကင်ဖတ်၍ ဝင်ရောက်သည်" }, hidden: false },
    ],
  },
  industries: {
    heading: { en: "Built for every event", mm: "မည်သည့်ပွဲအတွက်မဆို" },
    intro: "From open-air festivals to classrooms — one platform, with labels that adapt to your organisation type.",
    items: [
      { id: "festivals", name: { en: "Music festivals", mm: "ဂီတပွဲတော်များ" }, image: img("/marketing/festival.jpg", 1000, 750), hidden: false },
      { id: "concerts", name: { en: "Concerts", mm: "ဂီတဖျော်ဖြေပွဲများ" }, image: img("/marketing/concert.jpg", 1000, 1500), hidden: false },
      { id: "runs", name: { en: "Runs & sports", mm: "အပြေးနှင့် အားကစားပွဲများ" }, image: img("/marketing/run.jpg", 1000, 773), hidden: false },
      { id: "conferences", name: { en: "Conferences & shows", mm: "ညီလာခံနှင့် ပွဲများ" }, image: img("/marketing/conference.jpg", 1000, 564), hidden: false },
      { id: "schools", name: { en: "Schools & training", mm: "ကျောင်းနှင့် သင်တန်းများ" }, image: img("/marketing/school.jpg", 1000, 563), hidden: false },
      { id: "custom", name: { en: "Custom events", mm: "စိတ်ကြိုက်ပွဲများ" }, image: img("/marketing/custom.jpg", 1000, 668), hidden: false },
    ],
  },
  cta: {
    image: img("/marketing/cta.jpg", 2000, 1500),
    heading: { en: "Ready for your next festival?", mm: "သင့်နောက်ပွဲတော်အတွက် အသင့်ဖြစ်ပြီလား?" },
    intro: "Set up your event in minutes and start selling tickets today.",
    primary: "Start selling tickets",
    secondary: "Sign In",
  },
  footer: {
    tagline: "Festival and event ticketing for Myanmar — tickets, payments and gate scanning in one place.",
    productHeading: "Product",
    howItWorksLink: "How it works",
    organisersHeading: "Organisers",
    getStartedLink: "Get Started",
    signInLink: "Sign In",
    legalHeading: "Legal",
    privacyLink: "Privacy",
    copyright: "KuuNyi — Myanmar",
  },
};
```

- [ ] **Step 2: Type-check and commit Tasks 1 and 2**

```bash
npx tsc --noEmit
git status --short
git diff
git add src/lib/marketing/content.ts src/lib/marketing/defaultContent.ts src/__tests__/marketing/content.test.ts
git commit -m "feat(marketing): content types and default content" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `tsc` exit 0.

---

## Task 3: Validation

**Files:**
- Create: `src/lib/marketing/validate.ts`
- Test: `src/__tests__/marketing/validate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { validateMarketingContent } from "@/lib/marketing/validate";
import { defaultContent } from "@/lib/marketing/defaultContent";

const clone = () => JSON.parse(JSON.stringify(defaultContent));
const UUID_PNG = "3f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c.png";
const expectBad = (c: unknown) => expect(validateMarketingContent(c).ok).toBe(false);

describe("validateMarketingContent", () => {
  it("accepts defaultContent and returns it unchanged", () => {
    const r = validateMarketingContent(clone());
    expect(r).toEqual({ ok: true, content: defaultContent });
  });

  it.each([null, "x", [], 7])("rejects non-object %s", (v) => expectBad(v));

  it("rejects an unknown top-level key", () => {
    expectBad({ ...clone(), extra: 1 });
  });

  it("rejects an unknown nested key", () => {
    const c = clone();
    c.hero.href = "javascript:alert(1)";
    expectBad(c);
  });

  it("rejects a missing key", () => {
    const c = clone();
    delete c.seo.title;
    expectBad(c);
  });

  it("rejects the wrong schema version", () => {
    expectBad({ ...clone(), schemaVersion: 2 });
  });

  it("rejects oversized and blank text", () => {
    const a = clone();
    a.seo.title = "x".repeat(121);
    expectBad(a);
    const b = clone();
    b.hero.eyebrow = "   ";
    expectBad(b);
  });

  it.each([
    "https://evil.example/x.png",
    "//evil.example/x.png",
    "/marketing/../secret.png",
    "/other/x.png",
    "javascript:alert(1)",
    "/marketing/x.svg",
  ])("rejects static path %s", (path) => {
    const c = clone();
    c.hero.image.path = path;
    expectBad(c);
  });

  it("accepts the known payment logo files only outside /marketing", () => {
    const c = clone();
    c.payments.items[0].images[0].path = "/visa.svg";
    expect(validateMarketingContent(c).ok).toBe(true);
  });

  it("accepts a bucket path in the shape the upload route generates", () => {
    const c = clone();
    c.hero.image = { kind: "bucket", path: UUID_PNG, width: 10, height: 10 };
    expect(validateMarketingContent(c).ok).toBe(true);
  });

  it.each(["a/b.png", "../x.png", "x.png", "3f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c.svg"])(
    "rejects bucket path %s",
    (path) => {
      const c = clone();
      c.hero.image = { kind: "bucket", path, width: 10, height: 10 };
      expectBad(c);
    },
  );

  it("rejects bad dimensions", () => {
    const c = clone();
    c.hero.image.width = 0;
    expectBad(c);
    const d = clone();
    d.hero.image.height = 6001;
    expectBad(d);
  });

  it("caps list lengths", () => {
    const c = clone();
    c.organizers.items = Array.from({ length: 25 }, (_, i) => ({
      ...c.organizers.items[0],
      id: `o${i}`,
    }));
    expectBad(c);
  });

  it("rejects duplicate ids", () => {
    const c = clone();
    c.organizers.items[1].id = c.organizers.items[0].id;
    expectBad(c);
  });

  it("keeps fixed-count lists fixed", () => {
    const c = clone();
    c.howItWorks.steps.pop();
    expectBad(c);
  });

  it("allows an empty organizer list, and a null image only on solutions", () => {
    const a = clone();
    a.organizers.items = [];
    expect(validateMarketingContent(a).ok).toBe(true);
    const b = clone();
    b.industries.items[0].image = null;
    expectBad(b);
  });

  it("requires at least one image per payment", () => {
    const c = clone();
    c.payments.items[0].images = [];
    expectBad(c);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/__tests__/marketing/validate.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
import { MARKETING_SCHEMA_VERSION, SECTION_KEYS, type MarketingContent } from "./content";

export type ValidationResult =
  | { ok: true; content: MarketingContent }
  | { ok: false; errors: string[] };

const SHORT = 120;
const LONG = 600;
const SEO_DESCRIPTION = 300;
const NAME = 80;
const MAX_ORGANIZERS = 24;
const MAX_PAYMENTS = 12;
const MAX_PAYMENT_IMAGES = 4;
const MAX_IMAGE_SIDE = 6000;

// Item counts the page layout depends on. Items can be hidden, not added.
const SOLUTION_COUNT = 4;
const POS_BULLET_COUNT = 3;
const STEP_COUNT = 4;
const INDUSTRY_COUNT = 6;

const STATIC_PATH = /^\/marketing(\/[a-z0-9_-]+)+\.(jpe?g|png|webp)$/;
const PAYMENT_LOGO_FILES = new Set([
  "/kbzpay-logo.png",
  "/cbmmqr/cb-bank-logo.png",
  "/mmqr-logo.png",
  "/visa.svg",
  "/mastercard.svg",
]);
const BUCKET_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;
const ITEM_ID = /^[a-z0-9-]{1,40}$/;

type Obj = Record<string, unknown>;

/** Reads a tree of unknown values, collecting every problem rather than the first. */
class Checker {
  errors: string[] = [];

  fail(path: string, message: string) {
    this.errors.push(`${path}: ${message}`);
  }

  /** An object with exactly these keys. Returns null (and records why) otherwise. */
  obj(v: unknown, path: string, keys: string[]): Obj | null {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      this.fail(path, "must be an object");
      return null;
    }
    const o = v as Obj;
    for (const k of Object.keys(o)) if (!keys.includes(k)) this.fail(`${path}.${k}`, "unknown key");
    for (const k of keys) if (!(k in o)) this.fail(`${path}.${k}`, "missing");
    return o;
  }

  str(v: unknown, path: string, max = SHORT) {
    if (typeof v !== "string") return this.fail(path, "must be text");
    if (!v.trim()) return this.fail(path, "must not be blank");
    if (v.length > max) this.fail(path, `must be at most ${max} characters`);
  }

  bool(v: unknown, path: string) {
    if (typeof v !== "boolean") this.fail(path, "must be true or false");
  }

  loc(v: unknown, path: string, max = SHORT) {
    const o = this.obj(v, path, ["en", "mm"]);
    if (!o) return;
    this.str(o.en, `${path}.en`, max);
    this.str(o.mm, `${path}.mm`, max);
  }

  image(v: unknown, path: string) {
    const o = this.obj(v, path, ["kind", "path", "width", "height"]);
    if (!o) return;
    if (o.kind === "static") {
      const p = o.path;
      if (typeof p !== "string" || !(STATIC_PATH.test(p) || PAYMENT_LOGO_FILES.has(p))) {
        this.fail(`${path}.path`, "is not an allowed static image");
      }
    } else if (o.kind === "bucket") {
      if (typeof o.path !== "string" || !BUCKET_PATH.test(o.path)) {
        this.fail(`${path}.path`, "is not an uploaded image path");
      }
    } else {
      this.fail(`${path}.kind`, "must be static or bucket");
    }
    for (const side of ["width", "height"] as const) {
      const n = o[side];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_IMAGE_SIDE) {
        this.fail(`${path}.${side}`, `must be a whole number from 1 to ${MAX_IMAGE_SIDE}`);
      }
    }
  }

  /** A list with `min`..`max` entries. Returns [] (and records why) otherwise. */
  list(v: unknown, path: string, min: number, max: number): unknown[] {
    if (!Array.isArray(v)) {
      this.fail(path, "must be a list");
      return [];
    }
    if (v.length < min || v.length > max) {
      this.fail(path, min === max ? `must have exactly ${max} items` : `must have ${min} to ${max} items`);
    }
    return v;
  }

  /** Item ids must be well-formed and unique: React keys and reorder depend on it. */
  ids(items: unknown[], path: string) {
    const seen = new Set<unknown>();
    items.forEach((item, i) => {
      const id = (item as Obj | null)?.id;
      if (typeof id !== "string" || !ITEM_ID.test(id)) this.fail(`${path}[${i}].id`, "is not a valid id");
      if (seen.has(id)) this.fail(`${path}[${i}].id`, "is a duplicate");
      seen.add(id);
    });
  }
}

const TOP_KEYS = [
  "schemaVersion", "seo", "sections", "hero", "organizers", "payments",
  "solutions", "pos", "howItWorks", "industries", "cta", "footer",
];
const FOOTER_KEYS = [
  "tagline", "productHeading", "howItWorksLink", "organisersHeading",
  "getStartedLink", "signInLink", "legalHeading", "privacyLink", "copyright",
];

export function validateMarketingContent(input: unknown): ValidationResult {
  const c = new Checker();
  const top = c.obj(input, "content", TOP_KEYS);
  if (!top) return { ok: false, errors: c.errors };

  if (top.schemaVersion !== MARKETING_SCHEMA_VERSION) {
    c.fail("schemaVersion", `must be ${MARKETING_SCHEMA_VERSION}`);
  }

  const seo = c.obj(top.seo, "seo", ["title", "description"]);
  if (seo) {
    c.str(seo.title, "seo.title");
    c.str(seo.description, "seo.description", SEO_DESCRIPTION);
  }

  const sections = c.obj(top.sections, "sections", [...SECTION_KEYS]);
  if (sections) for (const k of SECTION_KEYS) c.bool(sections[k], `sections.${k}`);

  const hero = c.obj(top.hero, "hero", [
    "image", "signIn", "getStarted", "eyebrow", "headline", "subtext", "primaryCta", "secondaryCta", "trust",
  ]);
  if (hero) {
    c.image(hero.image, "hero.image");
    for (const k of ["signIn", "getStarted", "eyebrow", "primaryCta", "secondaryCta"]) c.str(hero[k], `hero.${k}`);
    c.loc(hero.headline, "hero.headline");
    c.str(hero.subtext, "hero.subtext", LONG);
    c.loc(hero.trust, "hero.trust", LONG);
  }

  const organizers = c.obj(top.organizers, "organizers", ["heading", "intro", "items"]);
  if (organizers) {
    c.loc(organizers.heading, "organizers.heading");
    c.str(organizers.intro, "organizers.intro", LONG);
    const items = c.list(organizers.items, "organizers.items", 0, MAX_ORGANIZERS);
    c.ids(items, "organizers.items");
    items.forEach((item, i) => {
      const p = `organizers.items[${i}]`;
      const o = c.obj(item, p, ["id", "name", "image", "hidden"]);
      if (!o) return;
      c.str(o.name, `${p}.name`, NAME);
      c.image(o.image, `${p}.image`);
      c.bool(o.hidden, `${p}.hidden`);
    });
  }

  const payments = c.obj(top.payments, "payments", ["heading", "items"]);
  if (payments) {
    c.loc(payments.heading, "payments.heading");
    const items = c.list(payments.items, "payments.items", 0, MAX_PAYMENTS);
    c.ids(items, "payments.items");
    items.forEach((item, i) => {
      const p = `payments.items[${i}]`;
      const o = c.obj(item, p, ["id", "name", "images", "hidden"]);
      if (!o) return;
      c.str(o.name, `${p}.name`, NAME);
      c.list(o.images, `${p}.images`, 1, MAX_PAYMENT_IMAGES).forEach((im, j) => c.image(im, `${p}.images[${j}]`));
      c.bool(o.hidden, `${p}.hidden`);
    });
  }

  const solutions = c.obj(top.solutions, "solutions", ["eyebrow", "heading", "intro", "items"]);
  if (solutions) {
    c.str(solutions.eyebrow, "solutions.eyebrow");
    c.loc(solutions.heading, "solutions.heading");
    c.str(solutions.intro, "solutions.intro", LONG);
    const items = c.list(solutions.items, "solutions.items", SOLUTION_COUNT, SOLUTION_COUNT);
    c.ids(items, "solutions.items");
    items.forEach((item, i) => {
      const p = `solutions.items[${i}]`;
      const o = c.obj(item, p, ["id", "label", "title", "description", "image", "hidden"]);
      if (!o) return;
      c.str(o.label, `${p}.label`);
      c.loc(o.title, `${p}.title`);
      c.str(o.description, `${p}.description`, LONG);
      if (o.image !== null) c.image(o.image, `${p}.image`);
      c.bool(o.hidden, `${p}.hidden`);
    });
  }

  const pos = c.obj(top.pos, "pos", ["image", "eyebrow", "title", "description", "bullets"]);
  if (pos) {
    c.image(pos.image, "pos.image");
    c.str(pos.eyebrow, "pos.eyebrow");
    c.loc(pos.title, "pos.title");
    c.str(pos.description, "pos.description", LONG);
    c.list(pos.bullets, "pos.bullets", POS_BULLET_COUNT, POS_BULLET_COUNT).forEach((b, i) =>
      c.str(b, `pos.bullets[${i}]`),
    );
  }

  const how = c.obj(top.howItWorks, "howItWorks", ["image", "heading", "intro", "steps"]);
  if (how) {
    c.image(how.image, "howItWorks.image");
    c.loc(how.heading, "howItWorks.heading");
    c.str(how.intro, "howItWorks.intro", LONG);
    const steps = c.list(how.steps, "howItWorks.steps", STEP_COUNT, STEP_COUNT);
    c.ids(steps, "howItWorks.steps");
    steps.forEach((item, i) => {
      const p = `howItWorks.steps[${i}]`;
      const o = c.obj(item, p, ["id", "title", "hidden"]);
      if (!o) return;
      c.loc(o.title, `${p}.title`);
      c.bool(o.hidden, `${p}.hidden`);
    });
  }

  const industries = c.obj(top.industries, "industries", ["heading", "intro", "items"]);
  if (industries) {
    c.loc(industries.heading, "industries.heading");
    c.str(industries.intro, "industries.intro", LONG);
    const items = c.list(industries.items, "industries.items", INDUSTRY_COUNT, INDUSTRY_COUNT);
    c.ids(items, "industries.items");
    items.forEach((item, i) => {
      const p = `industries.items[${i}]`;
      const o = c.obj(item, p, ["id", "name", "image", "hidden"]);
      if (!o) return;
      c.loc(o.name, `${p}.name`);
      c.image(o.image, `${p}.image`);
      c.bool(o.hidden, `${p}.hidden`);
    });
  }

  const cta = c.obj(top.cta, "cta", ["image", "heading", "intro", "primary", "secondary"]);
  if (cta) {
    c.image(cta.image, "cta.image");
    c.loc(cta.heading, "cta.heading");
    c.str(cta.intro, "cta.intro", LONG);
    c.str(cta.primary, "cta.primary");
    c.str(cta.secondary, "cta.secondary");
  }

  const footer = c.obj(top.footer, "footer", FOOTER_KEYS);
  if (footer) {
    for (const k of FOOTER_KEYS) c.str(footer[k], `footer.${k}`, k === "tagline" ? LONG : SHORT);
  }

  if (c.errors.length) return { ok: false, errors: c.errors };
  return { ok: true, content: input as MarketingContent };
}
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/__tests__/marketing/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git status --short
git diff
git add src/lib/marketing/validate.ts src/__tests__/marketing/validate.test.ts
git commit -m "feat(marketing): validate content before it is saved or rendered" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: Migration

**Files:**
- Create: `supabase/migrations/20261102120000_marketing_page_versions.sql`
- Test: `src/__tests__/db/marketing-page.db.test.ts`

The DB suite needs the local Supabase stack and `.env.test.local`. `setup.ts` refuses any non-local host. Apply locally with `npx supabase migration up --local`. Never run `supabase db reset` without the owner's confirmation. If the stack isn't running, start it with `npx supabase start`; if that fails, report it instead of skipping these tests.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { Pool, Client } from "pg";

// ─── Marketing versions, against the REAL database ───────────────────────────
// Locks, partial unique indexes and ACLs don't exist in a mock.

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows as T[];

const CONTENT = JSON.stringify({ marker: "test" });
const TABLE = "public.marketing_page_versions";
const FUNCTIONS = [
  "public.publish_marketing_draft(integer,uuid)",
  "public.create_marketing_draft(uuid,jsonb,uuid)",
];

const create = (base: string | null) =>
  sql<{ id: string }>(
    `SELECT public.create_marketing_draft($1::uuid, $2::jsonb, NULL::uuid) AS id`,
    [base, CONTENT],
  );
const publish = (rev: number) =>
  sql<{ id: string }>(`SELECT public.publish_marketing_draft($1, NULL::uuid) AS id`, [rev]);
const rows = () => sql<{ id: string; status: string; revision: number }>(`SELECT id, status, revision FROM ${TABLE}`);

async function publishedId(): Promise<string> {
  const [d] = await create(null);
  await publish(1);
  return d.id;
}

describe("marketing_page_versions", () => {
  beforeAll(async () => {
    await sql(`DELETE FROM ${TABLE}`);
  });
  afterEach(async () => {
    await sql(`DELETE FROM ${TABLE}`);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("first save creates a draft at revision 1", async () => {
    await create(null);
    expect(await rows()).toMatchObject([{ status: "draft", revision: 1 }]);
  });

  it("rejects a second draft", async () => {
    await create(null);
    await expect(create(null)).rejects.toThrow(/marketing_draft_stale/);
  });

  it("gives exactly one winner to concurrent first saves", async () => {
    const results = await Promise.allSettled([create(null), create(null), create(null)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("the partial indexes allow one draft and one published row", async () => {
    await create(null);
    await expect(
      sql(`INSERT INTO ${TABLE} (status, content) VALUES ('draft', $1::jsonb)`, [CONTENT]),
    ).rejects.toThrow(/duplicate key/);
    await publish(1);
    await expect(
      sql(`INSERT INTO ${TABLE} (status, content) VALUES ('published', $1::jsonb)`, [CONTENT]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("publish archives the old row and promotes the draft", async () => {
    const first = await publishedId();
    const [second] = await create(first);
    await publish(1);
    const all = await rows();
    expect(all.find((r) => r.id === first)?.status).toBe("archived");
    expect(all.find((r) => r.id === second.id)?.status).toBe("published");
    expect(all).toHaveLength(2);
  });

  it("publish rejects a stale revision and changes nothing", async () => {
    await create(null);
    await expect(publish(2)).rejects.toThrow(/marketing_draft_stale/);
    expect(await rows()).toMatchObject([{ status: "draft", revision: 1 }]);
  });

  it("publish rejects a missing draft", async () => {
    await expect(publish(1)).rejects.toThrow(/marketing_draft_stale/);
  });

  it("a stale first save after a publish is rejected", async () => {
    const first = await publishedId();
    const [d] = await create(first);
    await publish(1);
    expect(d.id).toBeTruthy();
    // This editor loaded while `first` was published.
    await expect(create(first)).rejects.toThrow(/marketing_draft_stale/);
    // An editor who never saw any published row is stale too.
    await expect(create(null)).rejects.toThrow(/marketing_draft_stale/);
  });

  it("a first save racing a publish waits, then fails as stale", async () => {
    const first = await publishedId();
    await create(first);
    const a = new Client({ connectionString: process.env.DATABASE_URL });
    await a.connect();
    try {
      await a.query("BEGIN");
      await a.query(`SELECT public.publish_marketing_draft(1, NULL::uuid)`);
      const racing = create(first);
      await new Promise((r) => setTimeout(r, 300));
      await a.query("COMMIT");
      await expect(racing).rejects.toThrow(/marketing_draft_stale/);
    } finally {
      await a.end();
    }
  });

  it("a conditional update can't touch a draft that was just published", async () => {
    await create(null);
    await publish(1);
    const res = await pool.query(
      `UPDATE ${TABLE} SET revision = 2 WHERE status = 'draft' AND revision = 1`,
    );
    expect(res.rowCount).toBe(0);
  });

  it("has RLS on and no policies", async () => {
    const [t] = await sql<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = '${TABLE}'::regclass`,
    );
    expect(t.relrowsecurity).toBe(true);
    const policies = await sql(`SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='marketing_page_versions'`);
    expect(policies).toHaveLength(0);
  });

  // setup.ts grants full DML on every table AFTER migrations, so relacl here
  // always shows it. Replay the whole migration in a rolled-back transaction,
  // under default privileges that mirror hosted Supabase, and check the result.
  // Real privileges are also checked on dev.
  it("the whole migration leaves anon and authenticated with nothing, despite hosted default grants", async () => {
    const file = path.join(process.cwd(), "supabase/migrations/20261102120000_marketing_page_versions.sql");
    const migration = fs
      .readFileSync(file, "utf8")
      .replace(/^BEGIN;\s*$/m, "")
      .replace(/^COMMIT;\s*$/m, "");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
        DROP FUNCTION public.publish_marketing_draft(integer, uuid);
        DROP FUNCTION public.create_marketing_draft(uuid, jsonb, uuid);
        DROP TABLE ${TABLE};
      `);
      await client.query(migration);
      for (const role of ["anon", "authenticated"]) {
        for (const fn of FUNCTIONS) {
          const { rows: r } = await client.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
          expect(r[0].ok, `${role} ${fn}`).toBe(false);
        }
        for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const { rows: r } = await client.query(`SELECT has_table_privilege($1, $2, $3) AS ok`, [role, TABLE, priv]);
          expect(r[0].ok, `${role} ${priv}`).toBe(false);
        }
      }
      // A comma list would pass if ANY one were held, so check each.
      for (const priv of ["SELECT", "INSERT", "UPDATE"]) {
        const { rows: s } = await client.query(`SELECT has_table_privilege('service_role', $1, $2) AS ok`, [TABLE, priv]);
        expect(s[0].ok, `service_role ${priv}`).toBe(true);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it.each(FUNCTIONS)("%s is executable by service_role only", async (fn) => {
    for (const role of ["anon", "authenticated"]) {
      const [r] = await sql<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
      expect(r.ok, role).toBe(false);
    }
    const [s] = await sql<{ ok: boolean }>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [fn]);
    expect(s.ok).toBe(true);
    const [p] = await sql<{ public_exec: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
         WHERE p.oid = $1::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) AS public_exec`,
      [fn],
    );
    expect(p.public_exec).toBe(false);
  });

  it("creates the bucket with limits and no write policies", async () => {
    const [b] = await sql<{ public: boolean; file_size_limit: string; allowed_mime_types: string[] }>(
      `SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'marketing-assets'`,
    );
    expect(b.public).toBe(true);
    expect(Number(b.file_size_limit)).toBe(4 * 1024 * 1024);
    expect([...b.allowed_mime_types].sort()).toEqual(["image/jpeg", "image/png", "image/webp"]);
    const policies = await sql(
      `SELECT 1 FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND (COALESCE(qual,'') LIKE '%marketing-assets%' OR COALESCE(with_check,'') LIKE '%marketing-assets%')`,
    );
    expect(policies).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:db -- marketing-page`
Expected: FAIL, relation or function doesn't exist.

- [ ] **Step 3: Write the migration**

```sql
-- ─── Marketing page versions ─────────────────────────────────────────────────
--
-- Versioned content for the marketing homepage: at most one draft and one
-- published row, plus any number of archived rows for restore.
--
-- Access is server-side only, with the service role, after requireSuperadmin.
-- RLS alone doesn't remove grants, and hosted Supabase gives new tables and
-- functions to anon and authenticated by default, so both are revoked below.
--
-- Additive, and safe in either order: without this migration the public page
-- falls back to defaultContent and the Marketing screen says "not configured".

BEGIN;

CREATE TABLE public.marketing_page_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  content      jsonb NOT NULL,
  revision     integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  published_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE UNIQUE INDEX marketing_page_versions_one_draft
  ON public.marketing_page_versions (status) WHERE status = 'draft';
CREATE UNIQUE INDEX marketing_page_versions_one_published
  ON public.marketing_page_versions (status) WHERE status = 'published';

ALTER TABLE public.marketing_page_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.marketing_page_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.marketing_page_versions TO service_role;

-- First save. Both functions take the same lock first. Otherwise a save could
-- read the old published id, wait on the unique index while a publish commits,
-- and then insert content based on a version that is no longer live.
CREATE FUNCTION public.create_marketing_draft(
  p_base_published_id uuid,
  p_content jsonb,
  p_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_published uuid;
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('marketing_page_versions', 0));

  IF EXISTS (SELECT 1 FROM public.marketing_page_versions WHERE status = 'draft') THEN
    RAISE EXCEPTION 'marketing_draft_stale' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_published FROM public.marketing_page_versions WHERE status = 'published';
  IF v_published IS DISTINCT FROM p_base_published_id THEN
    RAISE EXCEPTION 'marketing_draft_stale' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.marketing_page_versions (status, content, revision, created_by)
  VALUES ('draft', p_content, 1, p_user_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE FUNCTION public.publish_marketing_draft(
  p_expected_revision integer,
  p_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('marketing_page_versions', 0));

  SELECT id, revision INTO v_id, v_revision
  FROM public.marketing_page_versions
  WHERE status = 'draft'
  FOR UPDATE;

  IF v_id IS NULL OR v_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'marketing_draft_stale' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.marketing_page_versions
  SET status = 'archived', updated_at = now()
  WHERE status = 'published';

  UPDATE public.marketing_page_versions
  SET status = 'published', published_by = p_user_id, published_at = now(), updated_at = now()
  WHERE id = v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_marketing_draft(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_marketing_draft(integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_marketing_draft(uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_marketing_draft(integer, uuid) TO service_role;

-- Public read through its URL. No write policies on purpose: uploads only
-- happen through the superadmin route, with the service role.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'marketing-assets',
  'marketing-assets',
  true,
  4194304,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

COMMIT;
```

- [ ] **Step 4: Apply locally and run**

```bash
npx supabase migration up --local
npm run test:db -- marketing-page
```

Expected: exit 0 on both. A failing race test is a defect; don't weaken it.

- [ ] **Step 5: Commit**

```bash
git status --short
git diff
git add supabase/migrations/20261102120000_marketing_page_versions.sql src/__tests__/db/marketing-page.db.test.ts
git commit -m "feat(marketing): versions table, publish and draft functions, bucket" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: Store and public loader

**Files:**
- Modify: `src/types/database.ts` (`Tables` around line 457, `Functions` around line 503)
- Create: `src/lib/marketing/store.ts`, `src/lib/marketing/published.ts`
- Test: `src/__tests__/marketing/published.test.ts`

- [ ] **Step 1: Add the types**

Inside `Database.public.Tables`, following the shape of the neighbouring entries:

```ts
marketing_page_versions: {
  Row: MarketingPageVersion;
  Insert: Partial<MarketingPageVersion> & { status: MarketingPageVersion["status"]; content: unknown };
  Update: Partial<MarketingPageVersion>;
  Relationships: [];
};
```

Inside `Database.public.Functions`:

```ts
create_marketing_draft: {
  Args: { p_base_published_id: string | null; p_content: unknown; p_user_id: string };
  Returns: string;
};
publish_marketing_draft: {
  Args: { p_expected_revision: number; p_user_id: string };
  Returns: string;
};
```

Near the other row types (exported):

```ts
export interface MarketingPageVersion {
  id: string;
  status: "draft" | "published" | "archived";
  content: unknown;
  revision: number;
  created_by: string | null;
  published_by: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}
```

If neighbouring entries omit `Relationships`, omit it here too.

- [ ] **Step 2: Write `store.ts`**

```ts
import type { createAdminClient } from "@/lib/supabase/admin";
import type { MarketingPageVersion } from "@/types/database";
import type { MarketingContent } from "./content";

type Admin = ReturnType<typeof createAdminClient>;
type DbError = { code?: string; message?: string; statusCode?: string } | null;

export const VERSION_LIST_LIMIT = 20;

export type WriteResult =
  | { ok: true; revision: number }
  | { ok: false; reason: "stale" | "not_configured" | "error" };

/** The table, function or bucket isn't there yet: the migration hasn't been applied. */
export function isNotConfigured(error: DbError): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" || // undefined table
    error.code === "42883" || // undefined function
    error.code === "PGRST202" || // function not in the schema cache
    error.code === "PGRST205" || // table not in the schema cache
    error.statusCode === "NoSuchBucket" ||
    /bucket not found/i.test(error.message ?? "")
  );
}

export function isStale(error: DbError): boolean {
  return /marketing_draft_stale/.test(error?.message ?? "");
}

function failure(error: DbError): WriteResult {
  if (isStale(error)) return { ok: false, reason: "stale" };
  if (isNotConfigured(error)) return { ok: false, reason: "not_configured" };
  console.error("[marketing] write failed:", error?.code, error?.message);
  return { ok: false, reason: "error" };
}

export async function readVersion(admin: Admin, status: "draft" | "published") {
  const { data, error } = (await admin
    .from("marketing_page_versions")
    .select("*")
    .eq("status", status)
    .maybeSingle()) as { data: MarketingPageVersion | null; error: DbError };
  return { row: data, error };
}

export async function listArchived(admin: Admin) {
  const { data, error } = (await admin
    .from("marketing_page_versions")
    .select("id, published_at")
    .eq("status", "archived")
    .order("published_at", { ascending: false })
    .limit(VERSION_LIST_LIMIT)) as {
    data: Pick<MarketingPageVersion, "id" | "published_at">[] | null;
    error: DbError;
  };
  return { rows: data ?? [], error };
}

/**
 * The only way content reaches the draft row. Revision 0 means no draft existed
 * when the editor loaded: the function creates one only if that's still true and
 * the published version hasn't changed. Any other revision must still match.
 */
export async function writeDraft(
  admin: Admin,
  args: {
    content: MarketingContent;
    expectedRevision: number;
    basePublishedId: string | null;
    userId: string;
  },
): Promise<WriteResult> {
  if (args.expectedRevision === 0) {
    const { error } = (await admin.rpc("create_marketing_draft", {
      p_base_published_id: args.basePublishedId,
      p_content: args.content,
      p_user_id: args.userId,
    } as never)) as { error: DbError };
    return error ? failure(error) : { ok: true, revision: 1 };
  }

  const revision = args.expectedRevision + 1;
  const { data, error } = (await admin
    .from("marketing_page_versions")
    .update({ content: args.content, revision, updated_at: new Date().toISOString() } as never)
    .eq("status", "draft")
    .eq("revision", args.expectedRevision)
    .select("id")) as { data: { id: string }[] | null; error: DbError };
  if (error) return failure(error);
  if (!data?.length) return { ok: false, reason: "stale" };
  return { ok: true, revision };
}
```

- [ ] **Step 3: Write the failing loader test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// unstable_cache needs Next's incremental cache, which doesn't exist in Vitest.
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: (fn: unknown) => fn }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { getPublishedMarketingContent } from "@/lib/marketing/published";
import { defaultContent } from "@/lib/marketing/defaultContent";

function mockRead(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const chain = { select: () => chain, eq: () => chain, maybeSingle };
  vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);
}

describe("getPublishedMarketingContent", () => {
  let err: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    err.mockRestore();
    warn.mockRestore();
  });

  it("returns published content when it is valid", async () => {
    const published = { ...defaultContent, seo: { ...defaultContent.seo, title: "Published" } };
    mockRead({ data: { content: published }, error: null });
    expect((await getPublishedMarketingContent()).seo.title).toBe("Published");
  });

  it("falls back and warns when no row exists", async () => {
    mockRead({ data: null, error: null });
    expect(await getPublishedMarketingContent()).toEqual(defaultContent);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back and logs on a query error, such as a missing table", async () => {
    mockRead({ data: null, error: { code: "42P01", message: "does not exist" } });
    expect(await getPublishedMarketingContent()).toEqual(defaultContent);
    expect(err).toHaveBeenCalled();
  });

  it("falls back and logs on invalid content", async () => {
    mockRead({ data: { content: { nope: true } }, error: null });
    expect(await getPublishedMarketingContent()).toEqual(defaultContent);
    expect(err).toHaveBeenCalled();
  });

  it("falls back when the client can't be created", async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("no env");
    });
    expect(await getPublishedMarketingContent()).toEqual(defaultContent);
    expect(err).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/__tests__/marketing/published.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 5: Write `published.ts`**

```ts
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { MARKETING_CACHE_TAG, MARKETING_SCHEMA_VERSION, type MarketingContent } from "./content";
import { defaultContent } from "./defaultContent";
import { validateMarketingContent } from "./validate";

// Failures throw inside the cached function so they aren't cached. The key
// carries the database host because environments can share a Vercel data cache
// while reading different databases.
const readPublished = unstable_cache(
  async (): Promise<MarketingContent | null> => {
    const { data, error } = (await createAdminClient()
      .from("marketing_page_versions")
      .select("content")
      .eq("status", "published")
      .maybeSingle()) as {
      data: { content: unknown } | null;
      error: { code?: string; message?: string } | null;
    };
    if (error) throw new Error(`read failed: ${error.code ?? ""} ${error.message ?? ""}`);
    if (!data) return null;
    const result = validateMarketingContent(data.content);
    if (!result.ok) throw new Error(`invalid content: ${result.errors.slice(0, 5).join("; ")}`);
    return result.content;
  },
  ["marketing-published", String(MARKETING_SCHEMA_VERSION), process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""],
  { tags: [MARKETING_CACHE_TAG], revalidate: 300 },
);

/** Never throws: the public page must not fail because of this feature. */
export const getPublishedMarketingContent = cache(async (): Promise<MarketingContent> => {
  try {
    const content = await readPublished();
    if (content) return content;
    console.warn("[marketing] nothing published yet, using defaultContent");
  } catch (e) {
    console.error("[marketing] using defaultContent:", e instanceof Error ? e.message : e);
  }
  return defaultContent;
});
```

- [ ] **Step 6: Run and commit**

```bash
npx vitest run src/__tests__/marketing/published.test.ts
npx tsc --noEmit
git status --short
git diff
git add src/types/database.ts src/lib/marketing/store.ts src/lib/marketing/published.ts src/__tests__/marketing/published.test.ts
git commit -m "feat(marketing): draft store and cached public loader with fallback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: exit 0 on both.

---

## Task 6: `MarketingPage` and the thin public page

**Files:**
- Create: `src/components/marketing/MarketingPage.tsx`
- Modify: `src/app/page.tsx`
- Test: `src/__tests__/marketing/marketingPage.test.tsx`
- Temporary, never committed: `src/__tests__/marketing/__oldPage.tsx`

- [ ] **Step 1: Keep the old page for a one-time comparison**

```bash
cp src/app/page.tsx src/__tests__/marketing/__oldPage.tsx
```

- [ ] **Step 2: Write the tests**

`src/__tests__/marketing/marketingPage.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ImgHTMLAttributes } from "react";

vi.mock("next/image", () => ({
  default: ({ src, alt, priority, fill, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean; fill?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} data-fill={fill ? "1" : undefined} data-priority={priority ? "1" : undefined} {...rest} />
  ),
}));

import MarketingPage from "@/components/marketing/MarketingPage";
import { defaultContent } from "@/lib/marketing/defaultContent";
import type { MarketingContent } from "@/lib/marketing/content";

const clone = (): MarketingContent => JSON.parse(JSON.stringify(defaultContent));
const html = (c: MarketingContent) => renderToStaticMarkup(<MarketingPage content={c} />);

describe("MarketingPage", () => {
  it("renders text as text, not HTML", () => {
    const c = clone();
    c.hero.subtext = "<script>alert(1)</script>";
    expect(html(c)).not.toContain("<script>alert(1)");
  });

  it("hides organizers, payments and industries when switched off", () => {
    const c = clone();
    c.sections.organizers = false;
    c.sections.payments = false;
    c.sections.industries = false;
    const out = html(c);
    expect(out).not.toContain(c.organizers.heading.en);
    expect(out).not.toContain(c.payments.heading.en);
    expect(out).not.toContain(c.industries.heading.en);
  });

  it("hides the card grid and the POS card independently", () => {
    const a = clone();
    a.sections.solutions = false;
    const noCards = html(a);
    expect(noCards).not.toContain(a.solutions.heading.en);
    expect(noCards).toContain(a.pos.title.en.replace("&", "&amp;"));

    const b = clone();
    b.sections.pos = false;
    const noPos = html(b);
    expect(noPos).toContain(b.solutions.heading.en);
    expect(noPos).not.toContain(b.pos.description);
  });

  it("removes every link to #how when How it works is hidden", () => {
    const c = clone();
    c.sections.howItWorks = false;
    const out = html(c);
    expect(out).not.toContain('href="#how"');
    expect(out).not.toContain('id="how"');
    expect(out).not.toContain(c.footer.productHeading);
  });

  it("doesn't render hidden items", () => {
    const c = clone();
    c.organizers.items[0].hidden = true;
    c.payments.items[0].hidden = true;
    c.industries.items[0].hidden = true;
    const out = html(c);
    expect(out).not.toContain(c.organizers.items[0].name);
    expect(out).not.toContain('alt="KBZPay"');
    expect(out).not.toContain(c.industries.items[0].name.en);
  });

  it("numbers steps by visible position", () => {
    const c = clone();
    c.howItWorks.steps[1].hidden = true;
    const out = html(c);
    expect(out).toContain(">03<");
    expect(out).not.toContain(">04<");
  });

  it("drops a section whose items are all hidden", () => {
    const c = clone();
    c.organizers.items.forEach((o) => (o.hidden = true));
    expect(html(c)).not.toContain(c.organizers.heading.en);
  });

  it("renders a bucket image from the current environment's host", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abc.supabase.co";
    const c = clone();
    c.hero.image = { kind: "bucket", path: "3f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c.png", width: 10, height: 10 };
    expect(html(c)).toContain(
      "https://abc.supabase.co/storage/v1/object/public/marketing-assets/3f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c.png",
    );
  });
});
```

`src/__tests__/marketing/__parity.test.tsx` (temporary, not committed):

```tsx
import { it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ImgHTMLAttributes } from "react";

vi.mock("next/image", () => ({
  default: ({ src, alt, priority, fill, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean; fill?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} data-fill={fill ? "1" : undefined} data-priority={priority ? "1" : undefined} {...rest} />
  ),
}));

import OldPage from "./__oldPage";
import MarketingPage from "@/components/marketing/MarketingPage";
import { defaultContent } from "@/lib/marketing/defaultContent";

it("defaultContent renders the same markup as the page it replaces", () => {
  const old = renderToStaticMarkup(<OldPage />)
    // The one intended change: Visa and Mastercard are one payment, named once.
    .replace('alt="Visa"', 'alt="Visa &amp; Mastercard"')
    .replace('alt="Mastercard"', 'alt=""');
  expect(renderToStaticMarkup(<MarketingPage content={defaultContent} />)).toBe(old);
});
```

- [ ] **Step 3: Run them**

Run: `npx vitest run src/__tests__/marketing/marketingPage.test.tsx src/__tests__/marketing/__parity.test.tsx`
Expected: FAIL, `MarketingPage` not found.

- [ ] **Step 4: Create `MarketingPage.tsx`**

Move the JSX from `LandingPage` in `src/app/page.tsx` verbatim, keeping every class name, and make only these changes:

```tsx
import Link from "next/link";
import Image from "next/image";
import { marketingImageSrc as src, type MarketingContent } from "@/lib/marketing/content";

export default function MarketingPage({ content }: { content: MarketingContent }) {
  const { sections, hero, organizers, payments, solutions, pos, howItWorks, industries, cta, footer } = content;

  const visibleOrganizers = organizers.items.filter((o) => !o.hidden);
  const visiblePayments = payments.items.filter((p) => !p.hidden);
  const visibleSolutions = solutions.items.filter((s) => !s.hidden);
  const visibleSteps = howItWorks.steps.filter((s) => !s.hidden);
  const visibleIndustries = industries.items.filter((i) => !i.hidden);

  const showOrganizers = sections.organizers && visibleOrganizers.length > 0;
  const showPayments = sections.payments && visiblePayments.length > 0;
  const showCards = sections.solutions && visibleSolutions.length > 0;
  const showHow = sections.howItWorks && visibleSteps.length > 0;
  const showIndustries = sections.industries && visibleIndustries.length > 0;
  // ...
}
```

| Today's markup | Becomes |
|---|---|
| Hero `src="/marketing/hero.jpg"` | `src={src(hero.image)}` |
| "Sign In", "Get Started" in the navbar | `hero.signIn`, `hero.getStarted` |
| "Festival &amp; event ticketing" | `hero.eyebrow` |
| h1, Myanmar line under it | `hero.headline.en`, `hero.headline.mm` |
| "Tickets, payments and gate scanning…" | `hero.subtext` |
| "Start selling tickets", "See how it works" | `hero.primaryCta`, `hero.secondaryCta`; wrap the second link in `{showHow && …}` |
| Trust line and its Myanmar span | `hero.trust.en`, `hero.trust.mm` |
| Trusted-by `<section>` | Wrap in `{showOrganizers && …}`; `organizers.heading.en/.mm`, `organizers.intro` |
| `ORGANIZERS.map` | `visibleOrganizers.map`, `key={org.id}`, `src={src(org.image)}`, `alt={org.name}`, `width={org.image.width}`, `height={org.image.height}` |
| Payments `<section>` | Wrap in `{showPayments && …}`; `payments.heading.en/.mm` |
| `PAYMENT_LOGOS.map` in the strip | `visiblePayments.flatMap((p) => p.images.map((image, i) => <Image key={`${p.id}-${i}`} src={src(image)} alt={i === 0 ? p.name : ""} width={image.width} height={image.height} className="h-9 sm:h-10 w-auto object-contain" />))` |
| Solutions `<section>` | Render when `{(showCards \|\| sections.pos) && …}`. Wrap the heading block and the card grid in `{showCards && <>…</>}`. Wrap the POS `<article>` in `{sections.pos && …}`. Keep its `mt-6` class so the markup matches. |
| Heading block | `solutions.eyebrow`, `solutions.heading.en/.mm`, `solutions.intro` |
| `SOLUTIONS.map` | `visibleSolutions.map`, `key={s.id}`; `s.image ? <Image src={src(s.image)} …/> : <chips>`; `s.label`, `s.title.en`, `s.title.mm`, `s.description` |
| Chip list | `visiblePayments.slice(0, 4).map((p) => <div key={p.id} className="h-16 rounded-xl bg-white flex items-center justify-center gap-2 p-3">{p.images.map((image, i) => <Image key={i} src={src(image)} alt="" width={image.width} height={image.height} className="max-h-full w-auto object-contain" />)}</div>)` |
| POS card | `src(pos.image)`, `pos.eyebrow`, `pos.title.en/.mm`, `pos.description`; `pos.bullets.map` |
| How-it-works `<section id="how">` | Wrap in `{showHow && …}`; `src(howItWorks.image)`, `howItWorks.heading.en/.mm`, `howItWorks.intro` |
| `STEPS.map` | `visibleSteps.map((s, i) => …)`, `key={s.id}`, number is `String(i + 1).padStart(2, "0")`, `s.title.en/.mm` |
| Industries `<section>` | Wrap in `{showIndustries && …}`; `industries.heading.en/.mm`, `industries.intro` |
| `INDUSTRIES.map` | `visibleIndustries.map`, `key={ind.id}`, `src(ind.image)`, `ind.name.en/.mm` |
| CTA `<section>` | Wrap in `{sections.cta && …}`; `src(cta.image)`, `cta.heading.en/.mm`, `cta.intro`, `cta.primary`, `cta.secondary` |
| Footer tagline | `footer.tagline` |
| Footer Product column | Wrap the whole `<div>` in `{showHow && …}`; `footer.productHeading`, `footer.howItWorksLink` |
| Footer Organisers and Legal columns | `footer.organisersHeading`, `footer.getStartedLink`, `footer.signInLink`, `footer.legalHeading`, `footer.privacyLink` |
| `KuuNyi — Myanmar` after the year | `footer.copyright` |

Links stay in code. Add no `dangerouslySetInnerHTML`. The `<style>` block moves unchanged. In the parity comparison, `alt=""` values and photo `alt` stay as they are.

- [ ] **Step 5: Replace `src/app/page.tsx`**

```tsx
import type { Metadata } from "next";
import MarketingPage from "@/components/marketing/MarketingPage";
import { getPublishedMarketingContent } from "@/lib/marketing/published";

export async function generateMetadata(): Promise<Metadata> {
  const { seo } = await getPublishedMarketingContent();
  return {
    title: seo.title,
    description: seo.description,
    openGraph: {
      title: seo.title,
      description: seo.description,
      siteName: "KuuNyi",
      locale: "my_MM",
      type: "website",
    },
    twitter: {
      title: seo.title,
      description: seo.description,
    },
  };
}

export default async function LandingPage() {
  const content = await getPublishedMarketingContent();
  return <MarketingPage content={content} />;
}
```

- [ ] **Step 6: Run both tests**

Run: `npx vitest run src/__tests__/marketing/marketingPage.test.tsx src/__tests__/marketing/__parity.test.tsx`
Expected: PASS. A parity difference means the markup moved or a string changed. Fix the component or the default content, never the comparison. Whitespace from the POS description, which spans two lines in the old JSX, must collapse to one space in both.

- [ ] **Step 7: Delete the temporary files and commit**

```bash
rm src/__tests__/marketing/__oldPage.tsx src/__tests__/marketing/__parity.test.tsx
npx tsc --noEmit
git status --short
git diff
git add src/components/marketing/MarketingPage.tsx src/app/page.tsx src/__tests__/marketing/marketingPage.test.tsx
git commit -m "feat(marketing): render the homepage from content, with fallback to today's page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: `next/image` host for the bucket

**Files:**
- Create: `src/lib/marketing/imageHost.mjs`
- Modify: `next.config.mjs`
- Test: `src/__tests__/marketing/imageHost.test.ts`

CI's `npm run lint` has no Supabase env and `next lint` loads this config, so the check applies only when the command is `next build`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { marketingRemotePatterns } from "@/lib/marketing/imageHost.mjs";

const PATH = "/storage/v1/object/public/marketing-assets/**";

describe("marketingRemotePatterns", () => {
  it("pins protocol, host and path", () => {
    expect(marketingRemotePatterns("https://abc.supabase.co", true)).toEqual([
      { protocol: "https", hostname: "abc.supabase.co", port: "", pathname: PATH },
    ]);
  });

  it("keeps a local port", () => {
    expect(marketingRemotePatterns("http://127.0.0.1:54321", true)).toEqual([
      { protocol: "http", hostname: "127.0.0.1", port: "54321", pathname: PATH },
    ]);
  });

  it.each([undefined, "", "not a url", "ftp://abc.supabase.co"])("fails a build on %s", (v) => {
    expect(() => marketingRemotePatterns(v, true)).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it.each([undefined, "", "not a url"])("doesn't fail other commands on %s", (v) => {
    expect(marketingRemotePatterns(v, false)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/__tests__/marketing/imageHost.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `imageHost.mjs`**

```js
// Imported by next.config.mjs, so this file can't use TypeScript or path aliases.
const BUCKET_PATH = "/storage/v1/object/public/marketing-assets/**";

/**
 * next/image's allow-list for the marketing bucket. It is fixed at build time, so
 * each build allows only the host it was built with.
 *
 * @param {string | undefined} supabaseUrl
 * @param {boolean} required true for `next build`. `next lint` and `next dev` load
 *   the config too, and CI's lint step has no Supabase env.
 */
export function marketingRemotePatterns(supabaseUrl, required) {
  let url = null;
  try {
    url = supabaseUrl ? new URL(supabaseUrl) : null;
  } catch {
    url = null;
  }

  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    if (required) {
      throw new Error(
        "NEXT_PUBLIC_SUPABASE_URL is missing or invalid. next/image needs it to allow marketing images.",
      );
    }
    return [];
  }

  return [
    {
      protocol: url.protocol.replace(":", ""),
      hostname: url.hostname,
      port: url.port,
      pathname: BUCKET_PATH,
    },
  ];
}
```

- [ ] **Step 4: Update `next.config.mjs`**

At the top:

```js
import { marketingRemotePatterns } from "./src/lib/marketing/imageHost.mjs";
```

As the first property of `nextConfig`:

```js
  images: {
    remotePatterns: marketingRemotePatterns(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.argv.includes("build"),
    ),
  },
```

- [ ] **Step 5: Prove it against the real commands**

The dev server must be stopped first.

```bash
npx vitest run src/__tests__/marketing/imageHost.test.ts
env -u NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_URL= npm run lint; echo "lint exit $?"
```

Expected: tests exit 0, `lint exit 0`.

`.env.local` also supplies the variable and Next loads it, so prove the failing build case with a temporary override in the process environment:

```bash
NEXT_PUBLIC_SUPABASE_URL="not a url" npm run build; echo "build exit $?"
```

Expected: non-zero, with the message naming the variable. The process environment wins over `.env.local`. Task 13 runs the good build.

- [ ] **Step 6: Commit**

```bash
git status --short
git diff
git add src/lib/marketing/imageHost.mjs next.config.mjs src/__tests__/marketing/imageHost.test.ts
git commit -m "feat(marketing): allow the marketing bucket in next/image" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Read, save, publish and restore routes

**Files:**
- Create: the four route files listed below
- Test: `src/__tests__/api/superadmin/marketing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("@/lib/superadminAuth", () => ({ requireSuperadmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { revalidateTag } from "next/cache";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET } from "@/app/api/superadmin/marketing/route";
import { PUT } from "@/app/api/superadmin/marketing/draft/route";
import { POST as PUBLISH } from "@/app/api/superadmin/marketing/publish/route";
import { POST as RESTORE } from "@/app/api/superadmin/marketing/restore/route";
import { defaultContent } from "@/lib/marketing/defaultContent";
import { MARKETING_CACHE_TAG } from "@/lib/marketing/content";

const SUPER = "4f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c";
const BASE = "5f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c";
const ARCHIVED = "6f2b8c1e-6a4d-4e7b-9c0a-1d2e3f4a5b6c";
const NOT_CONFIGURED = { code: "PGRST205", message: "table not found" };

const req = (body: unknown, method = "POST") =>
  new Request("http://localhost/api/superadmin/marketing", {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as never;

const draftRow = (revision = 3, content: unknown = defaultContent) => ({
  id: "d1", status: "draft", content, revision, updated_at: "2026-11-02T00:00:00Z", published_at: null,
});

/** A fake table: filters are recorded and the terminal call returns what the test queued. */
function mockAdmin(opts: {
  rows?: Record<string, unknown>;
  archived?: unknown[];
  selectError?: unknown;
  update?: { data: unknown; error: unknown };
  rpc?: { data?: unknown; error: unknown };
} = {}) {
  const update = vi.fn();
  const rpc = vi.fn().mockResolvedValue(opts.rpc ?? { data: "new-id", error: null });

  const from = vi.fn(() => {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      limit: async () => ({ data: opts.archived ?? [], error: opts.selectError ?? null }),
      maybeSingle: async () => {
        if (opts.selectError) return { data: null, error: opts.selectError };
        const key = (filters.id as string) ?? (filters.status as string);
        return { data: opts.rows?.[key] ?? null, error: null };
      },
      update: (values: unknown) => {
        update(values);
        return {
          eq: () => ({
            eq: () => ({
              select: async () => opts.update ?? { data: [{ id: "d1" }], error: null },
            }),
          }),
        };
      },
    };
    return chain;
  });
  vi.mocked(createAdminClient).mockReturnValue({ from, rpc } as never);
  return { from, rpc, update };
}

const HANDLERS: [string, () => Promise<Response>][] = [
  ["GET /", () => GET()],
  ["PUT /draft", () => PUT(req({ content: defaultContent, expectedRevision: 1 }, "PUT"))],
  ["POST /publish", () => PUBLISH(req({ expectedRevision: 1 }))],
  ["POST /restore", () => RESTORE(req({ versionId: ARCHIVED, expectedRevision: 1 }))],
];

describe("marketing routes", () => {
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(requireSuperadmin).mockResolvedValue({ profile: { id: SUPER } } as never);
  });
  afterEach(() => err.mockRestore());

  describe.each(HANDLERS)("%s auth", (_name, call) => {
    it.each([
      [401, "Unauthorized"],
      [403, "Forbidden"],
    ])("returns %i and touches no data", async (status, error) => {
      vi.mocked(requireSuperadmin).mockResolvedValue({
        error: NextResponse.json({ error }, { status }),
      } as never);
      expect((await call()).status).toBe(status);
      expect(createAdminClient).not.toHaveBeenCalled();
    });
  });

  describe("GET /", () => {
    it("returns a starting draft from defaults, without writing", async () => {
      const m = mockAdmin();
      const body = await (await GET()).json();
      expect(body.draft).toMatchObject({ revision: 0, basePublishedId: null });
      expect(body.draft.content).toEqual(defaultContent);
      expect(m.update).not.toHaveBeenCalled();
      expect(m.rpc).not.toHaveBeenCalled();
    });

    it("starts from published content with its id as the base", async () => {
      const published = { ...defaultContent, seo: { ...defaultContent.seo, title: "Live" } };
      mockAdmin({ rows: { published: { id: BASE, content: published, published_at: "t" } } });
      const body = await (await GET()).json();
      expect(body.draft).toMatchObject({ revision: 0, basePublishedId: BASE });
      expect(body.draft.content.seo.title).toBe("Live");
      expect(body.published).toEqual({ id: BASE, publishedAt: "t" });
    });

    it("returns the draft row when there is one", async () => {
      mockAdmin({ rows: { draft: draftRow(3) } });
      const body = await (await GET()).json();
      expect(body.draft.revision).toBe(3);
    });

    it("flags stored content it can't edit and offers defaults", async () => {
      mockAdmin({ rows: { draft: draftRow(3, { bad: true }) } });
      const body = await (await GET()).json();
      expect(body.draft.contentInvalid).toBe(true);
      expect(body.draft.revision).toBe(3);
      expect(body.draft.content).toEqual(defaultContent);
    });

    it("returns 503 when the migration isn't applied", async () => {
      mockAdmin({ selectError: NOT_CONFIGURED });
      expect((await GET()).status).toBe(503);
    });
  });

  describe("PUT /draft", () => {
    const put = (b: unknown) => PUT(req(b, "PUT"));

    it("400s on bad JSON and a bad revision", async () => {
      mockAdmin();
      expect((await put("{")).status).toBe(400);
      expect((await put({ content: defaultContent, expectedRevision: -1 })).status).toBe(400);
      expect((await put({ content: defaultContent, expectedRevision: 1.5 })).status).toBe(400);
    });

    it("400s on a first save with no base field", async () => {
      mockAdmin();
      expect((await put({ content: defaultContent, expectedRevision: 0 })).status).toBe(400);
    });

    it("422s on invalid content and writes nothing", async () => {
      const m = mockAdmin();
      const res = await put({ content: { bad: true }, expectedRevision: 1 });
      expect(res.status).toBe(422);
      expect((await res.json()).errors.length).toBeGreaterThan(0);
      expect(m.update).not.toHaveBeenCalled();
    });

    it("first save calls the create function with the base", async () => {
      const m = mockAdmin();
      const res = await put({ content: defaultContent, expectedRevision: 0, basePublishedId: BASE });
      expect(res.status).toBe(200);
      expect((await res.json()).revision).toBe(1);
      expect(m.rpc).toHaveBeenCalledWith("create_marketing_draft", {
        p_base_published_id: BASE,
        p_content: defaultContent,
        p_user_id: SUPER,
      });
    });

    it("409s when the first save is stale", async () => {
      mockAdmin({ rpc: { error: { message: "marketing_draft_stale" } } });
      const res = await put({ content: defaultContent, expectedRevision: 0, basePublishedId: null });
      expect(res.status).toBe(409);
    });

    it("a later save raises the revision", async () => {
      const m = mockAdmin();
      const res = await put({ content: defaultContent, expectedRevision: 3 });
      expect((await res.json()).revision).toBe(4);
      expect(m.update.mock.calls[0][0]).toMatchObject({ revision: 4 });
    });

    it("409s when a later save matches no row", async () => {
      mockAdmin({ update: { data: [], error: null } });
      expect((await put({ content: defaultContent, expectedRevision: 3 })).status).toBe(409);
    });

    it("503s when the migration isn't applied", async () => {
      mockAdmin({ update: { data: null, error: NOT_CONFIGURED } });
      expect((await put({ content: defaultContent, expectedRevision: 3 })).status).toBe(503);
    });
  });

  describe("POST /publish", () => {
    const publish = (b: unknown) => PUBLISH(req(b));

    it("400s without a saved revision", async () => {
      mockAdmin();
      expect((await publish({ expectedRevision: 0 })).status).toBe(400);
    });

    it("409s when the draft isn't at that revision, and doesn't call the function", async () => {
      const m = mockAdmin({ rows: { draft: draftRow(4) } });
      expect((await publish({ expectedRevision: 3 })).status).toBe(409);
      expect(m.rpc).not.toHaveBeenCalled();
    });

    it("422s on invalid stored content", async () => {
      const m = mockAdmin({ rows: { draft: draftRow(3, { bad: true }) } });
      expect((await publish({ expectedRevision: 3 })).status).toBe(422);
      expect(m.rpc).not.toHaveBeenCalled();
    });

    it("publishes, then clears the cache", async () => {
      const m = mockAdmin({ rows: { draft: draftRow(3) } });
      expect((await publish({ expectedRevision: 3 })).status).toBe(200);
      expect(m.rpc).toHaveBeenCalledWith("publish_marketing_draft", {
        p_expected_revision: 3,
        p_user_id: SUPER,
      });
      expect(revalidateTag).toHaveBeenCalledWith(MARKETING_CACHE_TAG);
    });

    it("409s if the function rejects it, and leaves the cache alone", async () => {
      mockAdmin({ rows: { draft: draftRow(3) }, rpc: { error: { message: "marketing_draft_stale" } } });
      expect((await publish({ expectedRevision: 3 })).status).toBe(409);
      expect(revalidateTag).not.toHaveBeenCalled();
    });
  });

  describe("POST /restore", () => {
    const restore = (b: unknown) => RESTORE(req(b));
    const archived = (content: unknown = defaultContent) => ({ [ARCHIVED]: { id: ARCHIVED, status: "archived", content } });

    it("400s on a bad version id", async () => {
      mockAdmin();
      expect((await restore({ versionId: "x", expectedRevision: 1 })).status).toBe(400);
    });

    it("404s on a version that isn't archived", async () => {
      mockAdmin({ rows: { [ARCHIVED]: { id: ARCHIVED, status: "published", content: defaultContent } } });
      expect((await restore({ versionId: ARCHIVED, expectedRevision: 1 })).status).toBe(404);
    });

    it("422s on an old version that no longer validates", async () => {
      const m = mockAdmin({ rows: archived({ old: true }) });
      expect((await restore({ versionId: ARCHIVED, expectedRevision: 1 })).status).toBe(422);
      expect(m.update).not.toHaveBeenCalled();
    });

    it("copies into the draft and never publishes", async () => {
      const m = mockAdmin({ rows: archived() });
      const res = await restore({ versionId: ARCHIVED, expectedRevision: 2 });
      expect(res.status).toBe(200);
      expect((await res.json()).revision).toBe(3);
      expect(m.rpc).not.toHaveBeenCalledWith("publish_marketing_draft", expect.anything());
      expect(revalidateTag).not.toHaveBeenCalled();
    });

    it("409s on a stale revision", async () => {
      mockAdmin({ rows: archived(), update: { data: [], error: null } });
      expect((await restore({ versionId: ARCHIVED, expectedRevision: 2 })).status).toBe(409);
    });

    it("with no draft, uses the create function and the base", async () => {
      const m = mockAdmin({ rows: archived() });
      await restore({ versionId: ARCHIVED, expectedRevision: 0, basePublishedId: BASE });
      expect(m.rpc).toHaveBeenCalledWith("create_marketing_draft", expect.objectContaining({ p_base_published_id: BASE }));
    });
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/__tests__/api/superadmin/marketing.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Add the shared helpers to `store.ts`**

```ts
import { NextResponse } from "next/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const notConfigured = () =>
  NextResponse.json({ error: "Marketing isn't configured yet.", notConfigured: true }, { status: 503 });
export const stale = () =>
  NextResponse.json({ error: "Someone else changed this. Reload to get the latest version.", stale: true }, { status: 409 });
export const serverError = () => NextResponse.json({ error: "Something went wrong." }, { status: 500 });

/** Maps a failed read or write to the response the route sends. */
export function errorResponse(reason: "stale" | "not_configured" | "error") {
  if (reason === "stale") return stale();
  if (reason === "not_configured") return notConfigured();
  return serverError();
}

/** The concurrency fields shared by save and restore. Returns null if malformed. */
export function parseWriteTarget(body: Record<string, unknown>) {
  const expectedRevision = body.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0) return null;
  let basePublishedId: string | null = null;
  if (expectedRevision === 0) {
    // Required, including an explicit null: "I saw nothing published".
    if (body.basePublishedId !== null && !isUuid(body.basePublishedId)) return null;
    basePublishedId = body.basePublishedId;
  }
  return { expectedRevision, basePublishedId };
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}
```

- [ ] **Step 4: Write `src/app/api/superadmin/marketing/route.ts`**

```ts
import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { defaultContent } from "@/lib/marketing/defaultContent";
import { validateMarketingContent } from "@/lib/marketing/validate";
import { isNotConfigured, listArchived, notConfigured, readVersion, serverError } from "@/lib/marketing/store";

export const dynamic = "force-dynamic";

// Never writes. With no draft, the starting draft has revision 0 and names the
// published row it started from, which the first save must still match.
export async function GET() {
  const auth = await requireSuperadmin();
  if ("error" in auth) return auth.error;

  const admin = createAdminClient();
  const [draft, published, archived] = await Promise.all([
    readVersion(admin, "draft"),
    readVersion(admin, "published"),
    listArchived(admin),
  ]);

  const error = draft.error ?? published.error ?? archived.error;
  if (error) {
    if (isNotConfigured(error)) return notConfigured();
    console.error("[marketing] read failed:", error.code, error.message);
    return serverError();
  }

  const source = draft.row ?? published.row;
  const validated = source ? validateMarketingContent(source.content) : null;

  return NextResponse.json({
    draft: {
      content: validated?.ok ? validated.content : defaultContent,
      contentInvalid: validated ? !validated.ok : false,
      revision: draft.row?.revision ?? 0,
      basePublishedId: draft.row ? null : published.row?.id ?? null,
      updatedAt: draft.row?.updated_at ?? null,
    },
    published: published.row ? { id: published.row.id, publishedAt: published.row.published_at } : null,
    versions: archived.rows.map((v) => ({ id: v.id, publishedAt: v.published_at })),
  });
}
```

- [ ] **Step 5: Write `draft/route.ts`**

```ts
import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateMarketingContent } from "@/lib/marketing/validate";
import { errorResponse, parseWriteTarget, readJsonObject, writeDraft } from "@/lib/marketing/store";

export async function PUT(request: Request) {
  const auth = await requireSuperadmin();
  if ("error" in auth) return auth.error;

  const body = await readJsonObject(request);
  const target = body && parseWriteTarget(body);
  if (!body || !target) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const validated = validateMarketingContent(body.content);
  if (!validated.ok) {
    return NextResponse.json({ error: "Some content is invalid.", errors: validated.errors }, { status: 422 });
  }

  const result = await writeDraft(createAdminClient(), {
    content: validated.content,
    ...target,
    userId: auth.profile.id,
  });
  if (!result.ok) return errorResponse(result.reason);
  return NextResponse.json({ revision: result.revision });
}
```

- [ ] **Step 6: Write `publish/route.ts`**

```ts
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { MARKETING_CACHE_TAG } from "@/lib/marketing/content";
import { validateMarketingContent } from "@/lib/marketing/validate";
import { isNotConfigured, isStale, notConfigured, readJsonObject, readVersion, serverError, stale } from "@/lib/marketing/store";

// Every content change raises the revision, and the function rejects any other
// revision, so what gets promoted is exactly what was validated here.
export async function POST(request: Request) {
  const auth = await requireSuperadmin();
  if ("error" in auth) return auth.error;

  const body = await readJsonObject(request);
  const expectedRevision = body?.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    return NextResponse.json({ error: "Save the draft before publishing." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { row, error: readError } = await readVersion(admin, "draft");
  if (readError) {
    if (isNotConfigured(readError)) return notConfigured();
    console.error("[marketing] read failed:", readError.code, readError.message);
    return serverError();
  }
  if (!row || row.revision !== expectedRevision) return stale();

  const validated = validateMarketingContent(row.content);
  if (!validated.ok) {
    return NextResponse.json({ error: "Some content is invalid.", errors: validated.errors }, { status: 422 });
  }

  const { error } = (await admin.rpc("publish_marketing_draft", {
    p_expected_revision: expectedRevision,
    p_user_id: auth.profile.id,
  } as never)) as { error: { code?: string; message?: string } | null };
  if (error) {
    if (isStale(error)) return stale();
    if (isNotConfigured(error)) return notConfigured();
    console.error("[marketing] publish failed:", error.code, error.message);
    return serverError();
  }

  revalidateTag(MARKETING_CACHE_TAG);
  return NextResponse.json({ published: true });
}
```

- [ ] **Step 7: Write `restore/route.ts`**

```ts
import { NextResponse } from "next/server";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateMarketingContent } from "@/lib/marketing/validate";
import {
  errorResponse, isNotConfigured, isUuid, notConfigured, parseWriteTarget, readJsonObject, serverError, writeDraft,
} from "@/lib/marketing/store";
import type { MarketingPageVersion } from "@/types/database";

// Copies an archived version into the draft. It never publishes: a restore goes
// through preview and publish like any other edit.
export async function POST(request: Request) {
  const auth = await requireSuperadmin();
  if ("error" in auth) return auth.error;

  const body = await readJsonObject(request);
  const target = body && parseWriteTarget(body);
  if (!body || !target || !isUuid(body.versionId)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: version, error } = (await admin
    .from("marketing_page_versions")
    .select("id, status, content")
    .eq("id", body.versionId)
    .maybeSingle()) as {
    data: Pick<MarketingPageVersion, "id" | "status" | "content"> | null;
    error: { code?: string; message?: string } | null;
  };
  if (error) {
    if (isNotConfigured(error)) return notConfigured();
    console.error("[marketing] read failed:", error.code, error.message);
    return serverError();
  }
  if (!version || version.status !== "archived") {
    return NextResponse.json({ error: "Version not found." }, { status: 404 });
  }

  const validated = validateMarketingContent(version.content);
  if (!validated.ok) {
    return NextResponse.json({ error: "This version can't be restored.", errors: validated.errors }, { status: 422 });
  }

  const result = await writeDraft(admin, { content: validated.content, ...target, userId: auth.profile.id });
  if (!result.ok) return errorResponse(result.reason);
  return NextResponse.json({ revision: result.revision, content: validated.content });
}
```

- [ ] **Step 8: Run and commit**

```bash
npx vitest run src/__tests__/api/superadmin/marketing.test.ts
npx tsc --noEmit
git status --short
git diff
git add src/lib/marketing/store.ts src/app/api/superadmin/marketing src/__tests__/api/superadmin/marketing.test.ts
git commit -m "feat(marketing): superadmin routes to read, save, publish and restore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: exit 0 on both.

---

## Task 9: Image upload

**Files:**
- Create: `src/lib/marketing/imageBytes.ts`, `src/app/api/superadmin/marketing/upload/route.ts`
- Test: `src/__tests__/marketing/imageBytes.test.ts`, `src/__tests__/api/superadmin/marketingUpload.test.ts`

- [ ] **Step 1: Write the failing parser test**

```ts
import { describe, it, expect } from "vitest";
import { detectImage } from "@/lib/marketing/imageBytes";

const png = (w: number, h: number) => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

// SOI, an APP0 segment to skip, then SOF2 (progressive).
const jpeg = (w: number, h: number) =>
  new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc2, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255,
  ]);

const riff = (fourcc: string, payload: number[]) =>
  new Uint8Array([
    ..."RIFF".split("").map((c) => c.charCodeAt(0)),
    0, 0, 0, 0,
    ..."WEBP".split("").map((c) => c.charCodeAt(0)),
    ...fourcc.split("").map((c) => c.charCodeAt(0)),
    0, 0, 0, 0,
    ...payload,
  ]);

describe("detectImage", () => {
  it("reads PNG", () => {
    expect(detectImage(png(640, 480))).toEqual({ mime: "image/png", ext: "png", width: 640, height: 480 });
  });

  it("reads JPEG past leading segments", () => {
    expect(detectImage(jpeg(1200, 800))).toEqual({ mime: "image/jpeg", ext: "jpg", width: 1200, height: 800 });
  });

  it("reads lossy WebP", () => {
    // 3-byte frame tag, 9d 01 2a, then 14-bit width and height.
    const bytes = riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]);
    expect(detectImage(bytes)).toEqual({ mime: "image/webp", ext: "webp", width: 640, height: 480 });
  });

  it("reads lossless WebP", () => {
    // Signature 0x2f, then width-1 and height-1 in 14 bits each: 640x480.
    const bits = 639 | (479 << 14);
    const bytes = riff("VP8L", [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >> 24) & 255]);
    expect(detectImage(bytes)).toEqual({ mime: "image/webp", ext: "webp", width: 640, height: 480 });
  });

  it("reads extended WebP", () => {
    // Flags and reserved (4 bytes), then 24-bit width-1 and height-1.
    const bytes = riff("VP8X", [0, 0, 0, 0, 0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]);
    expect(detectImage(bytes)).toEqual({ mime: "image/webp", ext: "webp", width: 640, height: 480 });
  });

  it.each([
    ["SVG", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["GIF", new TextEncoder().encode("GIF89a........")],
    ["HTML", new TextEncoder().encode("<!doctype html><script>")],
    ["empty", new Uint8Array()],
    ["truncated PNG", png(1, 1).slice(0, 12)],
    ["truncated JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0xc0])],
    ["zero-size PNG", png(0, 10)],
  ])("rejects %s", (_name, bytes) => {
    expect(detectImage(bytes)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/__tests__/marketing/imageBytes.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `imageBytes.ts`**

```ts
// ─── Image type and size, from the file's own bytes ──────────────────────────
// The declared type and filename are never trusted. SVG isn't recognised on
// purpose: it can carry scripts.

export type DetectedImage = {
  mime: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
  width: number;
  height: number;
};

const ascii = (b: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...b.subarray(offset, offset + length));

function detectPng(b: Uint8Array, view: DataView): DetectedImage | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !signature.every((v, i) => b[i] === v) || ascii(b, 12, 4) !== "IHDR") return null;
  return { mime: "image/png", ext: "png", width: view.getUint32(16), height: view.getUint32(20) };
}

function detectJpeg(b: Uint8Array, view: DataView): DetectedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // SOF0-15, except DHT (C4), JPG (C8) and DAC (CC), carry the dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { mime: "image/jpeg", ext: "jpg", height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    }
    const length = view.getUint16(i + 2);
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function detectWebp(b: Uint8Array, view: DataView): DetectedImage | null {
  if (b.length < 25 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const base = { mime: "image/webp", ext: "webp" } as const;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { ...base, width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = view.getUint32(21, true);
    return { ...base, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    if (b.length < 30) return null;
    const u24 = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    return { ...base, width: u24(24) + 1, height: u24(27) + 1 };
  }
  return null;
}

export function detectImage(bytes: Uint8Array): DetectedImage | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = detectPng(bytes, view) ?? detectJpeg(bytes, view) ?? detectWebp(bytes, view);
  return found && found.width > 0 && found.height > 0 ? found : null;
}
```

- [ ] **Step 4: Write the failing route test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/superadminAuth", () => ({ requireSuperadmin: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { POST } from "@/app/api/superadmin/marketing/upload/route";
import { validateMarketingContent } from "@/lib/marketing/validate";
import { defaultContent } from "@/lib/marketing/defaultContent";

const MB = 1024 * 1024;

const pngBytes = (w = 100, h = 50, size = 24) => {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

function form(files: { bytes: Uint8Array; name?: string; type?: string }[], headers: Record<string, string> = {}) {
  const fd = new FormData();
  for (const f of files) fd.append("file", new File([f.bytes], f.name ?? "logo.png", { type: f.type ?? "image/png" }));
  return new Request("http://localhost/api/superadmin/marketing/upload", { method: "POST", body: fd, headers }) as never;
}

function mockStorage(result: { error: unknown } = { error: null }) {
  const upload = vi.fn().mockResolvedValue(result);
  const from = vi.fn().mockReturnValue({ upload });
  vi.mocked(createAdminClient).mockReturnValue({ storage: { from } } as never);
  return { upload, from };
}

describe("POST /api/superadmin/marketing/upload", () => {
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(requireSuperadmin).mockResolvedValue({ profile: { id: "s" } } as never);
  });
  afterEach(() => err.mockRestore());

  it.each([
    [401, "Unauthorized"],
    [403, "Forbidden"],
  ])("returns %i and touches no data", async (status, error) => {
    vi.mocked(requireSuperadmin).mockResolvedValue({ error: NextResponse.json({ error }, { status }) } as never);
    expect((await POST(form([{ bytes: pngBytes() }]))).status).toBe(status);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("413s on a declared body over the ceiling, before parsing", async () => {
    const m = mockStorage();
    const req = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-length": String(Math.ceil(4.25 * MB) + 1) },
      body: "x",
    });
    const spy = vi.spyOn(req, "formData");
    expect((await POST(req as never)).status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("accepts exactly 4 MB, and 413s one byte over even with no usable header", async () => {
    const m = mockStorage();
    expect((await POST(form([{ bytes: pngBytes(100, 50, 4 * MB) }]))).status).toBe(200);
    m.upload.mockClear();
    expect((await POST(form([{ bytes: pngBytes(100, 50, 4 * MB + 1) }]))).status).toBe(413);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("400s on no file and on more than one", async () => {
    const m = mockStorage();
    expect((await POST(form([]))).status).toBe(400);
    expect((await POST(form([{ bytes: pngBytes() }, { bytes: pngBytes() }]))).status).toBe(400);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("rejects SVG even when declared as PNG", async () => {
    const m = mockStorage();
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect((await POST(form([{ bytes, name: "x.png", type: "image/png" }]))).status).toBe(415);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("rejects images over 6000 px", async () => {
    const m = mockStorage();
    expect((await POST(form([{ bytes: pngBytes(6001, 10) }]))).status).toBe(422);
    expect(m.upload).not.toHaveBeenCalled();
  });

  it("picks the path and type itself and never overwrites", async () => {
    const m = mockStorage();
    const res = await POST(form([{ bytes: pngBytes(100, 50), name: "../../evil.svg", type: "image/svg+xml" }]));
    expect(res.status).toBe(200);
    const { image } = await res.json();
    expect(image).toMatchObject({ kind: "bucket", width: 100, height: 50 });
    expect(image.path).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(m.from).toHaveBeenCalledWith("marketing-assets");
    const [path, , options] = m.upload.mock.calls[0];
    expect(path).toBe(image.path);
    expect(options).toMatchObject({ contentType: "image/png", upsert: false });
  });

  it("returns an image reference the validator accepts", async () => {
    mockStorage();
    const { image } = await (await POST(form([{ bytes: pngBytes() }]))).json();
    const c = { ...defaultContent, hero: { ...defaultContent.hero, image } };
    expect(validateMarketingContent(c).ok).toBe(true);
  });

  it.each([
    [{ message: "Bucket not found" }],
    [{ message: "not found", statusCode: "NoSuchBucket" }],
  ])("503s when the bucket doesn't exist: %j", async (error) => {
    mockStorage({ error });
    expect((await POST(form([{ bytes: pngBytes() }]))).status).toBe(503);
  });
});
```

- [ ] **Step 5: Write the route**

```ts
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { STORAGE_CACHE_CONTROL } from "@/lib/storage/cache";
import { MARKETING_BUCKET, type ImageRef } from "@/lib/marketing/content";
import { detectImage } from "@/lib/marketing/imageBytes";
import { isNotConfigured, notConfigured, serverError } from "@/lib/marketing/store";

// Vercel caps request bodies at about 4.5 MB. Past that the caller gets a platform
// error, so the limit stays under it. Content-Length counts the whole multipart
// body, hence the separate ceiling, and it can be missing or wrong, hence the exact
// check on the parsed file.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 4.25 * 1024 * 1024;
const MAX_SIDE = 6000;

const tooLarge = () => NextResponse.json({ error: "Images can be up to 4 MB." }, { status: 413 });

export async function POST(request: Request) {
  const auth = await requireSuperadmin();
  if ("error" in auth) return auth.error;

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooLarge();

  const form = await request.formData().catch(() => null);
  const files = form?.getAll("file") ?? [];
  const file = files[0];
  if (files.length !== 1 || !(file instanceof File)) {
    return NextResponse.json({ error: "Send one image file." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) return tooLarge();

  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = detectImage(bytes);
  if (!detected) {
    return NextResponse.json({ error: "Use a JPEG, PNG or WebP image." }, { status: 415 });
  }
  if (detected.width > MAX_SIDE || detected.height > MAX_SIDE) {
    return NextResponse.json({ error: `Images can be up to ${MAX_SIDE} px on a side.` }, { status: 422 });
  }

  // A new path per upload keeps older published versions working.
  const path = `${randomUUID()}.${detected.ext}`;
  const { error } = await createAdminClient()
    .storage.from(MARKETING_BUCKET)
    .upload(path, bytes, {
      contentType: detected.mime,
      cacheControl: STORAGE_CACHE_CONTROL,
      upsert: false,
    });
  if (error) {
    if (isNotConfigured(error)) return notConfigured();
    console.error("[marketing] upload failed:", error.message);
    return serverError();
  }

  const image: ImageRef = { kind: "bucket", path, width: detected.width, height: detected.height };
  return NextResponse.json({ image });
}
```

Task 1 must keep `MARKETING_BUCKET` as a `const` with the name `MARKETING_BUCKET = "marketing-assets"`: `storage-buckets.test.ts` finds it by that pattern, and it must also find the bucket in the migration.

- [ ] **Step 6: Run and commit**

```bash
npx vitest run src/__tests__/marketing/imageBytes.test.ts src/__tests__/api/superadmin/marketingUpload.test.ts src/__tests__/migrations/storage-buckets.test.ts
npx tsc --noEmit
git status --short
git diff
git add src/lib/marketing/imageBytes.ts src/app/api/superadmin/marketing/upload src/__tests__/marketing/imageBytes.test.ts src/__tests__/api/superadmin/marketingUpload.test.ts
git commit -m "feat(marketing): hardened image upload to the marketing bucket" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: exit 0 on both.

---

## Task 10: Editor helpers

**Files:**
- Create: `src/lib/marketing/editorOps.ts`, `src/lib/marketing/textFields.ts`
- Test: `src/__tests__/marketing/editorOps.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { getAt, setAt, moveItem, removeAt } from "@/lib/marketing/editorOps";
import { textGroups } from "@/lib/marketing/textFields";
import { defaultContent } from "@/lib/marketing/defaultContent";

describe("editorOps", () => {
  it("reads and writes nested paths without mutating", () => {
    const before = { a: { b: [{ c: 1 }, { c: 2 }] } };
    const after = setAt(before, "a.b.1.c", 9);
    expect(getAt(after, "a.b.1.c")).toBe(9);
    expect(before.a.b[1].c).toBe(2);
    expect(Array.isArray((after as typeof before).a.b)).toBe(true);
    expect((after as typeof before).a.b[0]).toBe(before.a.b[0]);
  });

  it("moves within bounds and ignores moves past the ends", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  it("removes by index", () => {
    expect(removeAt(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });
});

describe("textGroups", () => {
  it("every field points at text in the content", () => {
    for (const group of textGroups(defaultContent)) {
      for (const field of group.fields) {
        if (field.localized) {
          expect(typeof getAt(defaultContent, `${field.path}.en`), field.path).toBe("string");
          expect(typeof getAt(defaultContent, `${field.path}.mm`), field.path).toBe("string");
        } else {
          expect(typeof getAt(defaultContent, field.path), field.path).toBe("string");
        }
      }
    }
  });

  it("covers every text value in the content, except organizer and payment names", () => {
    const covered = new Set<string>();
    for (const g of textGroups(defaultContent)) {
      for (const f of g.fields) {
        if (f.localized) {
          covered.add(`${f.path}.en`);
          covered.add(`${f.path}.mm`);
        } else {
          covered.add(f.path);
        }
      }
    }
    const walk = (v: unknown, path: string, out: string[]) => {
      if (typeof v === "string") out.push(path);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`, out));
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, out);
      }
      return out;
    };
    const missing = walk(defaultContent, "", []).filter(
      (p) =>
        !covered.has(p) &&
        !/\.(image|images)(\.|$)/.test(p) &&
        !/\.id$/.test(p) &&
        !/^seo\./.test(p) && // Sections & SEO tab
        !/^organizers\.items\.\d+\.name$/.test(p) && // Partner logos tab
        !/^payments\.items\.\d+\.name$/.test(p), // Accepted payments tab
    );
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/__tests__/marketing/editorOps.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `editorOps.ts`**

```ts
// Pure helpers for the editor. Paths are dotted, with numeric segments for lists.

export function getAt(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], root);
}

/** Returns a copy with `path` set. Untouched branches keep their identity. */
export function setAt<T>(root: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const next = rest.length ? setAt((root as Record<string, unknown>)[head], rest.join("."), value) : value;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[Number(head)] = next;
    return copy as T;
  }
  return { ...(root as object), [head]: next } as T;
}

export function moveItem<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const copy = [...items];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}

export const removeAt = <T,>(items: T[], index: number): T[] => items.filter((_, i) => i !== index);
```

- [ ] **Step 4: Write `textFields.ts`**

```ts
import type { MarketingContent } from "./content";

export type TextField = {
  label: string;
  path: string;
  /** Edits `${path}.en` and `${path}.mm` side by side. */
  localized?: boolean;
  multiline?: boolean;
  /** Path of this item's `hidden` flag, when the item can be hidden here. */
  hiddenPath?: string;
};
export type TextGroup = { title: string; fields: TextField[] };

const f = (label: string, path: string, opts: Partial<TextField> = {}): TextField => ({ label, path, ...opts });
const loc = (label: string, path: string, opts: Partial<TextField> = {}) => f(label, path, { localized: true, ...opts });
const long = { multiline: true };

export function textGroups(c: MarketingContent): TextGroup[] {
  return [
    {
      title: "Hero",
      fields: [
        f("Sign-in button", "hero.signIn"),
        f("Get-started button", "hero.getStarted"),
        f("Eyebrow", "hero.eyebrow"),
        loc("Headline", "hero.headline"),
        f("Subtext", "hero.subtext", long),
        f("Main button", "hero.primaryCta"),
        f("Second button", "hero.secondaryCta"),
        loc("Trust line", "hero.trust", long),
      ],
    },
    {
      title: "Trusted by",
      fields: [loc("Heading", "organizers.heading"), f("Intro", "organizers.intro", long)],
    },
    { title: "Accepted payments", fields: [loc("Heading", "payments.heading")] },
    {
      title: "Solutions",
      fields: [
        f("Eyebrow", "solutions.eyebrow"),
        loc("Heading", "solutions.heading"),
        f("Intro", "solutions.intro", long),
        ...c.solutions.items.flatMap((item, i) => {
          const p = `solutions.items.${i}`;
          return [
            f(`Card ${i + 1}: label`, `${p}.label`, { hiddenPath: `${p}.hidden` }),
            loc(`Card ${i + 1}: title`, `${p}.title`),
            f(`Card ${i + 1}: description`, `${p}.description`, long),
          ];
        }),
      ],
    },
    {
      title: "Cashless bars & food stalls",
      fields: [
        f("Eyebrow", "pos.eyebrow"),
        loc("Title", "pos.title"),
        f("Description", "pos.description", long),
        ...c.pos.bullets.map((_, i) => f(`Bullet ${i + 1}`, `pos.bullets.${i}`)),
      ],
    },
    {
      title: "How it works",
      fields: [
        loc("Heading", "howItWorks.heading"),
        f("Intro", "howItWorks.intro", long),
        ...c.howItWorks.steps.map((_, i) =>
          loc(`Step ${i + 1}`, `howItWorks.steps.${i}.title`, { hiddenPath: `howItWorks.steps.${i}.hidden` }),
        ),
      ],
    },
    {
      title: "Industries",
      fields: [
        loc("Heading", "industries.heading"),
        f("Intro", "industries.intro", long),
        ...c.industries.items.map((_, i) =>
          loc(`Card ${i + 1}`, `industries.items.${i}.name`, { hiddenPath: `industries.items.${i}.hidden` }),
        ),
      ],
    },
    {
      title: "Call to action",
      fields: [
        loc("Heading", "cta.heading"),
        f("Intro", "cta.intro", long),
        f("Main button", "cta.primary"),
        f("Second button", "cta.secondary"),
      ],
    },
    {
      title: "Footer",
      fields: [
        f("Tagline", "footer.tagline", long),
        f("Product heading", "footer.productHeading"),
        f("How-it-works link", "footer.howItWorksLink"),
        f("Organisers heading", "footer.organisersHeading"),
        f("Get-started link", "footer.getStartedLink"),
        f("Sign-in link", "footer.signInLink"),
        f("Legal heading", "footer.legalHeading"),
        f("Privacy link", "footer.privacyLink"),
        f("Copyright", "footer.copyright"),
      ],
    },
  ];
}

/** Every replaceable photo, for the Images tab. Partner and payment logos have their own tabs. */
export function imageSlots(c: MarketingContent): { label: string; path: string; canClear?: boolean }[] {
  return [
    { label: "Hero", path: "hero.image" },
    ...c.solutions.items.map((item, i) => ({
      label: `Solution: ${item.label}`,
      path: `solutions.items.${i}.image`,
      canClear: true,
    })),
    { label: "Cashless bars & food stalls", path: "pos.image" },
    { label: "How it works background", path: "howItWorks.image" },
    ...c.industries.items.map((item, i) => ({ label: `Industry: ${item.name.en}`, path: `industries.items.${i}.image` })),
    { label: "Call to action background", path: "cta.image" },
  ];
}
```

- [ ] **Step 5: Run and commit**

```bash
npx vitest run src/__tests__/marketing/editorOps.test.ts
git status --short
git diff
git add src/lib/marketing/editorOps.ts src/lib/marketing/textFields.ts src/__tests__/marketing/editorOps.test.ts
git commit -m "feat(marketing): editor path helpers and text field catalogue" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Editor UI

**Files:**
- Create: `src/components/marketing/editor/fields.tsx`, `tabs.tsx`, `MarketingEditor.tsx`, `src/app/superadmin/marketing/page.tsx`
- Modify: `src/app/superadmin/page.tsx`

The logic is covered by Tasks 8 to 10. This UI is verified in the browser in Task 13.

- [ ] **Step 1: Write `fields.tsx`**

```tsx
"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { marketingImageSrc, type ImageRef } from "@/lib/marketing/content";

export const inputClass =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6d28d9]/40";
export const buttonClass =
  "rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40";

export function TextInput({
  label, value, onChange, multiline, myanmar,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  myanmar?: boolean;
}) {
  const cls = `${inputClass} ${myanmar ? "font-myanmar" : ""}`;
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-500">{label}</span>
      {multiline ? (
        <textarea className={cls} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={cls} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

export function Thumb({ image, alt }: { image: ImageRef; alt: string }) {
  return (
    <Image
      src={marketingImageSrc(image)}
      alt={alt}
      width={image.width}
      height={image.height}
      unoptimized
      className="h-16 w-24 rounded-lg border border-gray-200 bg-white object-contain"
    />
  );
}

export async function uploadMarketingImage(file: File): Promise<ImageRef> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/superadmin/marketing/upload", { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Upload failed.");
  return data.image;
}

/** A button that uploads one image and hands back its reference. */
export function UploadButton({ label, onUploaded }: { label: string; onUploaded: (image: ImageRef) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onUploaded(await uploadMarketingImage(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      <button type="button" className={buttonClass} disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Uploading…" : label}
      </button>
      {error && <span role="alert" className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

export function RowActions({
  index, count, hidden, onMove, onToggleHidden, onRemove,
}: {
  index: number;
  count: number;
  hidden: boolean;
  onMove: (delta: -1 | 1) => void;
  onToggleHidden: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" className={buttonClass} disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">↑</button>
      <button type="button" className={buttonClass} disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move down">↓</button>
      <button type="button" className={buttonClass} onClick={onToggleHidden}>{hidden ? "Show" : "Hide"}</button>
      <button type="button" className={buttonClass} onClick={onRemove}>Remove</button>
    </div>
  );
}
```

- [ ] **Step 2: Write `tabs.tsx`**

```tsx
"use client";

import { useState } from "react";
import { SECTION_KEYS, type ImageRef, type MarketingContent, type SectionKey } from "@/lib/marketing/content";
import { getAt, moveItem, removeAt, setAt } from "@/lib/marketing/editorOps";
import { imageSlots, textGroups } from "@/lib/marketing/textFields";
import { buttonClass, inputClass, RowActions, TextInput, Thumb, UploadButton } from "./fields";

export type TabProps = { content: MarketingContent; onChange: (next: MarketingContent) => void };

const SECTION_LABELS: Record<SectionKey, string> = {
  organizers: "Trusted by",
  payments: "Accepted payments",
  solutions: "Solutions cards",
  pos: "Cashless bars & food stalls",
  howItWorks: "How it works",
  industries: "Industries",
  cta: "Call to action",
};

const newId = () => crypto.randomUUID();

export function TextsTab({ content, onChange }: TabProps) {
  const text = (path: string) => getAt(content, path) as string;
  const set = (path: string) => (v: string) => onChange(setAt(content, path, v));

  return (
    <div className="space-y-6">
      {textGroups(content).map((group) => (
        <section key={group.title} className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="mb-4 text-sm font-bold text-gray-900">{group.title}</h3>
          <div className="space-y-4">
            {group.fields.map((field) => (
              <div key={field.path}>
                {field.localized ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <TextInput label={`${field.label} (English)`} value={text(`${field.path}.en`)} onChange={set(`${field.path}.en`)} multiline={field.multiline} />
                    <TextInput label={`${field.label} (Myanmar)`} value={text(`${field.path}.mm`)} onChange={set(`${field.path}.mm`)} multiline={field.multiline} myanmar />
                  </div>
                ) : (
                  <TextInput label={field.label} value={text(field.path)} onChange={set(field.path)} multiline={field.multiline} />
                )}
                {field.hiddenPath && (
                  <label className="mt-2 inline-flex items-center gap-2 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={getAt(content, field.hiddenPath) as boolean}
                      onChange={(e) => onChange(setAt(content, field.hiddenPath!, e.target.checked))}
                    />
                    Hide this item
                  </label>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function LogosTab({ content, onChange }: TabProps) {
  const items = content.organizers.items;
  const setItems = (next: typeof items) => onChange(setAt(content, "organizers.items", next));
  const [name, setName] = useState("");

  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={item.id} className={`flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 bg-white p-4 ${item.hidden ? "opacity-60" : ""}`}>
          <Thumb image={item.image} alt={item.name} />
          <div className="min-w-[200px] flex-1">
            <TextInput label="Name" value={item.name} onChange={(v) => setItems(setAt(items, `${i}.name`, v))} />
          </div>
          <UploadButton label="Replace logo" onUploaded={(image) => setItems(setAt(items, `${i}.image`, image))} />
          <RowActions
            index={i}
            count={items.length}
            hidden={item.hidden}
            onMove={(d) => setItems(moveItem(items, i, d))}
            onToggleHidden={() => setItems(setAt(items, `${i}.hidden`, !item.hidden))}
            onRemove={() => setItems(removeAt(items, i))}
          />
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-gray-300 bg-white p-4">
        <div className="min-w-[200px] flex-1">
          <TextInput label="New partner name" value={name} onChange={setName} />
        </div>
        {name.trim() ? (
          <UploadButton
            label="Upload logo and add"
            onUploaded={(image: ImageRef) => {
              setItems([...items, { id: newId(), name: name.trim(), image, hidden: false }]);
              setName("");
            }}
          />
        ) : (
          <button type="button" className={buttonClass} disabled>Upload logo and add</button>
        )}
      </div>
    </div>
  );
}

export function ImagesTab({ content, onChange }: TabProps) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {imageSlots(content).map((slot) => {
        const image = getAt(content, slot.path) as ImageRef | null;
        return (
          <div key={slot.path} className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-4">
            {image ? (
              <Thumb image={image} alt={slot.label} />
            ) : (
              <span className="flex h-16 w-24 items-center justify-center rounded-lg bg-gray-100 p-1 text-center text-xs text-gray-500">
                Payment logos
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="mb-2 truncate text-sm font-medium text-gray-800">{slot.label}</p>
              <div className="flex flex-wrap gap-2">
                <UploadButton label="Replace" onUploaded={(next) => onChange(setAt(content, slot.path, next))} />
                {slot.canClear && image && (
                  <button type="button" className={buttonClass} onClick={() => onChange(setAt(content, slot.path, null))}>
                    Use payment logos
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PaymentsTab({ content, onChange }: TabProps) {
  const items = content.payments.items;
  const setItems = (next: typeof items) => onChange(setAt(content, "payments.items", next));
  const [name, setName] = useState("");

  return (
    <div className="space-y-3">
      {items.some((p) => p.hidden) && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Hiding a payment doesn&apos;t change the wording. Check the Texts tab for lines that still mention it, such as
          the step &quot;Pays with KBZPay, MMQR or card&quot;.
        </p>
      )}
      {items.map((item, i) => (
        <div key={item.id} className={`rounded-xl border border-gray-200 bg-white p-4 ${item.hidden ? "opacity-60" : ""}`}>
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-[200px] flex-1">
              <TextInput label="Name" value={item.name} onChange={(v) => setItems(setAt(items, `${i}.name`, v))} />
            </div>
            <RowActions
              index={i}
              count={items.length}
              hidden={item.hidden}
              onMove={(d) => setItems(moveItem(items, i, d))}
              onToggleHidden={() => setItems(setAt(items, `${i}.hidden`, !item.hidden))}
              onRemove={() => setItems(removeAt(items, i))}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {item.images.map((image, j) => (
              <span key={`${image.path}-${j}`} className="inline-flex items-center gap-1.5">
                <Thumb image={image} alt={j === 0 ? item.name : ""} />
                <button
                  type="button"
                  className={buttonClass}
                  disabled={item.images.length === 1}
                  onClick={() => setItems(setAt(items, `${i}.images`, removeAt(item.images, j)))}
                  aria-label={`Remove image ${j + 1} of ${item.name}`}
                >
                  ×
                </button>
              </span>
            ))}
            {item.images.length < 4 && (
              <UploadButton label="Add image" onUploaded={(image) => setItems(setAt(items, `${i}.images`, [...item.images, image]))} />
            )}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-dashed border-gray-300 bg-white p-4">
        <div className="min-w-[200px] flex-1">
          <TextInput label="New payment name" value={name} onChange={setName} />
        </div>
        {name.trim() ? (
          <UploadButton
            label="Upload logo and add"
            onUploaded={(image) => {
              setItems([...items, { id: newId(), name: name.trim(), images: [image], hidden: false }]);
              setName("");
            }}
          />
        ) : (
          <button type="button" className={buttonClass} disabled>Upload logo and add</button>
        )}
      </div>
    </div>
  );
}

export function SectionsSeoTab({ content, onChange }: TabProps) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="mb-3 text-sm font-bold text-gray-900">Show on the page</h3>
        <div className="space-y-2">
          {SECTION_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={content.sections[key]}
                onChange={(e) => onChange(setAt(content, `sections.${key}`, e.target.checked))}
              />
              {SECTION_LABELS[key]}
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs text-gray-500">The hero and footer always show.</p>
      </section>
      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-bold text-gray-900">Search and sharing</h3>
        <TextInput label="Page title" value={content.seo.title} onChange={(v) => onChange(setAt(content, "seo.title", v))} />
        <TextInput label="Description" value={content.seo.description} multiline onChange={(v) => onChange(setAt(content, "seo.description", v))} />
      </section>
    </div>
  );
}

export function RestorePanel({
  versions, disabled, onRestore,
}: {
  versions: { id: string; publishedAt: string | null }[];
  disabled: boolean;
  onRestore: (id: string) => void;
}) {
  const [selected, setSelected] = useState("");
  if (!versions.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className={`${inputClass} w-auto`} value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Previous version">
        <option value="">Previous versions…</option>
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            {v.publishedAt ? new Date(v.publishedAt).toLocaleString() : v.id}
          </option>
        ))}
      </select>
      <button type="button" className={buttonClass} disabled={disabled || !selected} onClick={() => onRestore(selected)}>
        Restore to draft
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Write `MarketingEditor.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import LoadingSpinner from "@/components/ui/LoadingSpinner";
import type { MarketingContent } from "@/lib/marketing/content";
import { buttonClass } from "./fields";
import { ImagesTab, LogosTab, PaymentsTab, RestorePanel, SectionsSeoTab, TextsTab } from "./tabs";

const API = "/api/superadmin/marketing";

const TABS = [
  ["texts", "Texts", TextsTab],
  ["logos", "Partner logos", LogosTab],
  ["images", "Images", ImagesTab],
  ["payments", "Accepted payments", PaymentsTab],
  ["sections", "Sections & SEO", SectionsSeoTab],
] as const;

type Loaded = {
  content: MarketingContent;
  revision: number;
  basePublishedId: string | null;
  publishedAt: string | null;
  versions: { id: string; publishedAt: string | null }[];
};
type Notice = { kind: "ok" | "error"; text: string; errors?: string[]; stale?: boolean };

export default function MarketingEditor() {
  const [state, setState] = useState<Loaded | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("texts");

  const load = useCallback(async () => {
    setLoadFailed(false);
    const res = await fetch(API, { cache: "no-store" }).catch(() => null);
    if (res?.status === 503) return setNotConfigured(true);
    if (!res?.ok) return setLoadFailed(true);
    const data = await res.json();
    setState({
      content: data.draft.content,
      revision: data.draft.revision,
      basePublishedId: data.draft.basePublishedId,
      publishedAt: data.published?.publishedAt ?? null,
      versions: data.versions,
    });
    setDirty(false);
    if (data.draft.contentInvalid) {
      setNotice({ kind: "error", text: "The saved content couldn't be read, so this shows the default page. Saving replaces it." });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function send(path: string, method: string, body: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ kind: "error", text: data.error ?? "Something went wrong.", errors: data.errors, stale: res.status === 409 });
        return null;
      }
      return data;
    } catch {
      setNotice({ kind: "error", text: "Couldn't reach the server. Nothing was changed." });
      return null;
    } finally {
      setBusy(false);
    }
  }

  const target = () =>
    state!.revision === 0
      ? { expectedRevision: 0, basePublishedId: state!.basePublishedId }
      : { expectedRevision: state!.revision };

  async function save() {
    const data = await send("/draft", "PUT", { content: state!.content, ...target() });
    if (!data) return;
    setState({ ...state!, revision: data.revision as number, basePublishedId: null });
    setDirty(false);
    setNotice({ kind: "ok", text: "Draft saved." });
  }

  async function publish() {
    if (!window.confirm("Publish this draft to the live homepage?")) return;
    const data = await send("/publish", "POST", { expectedRevision: state!.revision });
    if (!data) return;
    await load();
    setNotice({ kind: "ok", text: "Published." });
  }

  async function restore(versionId: string) {
    const data = await send("/restore", "POST", { versionId, ...target() });
    if (!data) return;
    setState({ ...state!, content: data.content as MarketingContent, revision: data.revision as number, basePublishedId: null });
    setDirty(false);
    setNotice({ kind: "ok", text: "Restored to the draft. Preview it, then publish when ready." });
  }

  if (notConfigured) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center text-sm text-gray-600">
        Marketing isn&apos;t configured yet: the database migration hasn&apos;t been applied in this environment. The public
        page is showing its default content.
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center text-sm text-gray-600">
        <p>Couldn&apos;t load the marketing content.</p>
        <button type="button" className={`${buttonClass} mt-4`} onClick={load}>Try again</button>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex h-96 items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  const Active = TABS.find(([key]) => key === tab)![2];
  const saved = state.revision > 0 && !dirty;

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Marketing page</h2>
          <p className="text-sm text-gray-500">
            {dirty ? "Unsaved changes" : state.revision > 0 ? "Draft saved, not published" : "No draft yet"}
            {" · "}
            {state.publishedAt ? `Published ${new Date(state.publishedAt).toLocaleString()}` : "Showing default content"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RestorePanel versions={state.versions} disabled={busy || dirty} onRestore={restore} />
          <button type="button" className={buttonClass} disabled={busy || !dirty} onClick={save}>Save draft</button>
          {saved ? (
            <a href="/superadmin/marketing/preview" target="_blank" rel="noopener" className={buttonClass}>Preview</a>
          ) : (
            <button type="button" className={buttonClass} disabled title="Save the draft first">Preview</button>
          )}
          <button
            type="button"
            className="rounded-lg bg-[#6d28d9] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#5b21b6] disabled:opacity-40"
            disabled={busy || !saved}
            title={saved ? undefined : "Save the draft first"}
            onClick={publish}
          >
            Publish
          </button>
        </div>
      </header>

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={`rounded-lg px-4 py-3 text-sm ${notice.kind === "error" ? "border border-red-200 bg-red-50 text-red-800" : "border border-green-200 bg-green-50 text-green-800"}`}
        >
          <p>{notice.text}</p>
          {notice.errors && (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {notice.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          {notice.stale && (
            <button type="button" className={`${buttonClass} mt-2`} onClick={() => { setNotice(null); load(); }}>
              Reload (discards your unsaved changes)
            </button>
          )}
        </div>
      )}

      <nav role="tablist" className="flex flex-wrap gap-1 border-b border-gray-200">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium ${tab === key ? "border-b-2 border-[#6d28d9] text-[#6d28d9]" : "text-gray-500 hover:text-gray-800"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <Active
        content={state.content}
        onChange={(content) => {
          setState((s) => (s ? { ...s, content } : s));
          setDirty(true);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Write `src/app/superadmin/marketing/page.tsx`**

```tsx
import MarketingEditor from "@/components/marketing/editor/MarketingEditor";

export default function SuperadminMarketingPage() {
  return <MarketingEditor />;
}
```

- [ ] **Step 5: Link from the overview**

In `src/app/superadmin/page.tsx`, directly inside the container `<div className="max-w-7xl mx-auto px-6 py-8 space-y-6">`, before the stats row:

```tsx
      <div className="flex justify-end">
        <Link
          href="/superadmin/marketing"
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Marketing page
        </Link>
      </div>
```

- [ ] **Step 6: Type-check, lint and commit**

```bash
npx tsc --noEmit
npm run lint
git status --short
git diff
git add src/components/marketing/editor src/app/superadmin/marketing/page.tsx src/app/superadmin/page.tsx
git commit -m "feat(marketing): superadmin editor for texts, logos, images, payments and SEO" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: exit 0 on `tsc` and lint.

---

## Task 12: Draft preview

**Files:**
- Create: `src/app/superadmin/marketing/preview/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import MarketingPage from "@/components/marketing/MarketingPage";
import { requireSuperadmin } from "@/lib/superadminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { readVersion } from "@/lib/marketing/store";
import { validateMarketingContent } from "@/lib/marketing/validate";

// Reads the draft directly, never the public cache.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Draft preview",
  robots: { index: false, follow: false },
};

function Message({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6 py-16 text-center text-sm text-gray-600">{children}</div>;
}

export default async function MarketingPreviewPage() {
  // The layout checks this too, but this page reads with the service role.
  const auth = await requireSuperadmin();
  if ("error" in auth) redirect("/login");

  const { row, error } = await readVersion(createAdminClient(), "draft");
  if (error) return <Message>Couldn&apos;t load the draft.</Message>;
  if (!row) return <Message>There&apos;s no saved draft to preview.</Message>;

  const validated = validateMarketingContent(row.content);
  if (!validated.ok) return <Message>This draft has invalid content and can&apos;t be previewed.</Message>;

  return (
    <>
      <div role="status" className="bg-amber-400 px-4 py-2 text-center text-sm font-semibold text-amber-950">
        Draft preview. Visitors don&apos;t see this until it&apos;s published.
      </div>
      <MarketingPage content={validated.content} />
    </>
  );
}
```

- [ ] **Step 2: Type-check and commit**

```bash
npx tsc --noEmit
git status --short
git diff
git add src/app/superadmin/marketing/preview/page.tsx
git commit -m "feat(marketing): noindex draft preview" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Verify, then open the PR

- [ ] **Step 1: Full checks, dev server stopped**

```bash
npm test
npm run test:db -- marketing-page
npm run lint
npx tsc --noEmit
npm run build
```

Judge by exit code. Report any pre-existing failures with their output rather than ignoring them.

- [ ] **Step 2: Show the owner the migration, then apply it to the dev database**

Project rules require this order:
1. Confirm the CLI is linked to `fnfvwzwrdsnmwxunciti`. If it's linked to anything else, stop.
2. Run `npx supabase migration list` and `npx supabase db push --dry-run`. Show the owner the output and the SQL.
3. Wait for a clear yes, then run `npx supabase db push`.

Staging reads this database too. The migration is additive.

- [ ] **Step 3: Check real privileges on dev**

Read-only:

```sql
SELECT
  has_table_privilege('anon', 'public.marketing_page_versions', 'SELECT') AS anon_select,
  has_table_privilege('authenticated', 'public.marketing_page_versions', 'SELECT') AS auth_select,
  has_table_privilege('service_role', 'public.marketing_page_versions', 'SELECT')
    AND has_table_privilege('service_role', 'public.marketing_page_versions', 'INSERT')
    AND has_table_privilege('service_role', 'public.marketing_page_versions', 'UPDATE') AS service_rw,
  has_function_privilege('anon', 'public.publish_marketing_draft(integer,uuid)', 'EXECUTE') AS anon_publish,
  has_function_privilege('authenticated', 'public.create_marketing_draft(uuid,jsonb,uuid)', 'EXECUTE') AS auth_create,
  (SELECT file_size_limit FROM storage.buckets WHERE id = 'marketing-assets') AS bucket_limit;
```

Expected: `false, false, true, false, false, 4194304`.

- [ ] **Step 4: Browser checks with the dev server**

`preview_start` the dev server on port 3005. The owner signs in as superadmin in the browser pane; don't enter a password.

| Check | Expected |
|---|---|
| `/` before any publish, desktop and 375px | Looks the same as today; no console errors |
| `/superadmin/marketing` signed out | Redirects to `/login` |
| `GET /api/superadmin/marketing` signed out | 401 |
| Edit a text, Save draft | "Draft saved"; Publish enabled |
| Edit again without saving | Preview and Publish disabled |
| Upload JPEG, PNG, WebP as a logo | Appear in the tab |
| Upload an SVG renamed `.png`, and a file over 4 MB | Clear message; nothing added |
| Preview | New tab, banner, draft content, `noindex` in the HTML, uploaded image loads through `next/image` |
| `/` while a draft exists | Doesn't show the draft |
| Two tabs: save in one, then save in the other | Second gets the reload message |
| Hide How it works, save, preview | Section, hero button and footer column gone |
| Hide a payment | Reminder shows |
| Publish | `/` shows the content straight away |
| Restore an older version | Draft changes; `/` doesn't, until published |

Take screenshots of the editor and preview. To finish, restore the dev content to match the defaults, because staging reads this database, and tell the owner what was published there. `marketing_page_versions` rows and test uploads stay on dev: the app has no delete, and deleting needs the owner's approval.

- [ ] **Step 5: Codex code review**

```bash
codex exec -s read-only -o docs/superpowers/reviews/2026-11-02-marketing-page-cms-code-review-1.md "Review the diff of origin/dev...HEAD on this branch against docs/superpowers/specs/2026-11-02-marketing-page-cms-design.md and docs/superpowers/plans/2026-11-02-marketing-page-cms.md. Report concrete defects with file and line, by severity. Read-only." </dev/null
```

Apply findings with `superpowers:receiving-code-review`, and re-run until no High or Medium findings remain, up to three passes.

- [ ] **Step 6: Push and open the PR to `dev`**

```bash
git fetch origin
git rebase origin/dev
git push -u origin feature/marketing-page-cms
```

Open the PR against `dev`, ending the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Don't merge it. Call `mcp__ccd_pr__get_status`, and `bind_pr` if the PR isn't reported.

- [ ] **Step 7: Post every Codex review on the PR**

Post each spec, plan and code review verbatim with the footer `_🤖 Reviewed by Codex_`, and each set of fixes with `_🤖 Addressed by [Claude Code](https://claude.com/claude-code)_`. Convert local absolute paths to repo blob links first, and check for exploit detail, since the repo is public.

- [ ] **Step 8: Report using the status format**

Report **Claude Code**, **Codex** and **Human** separately. The Human list includes:
1. **Required:** review and merge the PR to `dev`.
2. **Required before `main`:** the #334 release gate (CB MMQR, GTM, KBZPay MMQR, tier caps and sponsor logos on production), or cut those claims from `defaultContent`.
3. **Required before `main`:** native-speaker check of the Myanmar copy.
4. **Required at production release:** apply the migration to production, then publish production content separately.

Update `project_festival_homepage.md`'s neighbours in memory with a new project memory for this feature, including that it's on dev only and production has neither the code nor the migration.
