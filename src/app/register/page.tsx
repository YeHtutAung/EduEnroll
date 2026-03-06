"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterPage() {
  const router = useRouter();

  const [schoolNameEn, setSchoolNameEn] = useState("");
  const [schoolNameMm, setSchoolNameMm] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [slugStatus, setSlugStatus] = useState<"idle" | "checking" | "available" | "taken">("idle");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ en: string; mm: string } | null>(null);

  // ─── Live subdomain availability check ──────────────────────────────────────

  const checkSubdomain = useCallback(async (slug: string) => {
    if (!slug || slug.length < 2) {
      setSlugStatus("idle");
      return;
    }
    setSlugStatus("checking");
    try {
      const res = await fetch(`/api/saas/check-subdomain?slug=${encodeURIComponent(slug)}`);
      if (!res.ok) {
        setSlugStatus("idle");
        return;
      }
      const data = await res.json();
      setSlugStatus(data.available ? "available" : "taken");
    } catch {
      setSlugStatus("idle");
    }
  }, []);

  useEffect(() => {
    if (!subdomain || subdomain.length < 2) {
      setSlugStatus("idle");
      return;
    }
    const timer = setTimeout(() => checkSubdomain(subdomain), 500);
    return () => clearTimeout(timer);
  }, [subdomain, checkSubdomain]);

  // ─── Normalize subdomain input ──────────────────────────────────────────────

  function handleSubdomainChange(value: string) {
    const normalized = value.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+/, "");
    setSubdomain(normalized);
  }

  // ─── Submit ─────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError({
        en: "Passwords do not match.",
        mm: "စကားဝှက်များ မတူညီပါ။",
      });
      return;
    }

    if (password.length < 6) {
      setError({
        en: "Password must be at least 6 characters.",
        mm: "စကားဝှက် အနည်းဆုံး ၆ လုံး ရှိရပါမည်။",
      });
      return;
    }

    if (slugStatus === "taken") {
      setError({
        en: "This subdomain is already taken. Please choose another.",
        mm: "ဤ subdomain ကို အသုံးပြုပြီးဖြစ်သည်။ အခြားတစ်ခု ရွေးပါ။",
      });
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch("/api/saas/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          school_name_en: schoolNameEn.trim(),
          school_name_mm: schoolNameMm.trim(),
          subdomain: subdomain.trim(),
          admin_email: adminEmail.trim(),
          password,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError({
          en: body?.error ?? "Registration failed. Please try again.",
          mm: body?.error_mm ?? "မှတ်ပုံတင်ခြင်း မအောင်မြင်ပါ။ နောက်မှ ထပ်ကြိုးစားပါ။",
        });
        setSubmitting(false);
        return;
      }

      router.push("/onboarding");
    } catch {
      setError({
        en: "Something went wrong. Please try again.",
        mm: "တစ်ခုခု မှားယွင်းသွားသည်။ နောက်မှ ထပ်ကြိုးစားပါ။",
      });
      setSubmitting(false);
    }
  }

  // ─── Slug badge ─────────────────────────────────────────────────────────────

  function SlugBadge() {
    if (slugStatus === "checking") {
      return (
        <span className="text-xs text-slate-400 flex items-center gap-1">
          <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Checking…
        </span>
      );
    }
    if (slugStatus === "available") {
      return <span className="text-xs text-green-600 font-medium">&#10003; Available</span>;
    }
    if (slugStatus === "taken") {
      return <span className="text-xs text-red-600 font-medium">&#10007; Taken</span>;
    }
    return null;
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── Navbar ──────────────────────────────────────────── */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-4 sm:px-6 h-14">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#6d28d9] flex items-center justify-center shrink-0">
              <span className="text-white font-bold text-sm select-none">E</span>
            </div>
            <span className="text-base font-bold text-slate-900">EduEnroll</span>
          </Link>
          <Link
            href="/login"
            className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
          >
            Sign In
          </Link>
        </div>
      </header>

      {/* ── Form card ──────────────────────────────────────── */}
      <main className="max-w-lg mx-auto px-4 py-12 sm:py-16">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Register Your School</h1>
          <p className="text-sm font-myanmar text-slate-500 mt-1">
            သင်တန်းကျောင်း မှတ်ပုံတင်ပါ
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8">
          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            {/* School Name English */}
            <div>
              <label htmlFor="schoolNameEn" className="block text-sm font-medium text-slate-700">
                School Name (English) <span className="text-red-500">*</span>
              </label>
              <input
                id="schoolNameEn"
                type="text"
                required
                value={schoolNameEn}
                onChange={(e) => setSchoolNameEn(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#6d28d9] focus:border-transparent transition"
                placeholder="e.g. Nihon Moment"
              />
            </div>

            {/* School Name Myanmar */}
            <div>
              <label htmlFor="schoolNameMm" className="block text-sm font-medium text-slate-700">
                School Name (Myanmar){" "}
                <span className="font-myanmar font-normal text-slate-400">/ ကျောင်းအမည်</span>{" "}
                <span className="text-red-500">*</span>
              </label>
              <input
                id="schoolNameMm"
                type="text"
                required
                value={schoolNameMm}
                onChange={(e) => setSchoolNameMm(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 font-myanmar placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#6d28d9] focus:border-transparent transition"
                placeholder="ဥပမာ - နီဟွန်းမိုးမန့်"
              />
            </div>

            {/* Subdomain */}
            <div>
              <label htmlFor="subdomain" className="block text-sm font-medium text-slate-700">
                Subdomain <span className="text-red-500">*</span>
              </label>
              <div className="mt-1.5 flex items-stretch">
                <input
                  id="subdomain"
                  type="text"
                  required
                  value={subdomain}
                  onChange={(e) => handleSubdomainChange(e.target.value)}
                  className="flex-1 rounded-l-lg border border-r-0 border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#6d28d9] focus:border-transparent transition"
                  placeholder="your-school"
                />
                <span className="inline-flex items-center px-3 rounded-r-lg border border-l-0 border-slate-300 bg-slate-50 text-sm text-slate-500">
                  .kuunyi.com
                </span>
              </div>
              <div className="mt-1.5 min-h-[1.25rem]">
                <SlugBadge />
              </div>
            </div>

            {/* Admin Email */}
            <div>
              <label htmlFor="adminEmail" className="block text-sm font-medium text-slate-700">
                Admin Email{" "}
                <span className="font-myanmar font-normal text-slate-400">/ အီးမေးလ်</span>{" "}
                <span className="text-red-500">*</span>
              </label>
              <input
                id="adminEmail"
                type="email"
                required
                autoComplete="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#6d28d9] focus:border-transparent transition"
                placeholder="admin@your-school.com"
              />
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                Password{" "}
                <span className="font-myanmar font-normal text-slate-400">/ စကားဝှက်</span>{" "}
                <span className="text-red-500">*</span>
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#6d28d9] focus:border-transparent transition"
                placeholder="Min 6 characters"
              />
            </div>

            {/* Confirm Password */}
            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-700">
                Confirm Password{" "}
                <span className="font-myanmar font-normal text-slate-400">/ စကားဝှက် အတည်ပြုပါ</span>{" "}
                <span className="text-red-500">*</span>
              </label>
              <input
                id="confirmPassword"
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#6d28d9] focus:border-transparent transition"
                placeholder="Re-enter password"
              />
            </div>

            {/* Error */}
            {error && (
              <div
                role="alert"
                className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm"
              >
                <p className="text-red-700 font-medium">{error.en}</p>
                <p className="text-red-600 font-myanmar mt-0.5">{error.mm}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={submitting || slugStatus === "taken"}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-[#6d28d9] px-4 py-3 text-sm font-semibold text-white hover:bg-[#5b21b6] focus:outline-none focus:ring-2 focus:ring-[#6d28d9] focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? (
                <>
                  <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span>Registering…</span>
                </>
              ) : (
                <>
                  <span>Register Free</span>
                  <span className="font-myanmar font-normal opacity-80">/ အခမဲ့ မှတ်ပုံတင်ပါ</span>
                </>
              )}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link href="/login" className="text-[#6d28d9] font-medium hover:underline">
              Sign In
            </Link>
          </p>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          EduEnroll &copy; {new Date().getFullYear()} — Myanmar
        </p>
      </main>
    </div>
  );
}
