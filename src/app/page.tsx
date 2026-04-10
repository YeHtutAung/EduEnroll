import Link from "next/link";
import Image from "next/image";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "KuuNyi — Enrollment Management for Myanmar Organizations",
  description:
    "Online enrollment, MMQR instant payments, and records for any Myanmar organization. " +
    "Schools, events, fitness, wellness & more.",
  openGraph: {
    title: "KuuNyi — Enrollment Management for Myanmar Organizations",
    description:
      "Online enrollment, MMQR instant payments, and records for any Myanmar organization. " +
      "Schools, events, fitness, wellness & more.",
    siteName: "KuuNyi",
    locale: "my_MM",
    type: "website",
  },
  twitter: {
    title: "KuuNyi — Enrollment Management for Myanmar Organizations",
    description:
      "Online enrollment, MMQR instant payments, and records for any Myanmar organization. " +
      "Schools, events, fitness, wellness & more.",
  },
};

// ─── Feature cards data ──────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15a2.25 2.25 0 012.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
      </svg>
    ),
    titleEn: "Online Enrollment",
    titleMm: "အွန်လိုင်း စာရင်းသွင်းခြင်း",
    descEn: "Beautiful bilingual forms anyone can fill out from their phone. No paper, no queues.",
    descMm: "ဖုန်းဖြင့် ဖြည့်သွင်းနိုင်သော နှစ်ဘာသာ ပုံစံများ",
    color: "text-[#6d28d9]",
    bg: "bg-[#6d28d9]/10",
  },
  {
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5z" />
      </svg>
    ),
    titleEn: "MMQR Instant Payments",
    titleMm: "MMQR ချက်ချင်း ငွေပေးချေမှု",
    descEn: "Students scan a QR code and pay instantly with KBZ, AYA, CB, UAB, or Yoma. Auto-verified.",
    descMm: "QR ကုဒ်ဖတ်ပြီး ချက်ချင်းငွေပေးချေနိုင်ပါသည်",
    color: "text-[#1a6b3c]",
    bg: "bg-[#1a6b3c]/10",
  },
  {
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
      </svg>
    ),
    titleEn: "Student Records",
    titleMm: "ကျောင်းသား မှတ်တမ်းများ",
    descEn: "Track every participant from enrollment to completion. Search, filter, export — all in one place.",
    descMm: "စာရင်းသွင်းခြင်းမှ ပြီးဆုံးခြင်းအထိ ခြေရာခံပါ",
    color: "text-[#6d28d9]",
    bg: "bg-[#6d28d9]/10",
  },
  {
    icon: (
      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
      </svg>
    ),
    titleEn: "Telegram & Messenger",
    titleMm: "တယ်လီဂရမ် နှင့် မက်ဆင်းဂျာ",
    descEn: "Enroll, check status, and receive updates through Telegram channels and Facebook Messenger.",
    descMm: "Telegram နှင့် Messenger မှတဆင့် စာရင်းသွင်းနိုင်ပါသည်",
    color: "text-[#1a6b3c]",
    bg: "bg-[#1a6b3c]/10",
  },
];

// ─── Industries data ─────────────────────────────────────────────────────────

const INDUSTRIES = [
  { emoji: "\uD83C\uDF93", en: "Language School", mm: "သင်တန်းကျောင်း" },
  { emoji: "\uD83C\uDFAA", en: "Events", mm: "ပွဲတော်များ" },
  { emoji: "\uD83D\uDCAA", en: "Fitness", mm: "ကိုယ်ကာယကျန်းမာရေး" },
  { emoji: "\uD83D\uDC85", en: "Beauty & Wellness", mm: "အလှပြုစုရေး" },
  { emoji: "\uD83D\uDCBB", en: "Training Center", mm: "သင်တန်းဌာန" },
  { emoji: "\u2699\uFE0F", en: "Custom", mm: "စိတ်ကြိုက်သတ်မှတ်နိုင်" },
];

// ─── Banks data ──────────────────────────────────────────────────────────────

const BANKS = ["KBZ", "AYA", "CB", "UAB", "Yoma"];

// ─── MMQR flow steps ─────────────────────────────────────────────────────────

const MMQR_STEPS = [
  {
    step: "01",
    titleEn: "Student enrolls",
    titleMm: "ကျောင်းသား စာရင်းသွင်းသည်",
    descEn: "Fill out the bilingual enrollment form from any phone",
  },
  {
    step: "02",
    titleEn: "QR code appears",
    titleMm: "QR ကုဒ် ပေါ်လာသည်",
    descEn: "An MMQR code is generated for the exact enrollment fee",
  },
  {
    step: "03",
    titleEn: "Scan & pay",
    titleMm: "ဖတ်ပြီး ငွေပေးချေပါ",
    descEn: "Open any banking app — KBZ, AYA, CB, UAB, Yoma — and scan",
  },
  {
    step: "04",
    titleEn: "Auto-verified",
    titleMm: "အလိုအလျောက် အတည်ပြုပြီး",
    descEn: "Payment is confirmed instantly. No manual checking needed.",
  },
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
        @keyframes slideLeft {
          from { opacity: 0; transform: translateX(40px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes pulse-glow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(109, 40, 217, 0.3); }
          50% { box-shadow: 0 0 0 12px rgba(109, 40, 217, 0); }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-8px); }
        }
        @keyframes scan-line {
          0% { top: 0; }
          50% { top: calc(100% - 3px); }
          100% { top: 0; }
        }
        .animate-fade-up {
          animation: fadeUp 0.7s ease-out both;
        }
        .animate-fade-in {
          animation: fadeIn 0.6s ease-out both;
        }
        .animate-slide-left {
          animation: slideLeft 0.7s ease-out both;
        }
        .animate-float {
          animation: float 4s ease-in-out infinite;
        }
        .delay-100 { animation-delay: 100ms; }
        .delay-200 { animation-delay: 200ms; }
        .delay-300 { animation-delay: 300ms; }
        .delay-400 { animation-delay: 400ms; }
        .delay-500 { animation-delay: 500ms; }
        .delay-600 { animation-delay: 600ms; }
        .delay-700 { animation-delay: 700ms; }
      `}</style>

      {/* ── Navbar ──────────────────────────────────────────── */}
      <header className="fixed top-0 left-0 right-0 z-50 animate-fade-in">
        <div className="mx-4 sm:mx-6 mt-3">
          <div className="max-w-6xl mx-auto flex items-center justify-between px-5 sm:px-6 h-14 rounded-2xl bg-white/70 backdrop-blur-xl border border-white/40 shadow-[0_2px_20px_-4px_rgba(0,0,0,0.06)]">
            <Link href="/" className="flex items-center gap-2.5 group">
              <Image
                src="/kuunyi-logo.jpeg"
                alt="KuuNyi"
                width={30}
                height={30}
                className="rounded-lg shrink-0 group-hover:scale-105 transition-transform"
              />
              <span className="text-[15px] font-bold text-slate-900 tracking-tight">KuuNyi</span>
            </Link>
            <nav className="flex items-center gap-2">
              <Link
                href="/login"
                className="text-sm font-medium text-slate-600 hover:text-slate-900 px-4 py-2 rounded-xl hover:bg-slate-100/60 transition-all"
              >
                Sign In
              </Link>
              <Link
                href="/register"
                className="text-sm font-semibold text-white bg-[#6d28d9] hover:bg-[#5b21b6] px-5 py-2 rounded-xl transition-all shadow-[0_1px_3px_rgba(109,40,217,0.3)] hover:shadow-[0_4px_12px_rgba(109,40,217,0.25)]"
              >
                Get Started
              </Link>
            </nav>
          </div>
        </div>
      </header>

      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="relative pt-28 sm:pt-36 pb-20 sm:pb-28 overflow-hidden">
        {/* Background decoration */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-20 -right-32 w-[500px] h-[500px] rounded-full bg-[#6d28d9]/[0.04] blur-3xl" />
          <div className="absolute -bottom-20 -left-32 w-[400px] h-[400px] rounded-full bg-[#1a6b3c]/[0.04] blur-3xl" />
          {/* Geometric accents */}
          <div className="absolute top-32 left-[10%] w-3 h-3 rotate-45 bg-[#6d28d9]/20 rounded-sm animate-float" />
          <div className="absolute top-48 right-[15%] w-2 h-2 rotate-45 bg-[#1a6b3c]/25 rounded-sm animate-float delay-300" />
          <div className="absolute bottom-32 left-[20%] w-2.5 h-2.5 rotate-45 bg-[#6d28d9]/15 rounded-sm animate-float delay-500" />
        </div>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 relative">
          <div className="max-w-3xl mx-auto text-center">
            {/* Badge */}
            <div className="animate-fade-up inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-white border border-slate-200/80 shadow-[0_1px_6px_-1px_rgba(0,0,0,0.06)] mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-[#1a6b3c] animate-pulse" />
              <span className="text-xs font-semibold text-slate-700 tracking-wide uppercase">
                Now with MMQR Payments
              </span>
              <span className="text-xs font-myanmar text-slate-400">MMQR ငွေပေးချေမှု</span>
            </div>

            {/* Headline */}
            <h1 className="animate-fade-up delay-100">
              <span className="block text-4xl sm:text-6xl font-extrabold text-slate-900 tracking-tight leading-[1.1]">
                Enrollment made
                <span className="relative inline-block ml-3">
                  <span className="relative z-10 text-[#6d28d9]">effortless</span>
                  <span className="absolute bottom-1 sm:bottom-2 left-0 right-0 h-3 sm:h-4 bg-[#6d28d9]/10 -skew-x-3 rounded" />
                </span>
              </span>
              <span className="block font-myanmar text-xl sm:text-2xl text-slate-500 mt-4 sm:mt-5 leading-relaxed font-medium">
                မည်သည့်အဖွဲ့အစည်းအတွက်မဆို စာရင်းသွင်းစနစ်
              </span>
            </h1>

            {/* Subheadline */}
            <p className="animate-fade-up delay-200 mt-6 sm:mt-8 text-base sm:text-lg text-slate-500 max-w-xl mx-auto leading-relaxed">
              Forms, MMQR payments, records, and Telegram — everything Myanmar organizations need.
              Bilingual. Mobile-first. Instant.
            </p>

            {/* CTAs */}
            <div className="animate-fade-up delay-300 mt-8 sm:mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link
                href="/register"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-7 py-3.5 rounded-2xl bg-[#6d28d9] text-white font-semibold text-sm transition-all shadow-[0_2px_8px_rgba(109,40,217,0.3)] hover:shadow-[0_8px_24px_rgba(109,40,217,0.25)] hover:bg-[#5b21b6] active:scale-[0.98]"
              >
                <span>Start Free</span>
                <span className="font-myanmar font-normal opacity-80">အခမဲ့ စတင်ပါ</span>
                <svg className="w-4 h-4 ml-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
              </Link>
              <Link
                href="#mmqr"
                className="w-full sm:w-auto inline-flex items-center justify-center px-7 py-3.5 rounded-2xl border border-slate-200 bg-white text-slate-700 font-medium hover:border-slate-300 hover:shadow-sm transition-all text-sm"
              >
                See MMQR in action
              </Link>
            </div>

            {/* Trust line */}
            <p className="animate-fade-up delay-400 mt-8 text-xs text-slate-400 font-medium">
              Free for Myanmar organizations
              <span className="font-myanmar ml-2">မြန်မာ အဖွဲ့အစည်းများအတွက် အခမဲ့</span>
            </p>
          </div>
        </div>
      </section>

      {/* ── Features ───────────────────────────────────────── */}
      <section id="features" className="relative py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-14 sm:mb-16">
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Everything you need
            </h2>
            <p className="font-myanmar text-slate-400 text-base mt-2">
              လိုအပ်သမျှ အားလုံးပါဝင်ပြီးသား
            </p>
          </div>

          <div className="grid gap-4 sm:gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f, i) => (
              <div
                key={f.titleEn}
                className={`animate-fade-up delay-${(i + 1) * 100} group relative rounded-2xl bg-white p-6 sm:p-7 border border-slate-100 hover:border-slate-200 transition-all duration-300 hover:shadow-[0_8px_30px_-8px_rgba(0,0,0,0.08)] hover:-translate-y-1`}
              >
                <div className={`w-11 h-11 rounded-xl ${f.bg} flex items-center justify-center mb-5 ${f.color} transition-transform group-hover:scale-110`}>
                  {f.icon}
                </div>
                <h3 className="text-[15px] font-bold text-slate-900">{f.titleEn}</h3>
                <p className="text-xs font-myanmar text-slate-400 mt-0.5">{f.titleMm}</p>
                <p className="text-sm text-slate-500 mt-3 leading-relaxed">{f.descEn}</p>
                <p className="text-xs font-myanmar text-slate-400 mt-2 leading-relaxed">{f.descMm}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── MMQR Showcase ──────────────────────────────────── */}
      <section id="mmqr" className="relative py-20 sm:py-28 bg-[#0f1225] overflow-hidden">
        {/* Decorative bg */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] rounded-full bg-[#6d28d9]/10 blur-[120px]" />
          <div className="absolute bottom-0 right-0 w-[300px] h-[300px] rounded-full bg-[#1a6b3c]/8 blur-[80px]" />
          {/* Grid overlay */}
          <div
            className="absolute inset-0 opacity-[0.03]"
            style={{
              backgroundImage: "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
              backgroundSize: "48px 48px",
            }}
          />
        </div>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 relative">
          {/* Header */}
          <div className="text-center mb-14 sm:mb-18">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#6d28d9]/20 border border-[#6d28d9]/20 mb-6">
              <span className="text-xs font-bold text-[#a78bfa] tracking-wide uppercase">New Feature</span>
              <span className="text-xs font-myanmar text-[#a78bfa]/70">လုပ်ဆောင်ချက်အသစ်</span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
              MMQR Instant Payments
            </h2>
            <p className="font-myanmar text-[#a78bfa]/60 text-base sm:text-lg mt-2">
              MMQR ချက်ချင်း ငွေပေးချေမှုစနစ်
            </p>
            <p className="text-slate-400 mt-4 max-w-lg mx-auto leading-relaxed text-sm sm:text-base">
              Students scan, pay, and you&apos;re done. No more chasing screenshots or manual verification.
            </p>
          </div>

          {/* MMQR flow + phone mockup */}
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            {/* Left: Steps */}
            <div className="space-y-6 sm:space-y-8">
              {MMQR_STEPS.map((s, i) => (
                <div
                  key={s.step}
                  className={`animate-slide-left delay-${(i + 1) * 100} flex gap-4 sm:gap-5 group`}
                >
                  <div className="shrink-0 w-12 h-12 rounded-2xl bg-[#6d28d9]/20 border border-[#6d28d9]/20 flex items-center justify-center text-[#a78bfa] font-extrabold text-sm group-hover:bg-[#6d28d9]/30 transition-colors">
                    {s.step}
                  </div>
                  <div>
                    <h3 className="text-base sm:text-lg font-bold text-white">
                      {s.titleEn}
                      <span className="font-myanmar font-normal text-slate-500 text-sm ml-2">
                        {s.titleMm}
                      </span>
                    </h3>
                    <p className="text-sm text-slate-400 mt-1 leading-relaxed">{s.descEn}</p>
                  </div>
                </div>
              ))}

              {/* Bank pills */}
              <div className="pt-4">
                <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-3">
                  Supported Banks
                  <span className="font-myanmar normal-case tracking-normal ml-2">ပံ့ပိုးသော ဘဏ်များ</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  {BANKS.map((bank) => (
                    <span
                      key={bank}
                      className="px-3.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm font-semibold text-slate-300 hover:bg-white/10 transition-colors"
                    >
                      {bank}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Right: Phone mockup with QR */}
            <div className="flex justify-center lg:justify-end">
              <div className="animate-float relative">
                {/* Phone frame */}
                <div className="w-[260px] sm:w-[280px] rounded-[2.5rem] bg-gradient-to-b from-slate-800 to-slate-900 p-3 shadow-[0_0_60px_-10px_rgba(109,40,217,0.3)]">
                  {/* Notch */}
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-28 h-6 bg-slate-900 rounded-b-2xl z-10" />
                  {/* Screen */}
                  <div className="rounded-[2rem] bg-white overflow-hidden">
                    {/* Status bar */}
                    <div className="h-10 bg-[#6d28d9] flex items-end justify-center pb-1.5">
                      <span className="text-[10px] font-bold text-white/90 tracking-wide">KuuNyi Pay</span>
                    </div>
                    {/* Content */}
                    <div className="px-5 py-6 text-center">
                      <p className="text-[11px] text-slate-500 font-medium">Enrollment Fee</p>
                      <p className="text-2xl font-extrabold text-slate-900 mt-1">50,000 <span className="text-sm font-bold text-slate-400">MMK</span></p>

                      {/* QR mock */}
                      <div className="relative mt-5 mx-auto w-36 h-36 rounded-2xl bg-slate-50 border-2 border-dashed border-slate-200 flex items-center justify-center">
                        {/* QR pattern */}
                        <div className="grid grid-cols-7 gap-[3px] w-24 h-24">
                          {Array.from({ length: 49 }).map((_, i) => {
                            const isCorner =
                              (i < 3 || (i >= 4 && i < 7) || (i >= 7 && i < 10) || i === 14 || i === 20 ||
                              (i >= 35 && i < 38) || i === 42 || (i >= 43 && i < 46) || (i >= 46 && i < 49));
                            const isCenter = i === 24;
                            return (
                              <div
                                key={i}
                                className={`rounded-[2px] ${
                                  isCenter
                                    ? "bg-[#6d28d9]"
                                    : isCorner
                                      ? "bg-slate-800"
                                      : Math.random() > 0.4
                                        ? "bg-slate-700"
                                        : "bg-transparent"
                                }`}
                              />
                            );
                          })}
                        </div>
                        {/* Scan line */}
                        <div
                          className="absolute left-2 right-2 h-[2px] bg-gradient-to-r from-transparent via-[#6d28d9] to-transparent rounded-full"
                          style={{ animation: "scan-line 2.5s ease-in-out infinite" }}
                        />
                      </div>

                      <p className="text-[10px] text-slate-400 mt-3 font-medium">
                        Scan with any banking app
                      </p>
                      <p className="text-[9px] font-myanmar text-slate-400 mt-0.5">
                        မည်သည့် ဘဏ်အက်ပ်ဖြင့်မဆို ဖတ်ပါ
                      </p>

                      {/* Bottom status */}
                      <div className="mt-5 flex items-center justify-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-[#1a6b3c] animate-pulse" />
                        <span className="text-[10px] font-semibold text-[#1a6b3c]">Waiting for payment...</span>
                      </div>
                    </div>
                  </div>
                </div>
                {/* Glow ring */}
                <div className="absolute -inset-3 rounded-[3rem] border border-[#6d28d9]/10" style={{ animation: "pulse-glow 3s ease-in-out infinite" }} />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Industries ─────────────────────────────────────── */}
      <section className="py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Built for every industry
            </h2>
            <p className="font-myanmar text-slate-400 text-base mt-2">
              မည်သည့်လုပ်ငန်းနယ်ပယ်အတွက်မဆို
            </p>
            <p className="text-sm text-slate-500 mt-3 max-w-md mx-auto">
              One platform, any organization. Pick your type and labels adapt automatically.
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-3 max-w-2xl mx-auto">
            {INDUSTRIES.map((ind, i) => (
              <div
                key={ind.en}
                className={`animate-fade-up delay-${(i + 1) * 100} inline-flex items-center gap-2.5 px-5 py-3 rounded-2xl bg-white border border-slate-100 hover:border-slate-200 hover:shadow-sm transition-all cursor-default`}
              >
                <span className="text-xl">{ind.emoji}</span>
                <span className="text-sm font-semibold text-slate-800">{ind.en}</span>
                <span className="text-xs font-myanmar text-slate-400">{ind.mm}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Built for Myanmar ──────────────────────────────── */}
      <section className="relative py-20 sm:py-28 bg-gradient-to-b from-[#faf9f7] to-[#f3f1ed]">
        {/* Subtle top pattern */}
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />

        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-14">
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Built for Myanmar
            </h2>
            <p className="font-myanmar text-slate-400 text-base mt-2">
              မြန်မာနိုင်ငံအတွက် တည်ဆောက်ထားသည်
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4 max-w-4xl mx-auto">
            {[
              {
                icon: (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 01-3.827-5.802" />
                  </svg>
                ),
                label: "Bilingual UI",
                labelMm: "နှစ်ဘာသာ",
                desc: "Myanmar + English throughout",
                color: "text-[#6d28d9]",
                bg: "bg-[#6d28d9]/10",
              },
              {
                icon: (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5z" />
                  </svg>
                ),
                label: "MMQR Payments",
                labelMm: "MMQR ငွေပေးချေ",
                desc: "KBZ, AYA, CB, UAB, Yoma",
                color: "text-[#1a6b3c]",
                bg: "bg-[#1a6b3c]/10",
              },
              {
                icon: (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
                  </svg>
                ),
                label: "Mobile First",
                labelMm: "မိုဘိုင်းဦးစား",
                desc: "Enroll from any phone",
                color: "text-[#6d28d9]",
                bg: "bg-[#6d28d9]/10",
              },
              {
                icon: (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                  </svg>
                ),
                label: "Telegram & Messenger",
                labelMm: "တယ်လီဂရမ် & မက်ဆင်းဂျာ",
                desc: "Chatbot included out of the box",
                color: "text-[#1a6b3c]",
                bg: "bg-[#1a6b3c]/10",
              },
            ].map((item) => (
              <div
                key={item.label}
                className="group flex flex-col items-center text-center p-6 rounded-2xl bg-white border border-slate-100 hover:border-slate-200 hover:shadow-sm transition-all"
              >
                <div className={`w-11 h-11 rounded-xl ${item.bg} flex items-center justify-center ${item.color} mb-4 group-hover:scale-110 transition-transform`}>
                  {item.icon}
                </div>
                <p className="text-sm font-bold text-slate-900">{item.label}</p>
                <p className="text-xs font-myanmar text-slate-400 mt-0.5">{item.labelMm}</p>
                <p className="text-sm text-slate-500 mt-2">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA Banner ─────────────────────────────────────── */}
      <section className="py-20 sm:py-24">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="relative rounded-3xl bg-[#0f1225] p-10 sm:p-14 text-center overflow-hidden">
            {/* Decorative */}
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute top-0 left-1/3 w-60 h-60 rounded-full bg-[#6d28d9]/15 blur-[80px]" />
              <div className="absolute bottom-0 right-1/4 w-48 h-48 rounded-full bg-[#1a6b3c]/10 blur-[60px]" />
            </div>

            <div className="relative">
              <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                Ready to simplify enrollment?
              </h2>
              <p className="font-myanmar text-[#a78bfa]/60 text-base sm:text-lg mt-2">
                စာရင်းသွင်းခြင်းကို ရိုးရှင်းလွယ်ကူအောင် လုပ်ဆောင်ပါ
              </p>
              <p className="text-slate-400 mt-4 max-w-md mx-auto text-sm">
                Set up your organization in minutes. Start collecting enrollments today.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                <Link
                  href="/register"
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5 rounded-2xl bg-[#6d28d9] text-white font-semibold text-sm transition-all shadow-[0_2px_8px_rgba(109,40,217,0.3)] hover:shadow-[0_8px_24px_rgba(109,40,217,0.25)] hover:bg-[#5b21b6]"
                >
                  Get Started Free
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                  </svg>
                </Link>
                <Link
                  href="/login"
                  className="w-full sm:w-auto inline-flex items-center justify-center px-7 py-3.5 rounded-2xl border border-white/10 text-slate-300 font-medium hover:bg-white/5 transition-all text-sm"
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
            <Link href="/privacy" className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
              Privacy
            </Link>
            <span className="text-slate-200">|</span>
            <p className="text-xs text-slate-400">
              &copy; {new Date().getFullYear()} KuuNyi — Myanmar
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
