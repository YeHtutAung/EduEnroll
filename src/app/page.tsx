import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";

const TITLE = "KuuNyi — Festival & Event Ticketing for Myanmar";
const DESCRIPTION =
  "Sell tickets, take KBZPay, MMQR and card payments, and scan QR e-tickets at the gate. " +
  "Built for Myanmar festivals and events.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: "KuuNyi",
    locale: "my_MM",
    type: "website",
  },
  twitter: {
    title: TITLE,
    description: DESCRIPTION,
  },
};

// Photos in /public/marketing are from Unsplash (Unsplash License). Sources are
// listed in docs/superpowers/specs/2026-11-01-festival-marketing-homepage-design.md.

// ─── Payment methods ─────────────────────────────────────────────────────────

const PAYMENT_LOGOS = [
  { src: "/kbzpay-logo.png", alt: "KBZPay", width: 800, height: 800 },
  { src: "/cbmmqr/cb-bank-logo.png", alt: "CB Bank", width: 371, height: 160 },
  { src: "/mmqr-logo.png", alt: "MMQR", width: 1920, height: 2943 },
  { src: "/visa.svg", alt: "Visa", width: 60, height: 20 },
  { src: "/mastercard.svg", alt: "Mastercard", width: 48, height: 32 },
];

// ─── Organizers ──────────────────────────────────────────────────────────────
// Logos supplied by the owner, with each organizer's permission (2026-11-01).

const ORGANIZERS = [
  { name: "H-Life Entertainment", src: "/marketing/organizers/h-life.png", width: 611, height: 611 },
  { name: "Brave Entertainment", src: "/marketing/organizers/brave.png", width: 960, height: 960 },
  { name: "Louder Myanmar", src: "/marketing/organizers/louder.webp", width: 1500, height: 1500 },
  { name: "Thingyan Music Festival", src: "/marketing/organizers/tmf.png", width: 1080, height: 1080 },
  { name: "Sky Festival", src: "/marketing/organizers/sky-festival.png", width: 1080, height: 1080 },
  { name: "Rock In Mandalay", src: "/marketing/organizers/rock-in-mandalay.webp", width: 1080, height: 1080 },
];

// ─── Solutions ───────────────────────────────────────────────────────────────

const SOLUTIONS: {
  label: string;
  titleEn: string;
  titleMm: string;
  descEn: string;
  photo: string | null;
}[] = [
  {
    label: "Ticketing",
    titleEn: "QR e-tickets & gate scanning",
    titleMm: "QR အီး-လက်မှတ်နှင့် ဝင်ပေါက်စစ်ဆေးမှု",
    descEn:
      "Every ticket carries a unique QR, shown on the payment page and sent by email. Staff scan it at the gate, and each QR works once.",
    photo: "/marketing/scan.jpg",
  },
  {
    label: "Payments",
    titleEn: "Local + card payments",
    titleMm: "ပြည်တွင်းနှင့် ကတ်ငွေပေးချေမှု",
    descEn:
      "KBZPay and CB MMQR for fans in Myanmar, Visa and Mastercard for fans overseas. Payment is confirmed automatically.",
    photo: null,
  },
  {
    label: "Sales control",
    titleEn: "Ticket tiers & sell-out control",
    titleMm: "လက်မှတ်အဆင့်များနှင့် အရေအတွက်ထိန်းချုပ်မှု",
    descEn:
      "Early Bird, GA and VIP with a limit per tier, plus a priority window for your fans before public sale.",
    photo: "/marketing/tiers.jpg",
  },
  {
    label: "Branding",
    titleEn: "Your event, your brand",
    titleMm: "သင့်ကိုယ်ပိုင် အမှတ်တံဆိပ်",
    descEn:
      "Your own domain, sponsor logos on e-tickets, and your Meta, TikTok and Google pixels via Google Tag Manager.",
    photo: "/marketing/brand.jpg",
  },
];

// ─── How it works ────────────────────────────────────────────────────────────

const STEPS = [
  { step: "01", titleEn: "Fan picks a ticket tier", titleMm: "လက်မှတ်အမျိုးအစား ရွေးချယ်သည်" },
  { step: "02", titleEn: "Pays with KBZPay, MMQR or card", titleMm: "KBZPay၊ MMQR သို့မဟုတ် ကတ်ဖြင့် ပေးချေသည်" },
  { step: "03", titleEn: "Gets a QR e-ticket", titleMm: "QR အီး-လက်မှတ် ရရှိသည်" },
  { step: "04", titleEn: "Staff scan it at the gate", titleMm: "ဝင်ပေါက်တွင် စကင်ဖတ်၍ ဝင်ရောက်သည်" },
];

// ─── Industries ──────────────────────────────────────────────────────────────

const INDUSTRIES = [
  { en: "Music festivals", mm: "ဂီတပွဲတော်များ", photo: "/marketing/festival.jpg" },
  { en: "Concerts", mm: "ဂီတဖျော်ဖြေပွဲများ", photo: "/marketing/concert.jpg" },
  { en: "Runs & sports", mm: "အပြေးနှင့် အားကစားပွဲများ", photo: "/marketing/run.jpg" },
  { en: "Conferences & shows", mm: "ညီလာခံနှင့် ပွဲများ", photo: "/marketing/conference.jpg" },
  { en: "Schools & training", mm: "ကျောင်းနှင့် သင်တန်းများ", photo: "/marketing/school.jpg" },
  { en: "Custom events", mm: "စိတ်ကြိုက်ပွဲများ", photo: "/marketing/custom.jpg" },
];

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-up { animation: fadeUp 0.7s ease-out both; }
        .delay-100 { animation-delay: 100ms; }
        .delay-200 { animation-delay: 200ms; }
        .delay-300 { animation-delay: 300ms; }
        @media (prefers-reduced-motion: reduce) {
          .animate-fade-up { animation: none; }
        }
      `}</style>

      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="relative min-h-[600px] h-[88vh] max-h-[900px] flex flex-col overflow-hidden bg-[#0f1225]">
        <Image
          src="/marketing/hero.jpg"
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/60 to-black/20" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/60 to-transparent" />

        {/* Navbar */}
        <header className="relative z-10">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 h-20 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2.5">
              <Image src="/kuunyi-logo.jpeg" alt="KuuNyi" width={32} height={32} className="rounded-lg" />
              <span className="text-lg font-bold text-white tracking-tight">KuuNyi</span>
            </Link>
            <nav className="flex items-center gap-1 sm:gap-2">
              <Link
                href="/login"
                className="text-sm font-medium text-white/90 hover:text-white px-3 sm:px-4 py-2 rounded-xl hover:bg-white/10 transition-colors"
              >
                Sign In
              </Link>
              <Link
                href="/register"
                className="text-sm font-semibold text-slate-900 bg-white hover:bg-slate-100 px-4 sm:px-5 py-2 rounded-xl transition-colors"
              >
                Get Started
              </Link>
            </nav>
          </div>
        </header>

        {/* Copy */}
        <div className="relative z-10 flex-1 flex items-center">
          <div className="max-w-6xl w-full mx-auto px-4 sm:px-6 pb-10">
            <div className="max-w-2xl">
              <p className="animate-fade-up text-xs sm:text-sm font-semibold uppercase tracking-[0.2em] text-[#c4b5fd]">
                Festival &amp; event ticketing
              </p>
              <h1 className="animate-fade-up delay-100 mt-4 text-5xl sm:text-7xl font-extrabold text-white tracking-tight leading-[1.02]">
                Sell out your festival.
              </h1>
              <p className="animate-fade-up delay-100 mt-5 font-myanmar text-lg sm:text-xl text-white/90 leading-relaxed">
                ပွဲတော်လက်မှတ်ရောင်းချမှု၊ ငွေပေးချေမှုနှင့် ဝင်ပေါက်စစ်ဆေးမှု — တစ်နေရာတည်းတွင်
              </p>
              <p className="animate-fade-up delay-200 mt-4 text-base sm:text-lg text-white/85 max-w-xl leading-relaxed">
                Tickets, payments and gate scanning — one platform for Myanmar music festivals.
              </p>
              <div className="animate-fade-up delay-300 mt-8 flex flex-col sm:flex-row gap-3">
                <Link
                  href="/register"
                  className="inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-[#6d28d9] hover:bg-[#5b21b6] text-white font-semibold text-sm transition-colors"
                >
                  Start selling tickets
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </Link>
                <Link
                  href="#how"
                  className="inline-flex items-center justify-center px-7 py-3.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/30 text-white font-semibold text-sm backdrop-blur-sm transition-colors"
                >
                  See how it works
                </Link>
              </div>
              <p className="animate-fade-up delay-300 mt-6 text-sm text-white/80">
                Free to set up — a small fee only when you sell online.
                <span className="block font-myanmar text-xs mt-1">
                  စတင်ရန် အခမဲ့ — အွန်လိုင်းရောင်းချမှုအတွက်သာ အနည်းငယ် ကောက်ခံပါသည်
                </span>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Trusted by ─────────────────────────────────────── */}
      <section className="py-16 sm:py-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-xl sm:text-2xl font-extrabold uppercase tracking-[0.08em]">
              Trusted by top event organizers
            </h2>
            <p className="font-myanmar text-slate-500 text-sm sm:text-base mt-2">
              ထိပ်တန်း ပွဲစီစဉ်သူများ၏ ယုံကြည်မှု
            </p>
            <p className="mt-3 text-slate-600">
              Myanmar&apos;s festival and concert organizers run their events with KuuNyi.
            </p>
          </div>
          <ul className="mt-10 max-w-5xl mx-auto grid grid-cols-3 sm:grid-cols-6 gap-4 sm:gap-5">
            {ORGANIZERS.map((org) => (
              <li key={org.name} className="flex flex-col items-center text-center">
                <div className="relative w-full aspect-square rounded-2xl overflow-hidden border border-slate-200 bg-white shadow-sm">
                  <Image
                    src={org.src}
                    alt={org.name}
                    width={org.width}
                    height={org.height}
                    sizes="(min-width: 640px) 160px, 30vw"
                    className="w-full h-full object-cover"
                  />
                </div>
                <span className="mt-2.5 text-xs sm:text-sm font-semibold text-slate-700 leading-tight">{org.name}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Payments strip ─────────────────────────────────── */}
      <section className="border-y border-slate-100 bg-slate-50/60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-12">
          <p className="text-center text-xs sm:text-sm font-bold uppercase tracking-[0.18em] text-slate-900">
            Accepted payments
          </p>
          <p className="text-center font-myanmar text-sm text-slate-500 mt-1">လက်ခံသော ငွေပေးချေမှုများ</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-10 gap-y-6 sm:gap-x-14">
            {PAYMENT_LOGOS.map((logo) => (
              <Image
                key={logo.src}
                src={logo.src}
                alt={logo.alt}
                width={logo.width}
                height={logo.height}
                className="h-9 sm:h-10 w-auto object-contain"
              />
            ))}
          </div>
        </div>
      </section>

      {/* ── Solutions ──────────────────────────────────────── */}
      <section className="py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="max-w-2xl">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#6d28d9]">Solutions</p>
            <h2 className="mt-3 text-3xl sm:text-4xl font-extrabold tracking-tight">
              Everything your festival needs
            </h2>
            <p className="font-myanmar text-slate-500 text-base mt-2">ပွဲတော်တစ်ခုအတွက် လိုအပ်သမျှ</p>
            <p className="mt-4 text-slate-600 leading-relaxed">
              Everything you need to sell tickets and run the gate — without spreadsheets or payment screenshots.
            </p>
          </div>

          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            {SOLUTIONS.map((s) => (
              <article
                key={s.titleEn}
                className="group rounded-3xl overflow-hidden bg-white border border-slate-200 hover:shadow-[0_16px_40px_-12px_rgba(15,18,37,0.18)] transition-shadow"
              >
                <div className="relative aspect-[16/9] overflow-hidden bg-[#1e1b4b]">
                  {s.photo ? (
                    <Image
                      src={s.photo}
                      alt=""
                      fill
                      sizes="(min-width: 640px) 50vw, 100vw"
                      className="object-cover group-hover:scale-[1.03] transition-transform duration-500"
                    />
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-br from-[#6d28d9] via-[#4c1d95] to-[#1e1b4b] flex items-center justify-center p-6">
                      <div className="grid grid-cols-2 gap-3 w-full max-w-xs">
                        {[PAYMENT_LOGOS.slice(0, 1), PAYMENT_LOGOS.slice(1, 2), PAYMENT_LOGOS.slice(2, 3), PAYMENT_LOGOS.slice(3)].map((chip) => (
                          <div key={chip[0].src} className="h-16 rounded-xl bg-white flex items-center justify-center gap-2 p-3">
                            {chip.map((logo) => (
                              <Image
                                key={logo.src}
                                src={logo.src}
                                alt=""
                                width={logo.width}
                                height={logo.height}
                                className="max-h-full w-auto object-contain"
                              />
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="p-6 sm:p-8">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#6d28d9]">{s.label}</p>
                  <h3 className="mt-2 text-xl sm:text-2xl font-bold tracking-tight">{s.titleEn}</h3>
                  <p className="font-myanmar text-sm text-slate-500 mt-1">{s.titleMm}</p>
                  <p className="mt-3 text-slate-600 leading-relaxed">{s.descEn}</p>
                </div>
              </article>
            ))}
          </div>

          {/* Event Payment System — a separate KuuNyi product, in use since 2017. */}
          <article className="mt-6 grid md:grid-cols-2 rounded-3xl overflow-hidden bg-[#0f1225] text-white">
            <div className="relative aspect-[16/10] md:aspect-auto md:min-h-[360px]">
              <Image
                src="/marketing/pos.jpg"
                alt=""
                fill
                sizes="(min-width: 768px) 50vw, 100vw"
                className="object-cover"
              />
            </div>
            <div className="p-6 sm:p-10 flex flex-col justify-center">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#c4b5fd]">On-site payments</p>
              <h3 className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight">Cashless bars &amp; food stalls</h3>
              <p className="font-myanmar text-sm text-slate-300 mt-1">ငွေသားမလိုသော ဘားနှင့် စားသောက်ကောင်တာများ</p>
              <p className="mt-4 text-slate-300 leading-relaxed">
                Fans top up a prepaid QR card at the cash counter, then pay for drinks, snacks and water at every bar
                with one scan.
              </p>
              <ul className="mt-5 space-y-2 text-sm text-slate-300">
                {[
                  "Staff phones, stock and sales for every counter — VVIP, VIP, GA",
                  "Income, stock and card-balance reports after the show",
                  "Running at Myanmar festivals since 2017",
                ].map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <svg className="w-5 h-5 shrink-0 text-[#a78bfa]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </article>
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────── */}
      <section id="how" className="relative py-20 sm:py-28 overflow-hidden scroll-mt-4 bg-[#0f1225]">
        <Image src="/marketing/how.jpg" alt="" fill sizes="100vw" className="object-cover" />
        <div className="absolute inset-0 bg-[#0f1225]/80" />

        <div className="relative max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center">
            <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">How it works</h2>
            <p className="font-myanmar text-[#c4b5fd] text-base sm:text-lg mt-2">အလုပ်လုပ်ပုံ</p>
            <p className="text-white/80 mt-4 max-w-lg mx-auto">
              From ticket sale to the front gate, in four steps. No screenshots to check.
            </p>
          </div>

          <ol className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <li key={s.step} className="text-center">
                <span className="block text-5xl sm:text-6xl font-extrabold text-white">{s.step}</span>
                <span className="mt-3 block text-base font-semibold text-white">{s.titleEn}</span>
                <span className="mt-1 block font-myanmar text-sm text-white/75">{s.titleMm}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Industries ─────────────────────────────────────── */}
      <section className="py-20 sm:py-28 bg-slate-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
              Built for every event
            </h2>
            <p className="font-myanmar text-slate-500 text-base mt-2">မည်သည့်ပွဲအတွက်မဆို</p>
            <p className="mt-4 text-slate-600 leading-relaxed">
              From open-air festivals to classrooms — one platform, with labels that adapt to your organisation type.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5">
            {INDUSTRIES.map((ind) => (
              <div key={ind.en} className="group relative aspect-square sm:aspect-[4/3] rounded-2xl sm:rounded-3xl overflow-hidden bg-slate-800">
                <Image
                  src={ind.photo}
                  alt=""
                  fill
                  sizes="(min-width: 1024px) 33vw, 50vw"
                  className="object-cover group-hover:scale-[1.04] transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6">
                  <p className="text-base sm:text-xl font-bold text-white">{ind.en}</p>
                  <p className="font-myanmar text-xs sm:text-sm text-white/85 mt-0.5">{ind.mm}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ────────────────────────────────────────────── */}
      <section className="py-20 sm:py-24">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="relative rounded-3xl overflow-hidden bg-[#0f1225] px-6 py-16 sm:px-14 sm:py-24 text-center">
            <Image src="/marketing/cta.jpg" alt="" fill sizes="(min-width: 1152px) 1152px, 100vw" className="object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#1e1b4b]/95 via-[#1e1b4b]/75 to-[#1e1b4b]/55" />
            <div className="relative">
              <h2 className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight">
                Ready for your next festival?
              </h2>
              <p className="font-myanmar text-white/85 text-base sm:text-lg mt-3">
                သင့်နောက်ပွဲတော်အတွက် အသင့်ဖြစ်ပြီလား?
              </p>
              <p className="text-white/80 mt-4 max-w-md mx-auto">
                Set up your event in minutes and start selling tickets today.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                <Link
                  href="/register"
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-xl bg-white text-slate-900 hover:bg-slate-100 font-semibold text-sm transition-colors"
                >
                  Start selling tickets
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </Link>
                <Link
                  href="/login"
                  className="w-full sm:w-auto inline-flex items-center justify-center px-7 py-3.5 rounded-xl border border-white/40 text-white hover:bg-white/10 font-semibold text-sm transition-colors"
                >
                  Sign In
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="bg-[#0f1225] text-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-14 grid gap-10 sm:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <Image src="/kuunyi-logo.jpeg" alt="KuuNyi" width={28} height={28} className="rounded-lg" />
              <span className="text-base font-bold">KuuNyi</span>
            </div>
            <p className="mt-4 text-sm text-slate-300 max-w-xs leading-relaxed">
              Festival and event ticketing for Myanmar — tickets, payments and gate scanning in one place.
            </p>
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Product</p>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-300">
              <li><Link href="#how" className="hover:text-white">How it works</Link></li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Organisers</p>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-300">
              <li><Link href="/register" className="hover:text-white">Get Started</Link></li>
              <li><Link href="/login" className="hover:text-white">Sign In</Link></li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Legal</p>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-300">
              <li><Link href="/privacy" className="hover:text-white">Privacy</Link></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-white/10">
          <p className="max-w-6xl mx-auto px-4 sm:px-6 py-6 text-xs text-slate-400">
            &copy; {new Date().getFullYear()} KuuNyi — Myanmar
          </p>
        </div>
      </footer>
    </div>
  );
}
