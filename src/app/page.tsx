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

// ─── How it works ────────────────────────────────────────────────────────────

const STEPS = [
  {
    step: "01",
    titleEn: "Fan picks a ticket tier",
    titleMm: "လက်မှတ်အမျိုးအစား ရွေးချယ်သည်",
    descEn: "Early Bird, GA or VIP — straight from their phone.",
  },
  {
    step: "02",
    titleEn: "Pays with KBZPay, MMQR or card",
    titleMm: "KBZPay၊ MMQR သို့မဟုတ် ကတ်ဖြင့် ပေးချေသည်",
    descEn: "Payment is confirmed automatically. No screenshots to check.",
  },
  {
    step: "03",
    titleEn: "Gets a QR e-ticket",
    titleMm: "QR အီး-လက်မှတ် ရရှိသည်",
    descEn: "Shown on the payment page and sent by email.",
  },
  {
    step: "04",
    titleEn: "Staff scan it at the gate",
    titleMm: "ဝင်ပေါက်တွင် စကင်ဖတ်၍ ဝင်ရောက်သည်",
    descEn: "Each QR works once, so copied tickets don't get in.",
  },
];

// ─── Features ────────────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 010 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 010-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375z" />
      </svg>
    ),
    titleEn: "QR e-tickets + gate scanner",
    titleMm: "QR အီး-လက်မှတ်နှင့် ဝင်ပေါက်စကင်နာ",
    descEn: "Every ticket carries a unique QR. Staff scan it at entry and duplicates are stopped.",
    descMm: "လက်မှတ်တိုင်းတွင် သီးသန့် QR ပါဝင်ပြီး ထပ်တူဝင်ရောက်မှုကို တားဆီးပေးသည်",
  },
  {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
      </svg>
    ),
    titleEn: "Local + card payments",
    titleMm: "ပြည်တွင်းနှင့် ကတ်ငွေပေးချေမှု",
    descEn: "KBZPay and CB MMQR for fans in Myanmar, Visa and Mastercard for fans overseas. Confirmed automatically.",
    descMm: "KBZPay၊ CB MMQR နှင့် Visa / Mastercard — အလိုအလျောက် အတည်ပြုသည်",
  },
  {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
      </svg>
    ),
    titleEn: "Ticket tiers & sell-out control",
    titleMm: "လက်မှတ်အဆင့်များနှင့် အရေအတွက်ထိန်းချုပ်မှု",
    descEn: "Early Bird, GA and VIP with a limit per tier, plus a priority window before public sale.",
    descMm: "အဆင့်အလိုက် ကန့်သတ်ချက်နှင့် ဦးစားပေး ရောင်းချချိန်",
  },
  {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42" />
      </svg>
    ),
    titleEn: "Your brand",
    titleMm: "သင့်ကိုယ်ပိုင် အမှတ်တံဆိပ်",
    descEn: "Your own domain, sponsor logos on e-tickets, and your Meta, TikTok and Google pixels via Google Tag Manager.",
    descMm: "ကိုယ်ပိုင်ဒိုမိန်း၊ စပွန်ဆာလိုဂိုများနှင့် ကြော်ငြာ pixel များ",
  },
];

// ─── Payment methods ─────────────────────────────────────────────────────────

const PAYMENT_METHODS = [
  { name: "KBZPay", logos: [{ src: "/kbzpay-logo.png", width: 800, height: 800 }] },
  { name: "CB Bank MMQR", logos: [{ src: "/cbmmqr/cb-bank-logo.png", width: 371, height: 160 }] },
  { name: "MMQR", logos: [{ src: "/mmqr-logo.png", width: 1920, height: 2943 }] },
  {
    name: "Visa / Mastercard",
    logos: [
      { src: "/visa.svg", width: 60, height: 20 },
      { src: "/mastercard.svg", width: 48, height: 32 },
    ],
  },
];

// ─── Also works for ──────────────────────────────────────────────────────────

const ALSO_FOR = [
  { emoji: "🏃", en: "Runs & sports events", mm: "အပြေးနှင့် အားကစားပွဲများ" },
  { emoji: "🎤", en: "Concerts", mm: "ဂီတဖျော်ဖြေပွဲများ" },
  { emoji: "🎓", en: "Language schools", mm: "ဘာသာစကားသင်တန်းကျောင်းများ" },
  { emoji: "💻", en: "Training centres", mm: "သင်တန်းဌာနများ" },
  { emoji: "💪", en: "Fitness", mm: "ကိုယ်ကာယကျန်းမာရေး" },
  { emoji: "⚙️", en: "Custom", mm: "စိတ်ကြိုက်သတ်မှတ်နိုင်" },
];

// ─── Ticket mockup QR ────────────────────────────────────────────────────────
// Fixed pattern: a random one renders differently on server and client.

const QR_PATTERN = [
  "111010111",
  "101101101",
  "111001111",
  "000110010",
  "101011100",
  "011100101",
  "111010011",
  "101101100",
  "111011010",
];

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#faf9f7] overflow-hidden">
      {/* ── CSS animations ─────────────────────────────────── */}
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(24px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0) rotate(-2deg); }
          50% { transform: translateY(-10px) rotate(-2deg); }
        }
        @keyframes sway {
          0%, 100% { transform: rotate(var(--beam-rot)); opacity: 0.55; }
          50% { transform: rotate(calc(var(--beam-rot) + 6deg)); opacity: 0.9; }
        }
        @keyframes scan-line {
          0% { top: 8%; }
          50% { top: calc(92% - 2px); }
          100% { top: 8%; }
        }
        .animate-fade-up {
          animation: fadeUp 0.7s ease-out both;
        }
        .animate-fade-in {
          animation: fadeIn 0.6s ease-out both;
        }
        .animate-float {
          animation: float 5s ease-in-out infinite;
        }
        .stage-beam {
          animation: sway 7s ease-in-out infinite;
          transform-origin: top center;
        }
        .delay-100 { animation-delay: 100ms; }
        .delay-200 { animation-delay: 200ms; }
        .delay-300 { animation-delay: 300ms; }
        .delay-400 { animation-delay: 400ms; }
        .delay-500 { animation-delay: 500ms; }
        .delay-600 { animation-delay: 600ms; }
        @media (prefers-reduced-motion: reduce) {
          .animate-fade-up, .animate-fade-in, .animate-float, .stage-beam { animation: none; }
        }
      `}</style>

      {/* ── Navbar ──────────────────────────────────────────── */}
      <header className="fixed top-0 left-0 right-0 z-50 animate-fade-in">
        <div className="mx-4 sm:mx-6 mt-3">
          <div className="max-w-6xl mx-auto flex items-center justify-between px-5 sm:px-6 h-14 rounded-2xl bg-[#0f1225]/75 backdrop-blur-xl border border-white/10 shadow-[0_4px_24px_-6px_rgba(0,0,0,0.4)]">
            <Link href="/" className="flex items-center gap-2.5 group">
              <Image
                src="/kuunyi-logo.jpeg"
                alt="KuuNyi"
                width={30}
                height={30}
                className="rounded-lg shrink-0 group-hover:scale-105 transition-transform"
              />
              <span className="text-[15px] font-bold text-white tracking-tight">KuuNyi</span>
            </Link>
            <nav className="flex items-center gap-2">
              <Link
                href="/login"
                className="text-sm font-medium text-slate-300 hover:text-white px-4 py-2 rounded-xl hover:bg-white/10 transition-all"
              >
                Sign In
              </Link>
              <Link
                href="/register"
                className="text-sm font-semibold text-white bg-[#6d28d9] hover:bg-[#5b21b6] px-5 py-2 rounded-xl transition-all shadow-[0_0_16px_rgba(109,40,217,0.45)]"
              >
                Get Started
              </Link>
            </nav>
          </div>
        </div>
      </header>

      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="relative bg-[#0f1225] pt-28 sm:pt-36 pb-20 sm:pb-28 overflow-hidden">
        {/* Stage lights */}
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
          <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[900px] h-[500px] rounded-full bg-[#6d28d9]/20 blur-[120px]" />
          <div
            className="stage-beam absolute -top-10 left-[12%] w-40 h-[620px] bg-gradient-to-b from-[#a78bfa]/30 via-[#6d28d9]/10 to-transparent blur-2xl"
            style={{ ["--beam-rot" as string]: "18deg" }}
          />
          <div
            className="stage-beam absolute -top-10 left-[45%] w-32 h-[560px] bg-gradient-to-b from-[#c4b5fd]/20 via-[#6d28d9]/10 to-transparent blur-2xl delay-300"
            style={{ ["--beam-rot" as string]: "-8deg" }}
          />
          <div
            className="stage-beam absolute -top-10 right-[10%] w-40 h-[620px] bg-gradient-to-b from-[#f472b6]/20 via-[#6d28d9]/10 to-transparent blur-2xl delay-500"
            style={{ ["--beam-rot" as string]: "-20deg" }}
          />
          <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-[#0f1225] to-transparent" />
        </div>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 relative">
          <div className="grid lg:grid-cols-[1.15fr_1fr] gap-14 lg:gap-10 items-center">
            {/* Copy */}
            <div className="text-center lg:text-left">
              <div className="animate-fade-up inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 mb-8">
                <span className="w-1.5 h-1.5 rounded-full bg-[#a78bfa] animate-pulse" />
                <span className="text-xs font-semibold text-slate-200 tracking-wide uppercase">
                  Festival &amp; event ticketing
                </span>
                <span className="hidden sm:inline text-xs font-myanmar text-slate-300">ပွဲတော်လက်မှတ်စနစ်</span>
              </div>

              <h1 className="animate-fade-up delay-100">
                <span className="block text-4xl sm:text-6xl font-extrabold text-white tracking-tight leading-[1.08]">
                  Sell out your{" "}
                  <span className="bg-gradient-to-r from-[#c4b5fd] to-[#f0abfc] bg-clip-text text-transparent">
                    festival.
                  </span>
                </span>
                <span className="block font-myanmar text-lg sm:text-xl text-slate-300 mt-5 leading-relaxed font-medium">
                  ပွဲတော်လက်မှတ်ရောင်းချမှု၊ ငွေပေးချေမှုနှင့် ဝင်ပေါက်စစ်ဆေးမှု — တစ်နေရာတည်းတွင်
                </span>
              </h1>

              <p className="animate-fade-up delay-200 mt-6 text-base sm:text-lg text-slate-300 max-w-xl mx-auto lg:mx-0 leading-relaxed">
                Tickets, payments and gate scanning — one platform for Myanmar music festivals.
              </p>

              <div className="animate-fade-up delay-300 mt-8 sm:mt-10 flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-3">
                <Link
                  href="/register"
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-7 py-3.5 rounded-2xl bg-[#6d28d9] text-white font-semibold text-sm transition-all shadow-[0_0_24px_rgba(109,40,217,0.55)] hover:shadow-[0_0_36px_rgba(167,139,250,0.55)] hover:bg-[#5b21b6] active:scale-[0.98]"
                >
                  Start selling tickets
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </Link>
                <Link
                  href="#how"
                  className="w-full sm:w-auto inline-flex items-center justify-center px-7 py-3.5 rounded-2xl border border-white/15 text-slate-200 font-medium hover:bg-white/5 hover:border-white/25 transition-all text-sm"
                >
                  See how it works
                </Link>
              </div>

              <p className="animate-fade-up delay-400 mt-8 text-xs text-slate-300 font-medium">
                Free to set up — a small fee only when you sell online.
                <span className="block sm:inline font-myanmar sm:ml-2 mt-1 sm:mt-0">
                  စတင်ရန် အခမဲ့ — အွန်လိုင်းရောင်းချမှုအတွက်သာ အနည်းငယ် ကောက်ခံပါသည်
                </span>
              </p>
            </div>

            {/* E-ticket mockup */}
            <div className="animate-fade-up delay-300 flex justify-center lg:justify-end" aria-hidden="true">
              <div className="animate-float relative">
                <div className="absolute -inset-6 rounded-[2.5rem] bg-[#6d28d9]/30 blur-3xl" />
                <div className="relative w-[270px] sm:w-[290px] rounded-3xl bg-white overflow-hidden shadow-[0_20px_60px_-10px_rgba(109,40,217,0.6)]">
                  {/* Header */}
                  <div className="relative px-6 pt-6 pb-5 bg-gradient-to-br from-[#6d28d9] via-[#5b21b6] to-[#1e1b4b] text-white">
                    <p className="text-[10px] font-bold tracking-[0.2em] uppercase text-[#ddd6fe]">E-Ticket</p>
                    <p className="text-xl font-extrabold mt-1 leading-tight">Your Festival 2026</p>
                    <div className="mt-3 flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full bg-white/20 text-[11px] font-bold">VIP</span>
                      <span className="text-[11px] font-semibold text-[#ddd6fe]">Admit one</span>
                    </div>
                  </div>

                  {/* Perforation */}
                  <div className="relative h-0">
                    <div className="absolute -left-3 -top-3 w-6 h-6 rounded-full bg-[#0f1225]" />
                    <div className="absolute -right-3 -top-3 w-6 h-6 rounded-full bg-[#0f1225]" />
                    <div className="absolute left-5 right-5 top-0 border-t-2 border-dashed border-slate-200" />
                  </div>

                  {/* QR */}
                  <div className="px-6 pt-6 pb-6 text-center">
                    <div className="relative mx-auto w-36 h-36 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center">
                      <div className="grid grid-cols-9 gap-[3px] w-28 h-28">
                        {QR_PATTERN.join("").split("").map((cell, i) => (
                          <div
                            key={i}
                            className={`rounded-[2px] ${
                              i === 40 ? "bg-[#6d28d9]" : cell === "1" ? "bg-slate-800" : "bg-transparent"
                            }`}
                          />
                        ))}
                      </div>
                      <div
                        className="absolute left-3 right-3 h-[2px] bg-gradient-to-r from-transparent via-[#6d28d9] to-transparent rounded-full"
                        style={{ animation: "scan-line 2.5s ease-in-out infinite" }}
                      />
                    </div>
                    <p className="text-[11px] text-slate-500 mt-4 font-semibold uppercase tracking-wider">
                      Scan at gate
                    </p>
                    <div className="mt-3 flex items-center justify-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-[#1a6b3c]" />
                      <span className="text-[11px] font-semibold text-[#1a6b3c]">Paid · Valid for entry</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────── */}
      <section id="how" className="relative py-20 sm:py-28 bg-[#0f1225] overflow-hidden scroll-mt-20">
        <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[300px] rounded-full bg-[#6d28d9]/10 blur-[120px]" />
          <div
            className="absolute inset-0 opacity-[0.03]"
            style={{
              backgroundImage: "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
              backgroundSize: "48px 48px",
            }}
          />
        </div>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 relative">
          <div className="text-center mb-14">
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">How it works</h2>
            <p className="font-myanmar text-[#c4b5fd] text-base sm:text-lg mt-2">အလုပ်လုပ်ပုံ</p>
            <p className="text-slate-300 mt-4 max-w-lg mx-auto leading-relaxed text-sm sm:text-base">
              From ticket sale to the front gate, in four steps.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <div
                key={s.step}
                className={`animate-fade-up delay-${(i + 1) * 100} relative rounded-2xl bg-white/[0.04] border border-white/10 p-6 hover:bg-white/[0.07] hover:border-[#a78bfa]/30 transition-all`}
              >
                <div className="w-11 h-11 rounded-xl bg-[#6d28d9]/25 border border-[#6d28d9]/30 flex items-center justify-center text-[#c4b5fd] font-extrabold text-sm">
                  {s.step}
                </div>
                <h3 className="text-base font-bold text-white mt-5">{s.titleEn}</h3>
                <p className="font-myanmar text-sm text-slate-300 mt-1">{s.titleMm}</p>
                <p className="text-sm text-slate-300 mt-3 leading-relaxed">{s.descEn}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ───────────────────────────────────────── */}
      <section className="relative py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-14 sm:mb-16">
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Everything a festival needs
            </h2>
            <p className="font-myanmar text-slate-500 text-base mt-2">ပွဲတော်တစ်ခုအတွက် လိုအပ်သမျှ</p>
          </div>

          <div className="grid gap-4 sm:gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f, i) => (
              <div
                key={f.titleEn}
                className={`animate-fade-up delay-${(i + 1) * 100} group relative rounded-2xl bg-white p-6 sm:p-7 border border-slate-100 hover:border-slate-200 transition-all duration-300 hover:shadow-[0_8px_30px_-8px_rgba(0,0,0,0.08)] hover:-translate-y-1`}
              >
                <div className="w-11 h-11 rounded-xl bg-[#6d28d9]/10 flex items-center justify-center mb-5 text-[#6d28d9] transition-transform group-hover:scale-110">
                  {f.icon}
                </div>
                <h3 className="text-[15px] font-bold text-slate-900">{f.titleEn}</h3>
                <p className="text-xs font-myanmar text-slate-500 mt-0.5">{f.titleMm}</p>
                <p className="text-sm text-slate-600 mt-3 leading-relaxed">{f.descEn}</p>
                <p className="text-xs font-myanmar text-slate-500 mt-2 leading-relaxed">{f.descMm}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Payments ───────────────────────────────────────── */}
      <section className="pb-20 sm:pb-24">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
          <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider">
            Accepted payments
            <span className="font-myanmar normal-case tracking-normal ml-2">လက်ခံသော ငွေပေးချေမှုများ</span>
          </p>
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {PAYMENT_METHODS.map((m) => (
              <div
                key={m.name}
                className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-white border border-slate-100 px-4 py-5"
              >
                <div className="flex items-center justify-center gap-2 h-10">
                  {m.logos.map((logo) => (
                    <Image
                      key={logo.src}
                      src={logo.src}
                      alt=""
                      width={logo.width}
                      height={logo.height}
                      className="h-10 w-auto object-contain"
                    />
                  ))}
                </div>
                <span className="text-xs font-semibold text-slate-700">{m.name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Also works for ─────────────────────────────────── */}
      <section className="py-16 sm:py-20 border-t border-slate-200/60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-10">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">Also works for</h2>
            <p className="font-myanmar text-slate-500 text-base mt-2">အခြားအဖွဲ့အစည်းများအတွက်လည်း</p>
            <p className="text-sm text-slate-600 mt-3 max-w-md mx-auto">
              One platform — labels adapt to your organisation type.
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-3 max-w-3xl mx-auto">
            {ALSO_FOR.map((item) => (
              <div
                key={item.en}
                className="inline-flex items-center gap-2.5 px-4 py-2.5 rounded-2xl bg-white border border-slate-100 cursor-default"
              >
                <span className="text-lg">{item.emoji}</span>
                <span className="text-sm font-semibold text-slate-800">{item.en}</span>
                <span className="text-xs font-myanmar text-slate-500">{item.mm}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA Banner ─────────────────────────────────────── */}
      <section className="pb-20 sm:pb-24">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="relative rounded-3xl bg-[#0f1225] p-10 sm:p-14 text-center overflow-hidden">
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
              <div className="absolute -top-20 left-1/3 w-72 h-72 rounded-full bg-[#6d28d9]/25 blur-[90px]" />
              <div className="absolute -bottom-20 right-1/4 w-60 h-60 rounded-full bg-[#f472b6]/10 blur-[80px]" />
            </div>

            <div className="relative">
              <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                Ready for your next festival?
              </h2>
              <p className="font-myanmar text-[#c4b5fd] text-base sm:text-lg mt-2">
                သင့်နောက်ပွဲတော်အတွက် အသင့်ဖြစ်ပြီလား?
              </p>
              <p className="text-slate-300 mt-4 max-w-md mx-auto text-sm">
                Set up your event in minutes and start selling tickets today.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                <Link
                  href="/register"
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-2xl bg-[#6d28d9] text-white font-semibold text-sm transition-all shadow-[0_0_24px_rgba(109,40,217,0.5)] hover:bg-[#5b21b6]"
                >
                  Start selling tickets
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </Link>
                <Link
                  href="/login"
                  className="w-full sm:w-auto inline-flex items-center justify-center px-7 py-3.5 rounded-2xl border border-white/15 text-slate-200 font-medium hover:bg-white/5 transition-all text-sm"
                >
                  Sign In
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="border-t border-slate-200/60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-5">
          <div className="flex items-center gap-2.5">
            <Image src="/kuunyi-logo.jpeg" alt="KuuNyi" width={24} height={24} className="rounded-lg" />
            <span className="text-sm font-bold text-slate-700">KuuNyi</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/privacy" className="text-xs text-slate-500 hover:text-slate-700 transition-colors">
              Privacy
            </Link>
            <span className="text-slate-200">|</span>
            <p className="text-xs text-slate-500">
              &copy; {new Date().getFullYear()} KuuNyi — Myanmar
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
