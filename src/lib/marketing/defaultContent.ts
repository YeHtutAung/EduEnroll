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
