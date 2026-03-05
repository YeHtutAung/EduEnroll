"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const ERRORS: Record<string, { en: string; mm: string }> = {
  invalid_credentials: {
    en: "Invalid email or password.",
    mm: "အီးမေးလ် သို့မဟုတ် စကားဝှက် မှားယွင်းနေသည်။",
  },
  wrong_tenant: {
    en: "Your account does not belong to this school.",
    mm: "သင့်အကောင့်သည် ဤကျောင်းနှင့် သက်ဆိုင်မှုမရှိပါ။",
  },
  default: {
    en: "Something went wrong. Please try again.",
    mm: "တစ်ခုခု မှားယွင်းသွားသည်။ နောက်မှ ထပ်ကြိုးစားပါ။",
  },
};

interface LoginFormProps {
  schoolName: string;
  schoolNameMm: string | null;
  tenantSlug: string | null;
}

export default function LoginForm({ schoolName, schoolNameMm, tenantSlug }: LoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ en: string; mm: string } | null>(null);

  const isGeneric = schoolName === "EduEnroll Admin";
  const avatarLetter = schoolName.charAt(0).toUpperCase();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      const isInvalid =
        authError.message.toLowerCase().includes("invalid") ||
        authError.status === 400;
      setError(isInvalid ? ERRORS.invalid_credentials : ERRORS.default);
      setLoading(false);
      return;
    }

    // Check if the user is a superadmin — they bypass tenant verification
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();
    let isSuperadmin = false;
    if (authUser) {
      const { data: profile } = await supabase
        .from("users")
        .select("role")
        .eq("id", authUser.id)
        .single();
      if (profile?.role === "superadmin") isSuperadmin = true;
    }

    // Verify the user belongs to this tenant before allowing access
    if (tenantSlug && !isSuperadmin) {
      try {
        const verifyRes = await fetch("/api/auth/verify-tenant");
        if (verifyRes.status === 403) {
          await supabase.auth.signOut();
          setError(ERRORS.wrong_tenant);
          setLoading(false);
          return;
        }
      } catch {
        // If verification fails for network reasons, allow through —
        // the admin layout will catch tenant mismatches as a safety net.
      }
    }

    // Superadmin goes to /superadmin, regular users to /admin/dashboard
    if (isSuperadmin) {
      router.push("/superadmin");
    } else {
      router.push("/admin/dashboard");
    }
    router.refresh();
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md">

        {/* School identity */}
        <div className="mb-8 text-center">
          <div className={`inline-flex items-center justify-center w-14 h-14 rounded-full mb-4 ${isGeneric ? "bg-[#6d28d9]" : "bg-red-700"}`}>
            <span className="text-white text-2xl font-bold select-none">
              {isGeneric ? "E" : avatarLetter}
            </span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 leading-tight">
            {schoolName}
          </h1>
          {schoolNameMm && (
            <p className="text-lg font-medium text-slate-600 mt-0.5 font-myanmar">
              {schoolNameMm}
            </p>
          )}
          {!isGeneric && (
            <p className="text-sm text-slate-500 mt-1">
              Japanese Language School&nbsp;
              <span className="font-myanmar text-slate-400">• မြန်မာနိုင်ငံ</span>
            </p>
          )}
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h2 className="text-base font-semibold text-slate-800 mb-1">
            Admin Sign In
          </h2>
          <p className="text-sm text-slate-500 font-myanmar mb-6">
            အက်မင် ဝင်ရောက်ခြင်း
          </p>

          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            {/* Email */}
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-slate-700"
              >
                Email address&nbsp;
                <span className="font-myanmar font-normal text-slate-400">
                  / အီးမေးလ်
                </span>
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent transition"
                placeholder="admin@school.com"
              />
            </div>

            {/* Password */}
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-slate-700"
              >
                Password&nbsp;
                <span className="font-myanmar font-normal text-slate-400">
                  / စကားဝှက်
                </span>
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent transition"
                placeholder="••••••••"
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
              disabled={loading}
              className={`w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors ${
                isGeneric
                  ? "bg-[#6d28d9] hover:bg-[#5b21b6] focus:ring-[#6d28d9]"
                  : "bg-red-700 hover:bg-red-800 focus:ring-red-600"
              }`}
            >
              {loading ? (
                <>
                  <Spinner />
                  <span>Signing in…</span>
                </>
              ) : (
                <>
                  <span>Sign In</span>
                  <span className="font-myanmar font-normal opacity-80">
                    / ဝင်ရောက်မည်
                  </span>
                </>
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          {schoolName} © {new Date().getFullYear()}
        </p>
      </div>
    </main>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 text-white"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
