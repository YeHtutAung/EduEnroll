import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "KuuNyi — Enrollment Management for Myanmar Organizations",
  description:
    "Online enrollment, payment verification, and records for any Myanmar organization. " +
    "Schools, events, fitness, wellness & more.",
  openGraph: {
    title: "KuuNyi — Enrollment Management for Myanmar Organizations",
    description:
      "Online enrollment, payment verification, and records for any Myanmar organization. " +
      "Schools, events, fitness, wellness & more.",
    siteName: "KuuNyi",
    locale: "my_MM",
    type: "website",
  },
  twitter: {
    title: "KuuNyi — Enrollment Management for Myanmar Organizations",
    description:
      "Online enrollment, payment verification, and records for any Myanmar organization. " +
      "Schools, events, fitness, wellness & more.",
  },
};

// ─── Feature cards data ──────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: (
      <svg className="w-8 h-8 text-[#6d28d9]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15a2.25 2.25 0 012.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
      </svg>
    ),
    titleEn: "Online Enrollment Forms",
    titleMm: "အွန်လိုင်း စာရင်းသွင်းပုံစံ",
    descEn: "Beautiful bilingual forms anyone can fill out from their phone. No paper, no queues.",
    descMm: "ဖုန်းဖြင့် ဖြည့်သွင်းနိုင်သော နှစ်ဘာသာ ပုံစံများ",
  },
  {
    icon: (
      <svg className="w-8 h-8 text-[#1a6b3c]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
      </svg>
    ),
    titleEn: "Payment Verification",
    titleMm: "ငွေပေးချေမှု အတည်ပြုခြင်း",
    descEn: "Participants upload payment proof. Admins verify with one click. KBZ, AYA, CB supported.",
    descMm: "ငွေလွှဲပြေစာ တင်ပြနိုင်ပြီး အက်မင်က တစ်ချက်နှိပ်ရုံဖြင့် အတည်ပြုနိုင်ပါသည်",
  },
  {
    icon: (
      <svg className="w-8 h-8 text-[#6d28d9]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
      </svg>
    ),
    titleEn: "Records",
    titleMm: "မှတ်တမ်းများ",
    descEn: "Track every participant from enrollment to completion. Search, filter, export — all in one place.",
    descMm: "စာရင်းသွင်းခြင်းမှ ပြီးဆုံးခြင်းအထိ အားလုံးကို ခြေရာခံပါ",
  },
  {
    icon: (
      <svg className="w-8 h-8 text-[#1a6b3c]" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
      </svg>
    ),
    titleEn: "Messenger Chatbot",
    titleMm: "မက်ဆင်းဂျာ ချတ်ဘော့",
    descEn: "Enroll and check status directly via Facebook Messenger. No app download required.",
    descMm: "Facebook Messenger မှတဆင့် စာရင်းသွင်းနိုင်ပြီး အခြေအနေ စစ်ဆေးနိုင်ပါသည်",
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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* ── Navbar ──────────────────────────────────────────── */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-4 sm:px-6 h-14">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#6d28d9] flex items-center justify-center shrink-0">
              <span className="text-white font-bold text-sm select-none">K</span>
            </div>
            <span className="text-base font-bold text-slate-900">KuuNyi</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-slate-400 cursor-not-allowed">
              Sign In
            </span>
            <span className="text-sm font-semibold text-white bg-[#6d28d9]/50 px-4 py-2 rounded-lg cursor-not-allowed select-none">
              Coming Soon
            </span>
          </div>
        </div>
      </header>

      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-16 sm:pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#6d28d9]/10 text-[#6d28d9] text-xs font-semibold mb-6">
          <span>Free for Myanmar organizations</span>
          <span className="font-myanmar text-[#1a6b3c]">မြန်မာ အဖွဲ့အစည်းများအတွက်</span>
        </div>

        <h1 className="text-3xl sm:text-5xl font-bold text-slate-900 leading-tight max-w-3xl mx-auto">
          <span className="text-[#6d28d9]">KuuNyi</span>
          <span className="block font-myanmar text-2xl sm:text-3xl text-slate-700 mt-3 leading-snug">
            မည်သည့်အဖွဲ့အစည်းအတွက်မဆို စာရင်းသွင်းစနစ်
          </span>
        </h1>

        <p className="mt-6 text-base sm:text-lg text-slate-600 max-w-2xl mx-auto leading-relaxed">
          Enrollment management built for any Myanmar organization.
          Online forms, payment verification, and records — all bilingual, all mobile-friendly.
        </p>

        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <span className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-[#6d28d9]/50 text-white font-semibold cursor-not-allowed select-none text-sm">
            <span>Coming Soon</span>
            <span className="font-myanmar font-normal opacity-90">/ မကြာမီ လာမည်</span>
          </span>
          <Link
            href="#features"
            className="w-full sm:w-auto inline-flex items-center justify-center px-6 py-3 rounded-lg border border-slate-300 text-slate-700 font-medium hover:bg-slate-50 transition-colors text-sm"
          >
            Learn More
          </Link>
        </div>
      </section>

      {/* ── Features ───────────────────────────────────────── */}
      <section id="features" className="max-w-5xl mx-auto px-4 sm:px-6 pb-20">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div
              key={f.titleEn}
              className="rounded-2xl border border-slate-200 bg-white p-6 hover:shadow-md transition-shadow"
            >
              <div className="w-12 h-12 rounded-xl bg-slate-50 flex items-center justify-center mb-4">
                {f.icon}
              </div>
              <h3 className="text-base font-semibold text-slate-900">{f.titleEn}</h3>
              <p className="text-sm font-myanmar text-slate-500 mt-0.5">{f.titleMm}</p>
              <p className="text-sm text-slate-600 mt-3 leading-relaxed">{f.descEn}</p>
              <p className="text-xs font-myanmar text-slate-400 mt-1.5 leading-relaxed">{f.descMm}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Industries ─────────────────────────────────────── */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 pb-20 text-center">
        <h2 className="text-xl sm:text-2xl font-bold text-slate-900">
          Built for Every Industry
        </h2>
        <p className="font-myanmar text-slate-500 text-base mt-1">
          မည်သည့်လုပ်ငန်းနယ်ပယ်အတွက်မဆို
        </p>
        <p className="text-sm text-slate-600 mt-3 max-w-lg mx-auto">
          One platform, any organization. Just pick your type and your labels adapt automatically.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {INDUSTRIES.map((ind) => (
            <div
              key={ind.en}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full border border-slate-200 bg-white hover:shadow-sm transition-shadow"
            >
              <span className="text-lg">{ind.emoji}</span>
              <span className="text-sm font-medium text-slate-800">{ind.en}</span>
              <span className="text-xs font-myanmar text-slate-400">{ind.mm}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── Built for Myanmar ──────────────────────────────── */}
      <section className="bg-slate-50 border-t border-slate-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16 text-center">
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900">
            Built for Myanmar
            <span className="font-myanmar text-slate-500 text-base sm:text-lg ml-2">
              မြန်မာနိုင်ငံအတွက် တည်ဆောက်ထားသည်
            </span>
          </h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4 text-left">
            {[
              { label: "Bilingual UI", labelMm: "နှစ်ဘာသာ", desc: "Myanmar + English throughout" },
              { label: "MMK Payments", labelMm: "မြန်မာကျပ်", desc: "KBZ, AYA, CB, UAB, Yoma" },
              { label: "Mobile First", labelMm: "မိုဘိုင်းဦးစား", desc: "Enroll from any phone" },
              { label: "Messenger Ready", labelMm: "မက်ဆင်းဂျာ အသင့်", desc: "Facebook Messenger chatbot included out of the box." },
            ].map((item) => (
              <div key={item.label} className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-[#1a6b3c]/10 flex items-center justify-center shrink-0 mt-0.5">
                  <svg className="w-4 h-4 text-[#1a6b3c]" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {item.label}
                    <span className="font-myanmar font-normal text-slate-400 ml-1.5">{item.labelMm}</span>
                  </p>
                  <p className="text-sm text-slate-500 mt-0.5">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-[#6d28d9] flex items-center justify-center">
              <span className="text-white font-bold text-xs select-none">K</span>
            </div>
            <span className="text-sm font-semibold text-slate-700">KuuNyi</span>
          </div>
          <p className="text-xs text-slate-400">
            &copy; {new Date().getFullYear()} KuuNyi — Myanmar
          </p>
        </div>
      </footer>
    </div>
  );
}
