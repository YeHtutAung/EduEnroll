"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { MyanmarBank } from "@/types/database";

// ─── Types ──────────────────────────────────────────────────────────────────

interface BankEntry {
  bank_name: MyanmarBank;
  account_number: string;
  account_holder: string;
}

const BANK_OPTIONS: MyanmarBank[] = ["KBZ", "AYA", "CB", "UAB", "Yoma"];

const INTAKE_MONTHS = [
  { value: "January", label: "January / ဇန်နဝါရီ" },
  { value: "April", label: "April / ဧပြီ" },
  { value: "July", label: "July / ဇူလိုင်" },
  { value: "October", label: "October / အောက်တိုဘာ" },
];

// ─── Progress Bar ───────────────────────────────────────────────────────────

function ProgressBar({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {[1, 2, 3, 4].map((s) => (
        <div key={s} className="flex-1 flex items-center gap-2">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 transition-colors ${
              s <= step
                ? "bg-[#6d28d9] text-white"
                : "bg-gray-200 text-gray-400"
            }`}
          >
            {s < step ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            ) : (
              s
            )}
          </div>
          {s < 4 && (
            <div
              className={`flex-1 h-1 rounded-full transition-colors ${
                s < step ? "bg-[#6d28d9]" : "bg-gray-200"
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const router = useRouter();
  const supabase = createClient();

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [subdomain, setSubdomain] = useState("");

  // Step 1: School Profile
  const [schoolNameEn, setSchoolNameEn] = useState("");
  const [schoolNameMm, setSchoolNameMm] = useState("");

  // Step 2: Bank accounts
  const [banks, setBanks] = useState<BankEntry[]>([
    { bank_name: "KBZ", account_number: "", account_holder: "" },
  ]);

  // Step 3: First intake
  const [intakeMonth, setIntakeMonth] = useState("April");
  const [intakeYear, setIntakeYear] = useState(new Date().getFullYear());
  const [createdIntakeSlug, setCreatedIntakeSlug] = useState<string | null>(null);

  // Load user profile on mount
  useEffect(() => {
    async function loadProfile() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }

      const { data: profile } = (await supabase
        .from("users")
        .select("tenant_id, full_name")
        .eq("id", user.id)
        .single()) as { data: { tenant_id: string; full_name: string | null } | null; error: unknown };

      if (!profile) {
        router.push("/login");
        return;
      }

      setTenantId(profile.tenant_id);
      if (profile.full_name) setSchoolNameEn(profile.full_name);

      const { data: tenant } = (await supabase
        .from("tenants")
        .select("name, subdomain")
        .eq("id", profile.tenant_id)
        .single()) as { data: { name: string; subdomain: string } | null; error: unknown };

      if (tenant) {
        setSchoolNameEn(tenant.name);
        setSubdomain(tenant.subdomain);
      }
    }
    loadProfile();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Step handlers ─────────────────────────────────────────────────────────

  async function handleStep1Next() {
    if (!tenantId || !schoolNameEn.trim()) return;
    setLoading(true);
    try {
      await supabase
        .from("tenants")
        .update({ name: schoolNameEn.trim() } as never)
        .eq("id", tenantId);
      setStep(2);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  async function handleStep2Next() {
    setLoading(true);
    try {
      const validBanks = banks.filter(
        (b) => b.account_number.trim() && b.account_holder.trim()
      );
      for (const bank of validBanks) {
        await fetch("/api/admin/bank-accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...bank, is_active: true }),
        });
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setStep(3);
    }
  }

  async function handleStep3Next() {
    setLoading(true);
    try {
      const intakeName = `${intakeMonth} ${intakeYear} Intake`;
      const res = await fetch("/api/intakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: intakeName, year: intakeYear, status: "open" }),
      });

      if (res.ok) {
        const intake = await res.json();
        // Generate slug from intake name
        const slug = intakeName
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");
        setCreatedIntakeSlug(slug);

        // Quick-add classes if requested
        if (addAllClasses) {
          await fetch(`/api/intakes/${intake.id}/classes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ add_all: true }),
          });
        }
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setStep(4);
    }
  }

  // Step 3: add all classes toggle
  const [addAllClasses, setAddAllClasses] = useState(true);

  function addBankRow() {
    setBanks((prev) => [
      ...prev,
      { bank_name: "KBZ", account_number: "", account_holder: "" },
    ]);
  }

  function updateBank(index: number, field: keyof BankEntry, value: string) {
    setBanks((prev) =>
      prev.map((b, i) => (i === index ? { ...b, [field]: value } : b))
    );
  }

  function removeBank(index: number) {
    setBanks((prev) => prev.filter((_, i) => i !== index));
  }

  // ── Enrollment link ───────────────────────────────────────────────────────
  const enrollLink = createdIntakeSlug
    ? `${subdomain}.kuunyi.com/enroll/${createdIntakeSlug}`
    : null;
  const [copied, setCopied] = useState(false);

  function copyLink() {
    if (enrollLink) {
      navigator.clipboard.writeText(`https://${enrollLink}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  // ── Shared styles ─────────────────────────────────────────────────────────
  const inputClass =
    "w-full border border-gray-300 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6d28d9] focus:border-transparent";
  const btnPrimary =
    "px-6 py-2.5 bg-[#6d28d9] text-white text-sm font-semibold rounded-xl hover:bg-[#5b21b6] disabled:opacity-50 transition-colors";
  const btnSecondary =
    "px-6 py-2.5 border border-gray-300 text-sm font-medium text-gray-600 rounded-xl hover:bg-gray-50 transition-colors";

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl">
        {/* Logo */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#6d28d9] mb-3">
            <span className="text-white text-xl font-bold">K</span>
          </div>
          <p className="text-sm text-gray-400">Welcome to KuuNyi</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <ProgressBar step={step} />

          {/* ── Step 1: School Profile ──────────────────────────────── */}
          {step === 1 && (
            <div>
              <h2 className="text-lg font-bold text-gray-900 mb-1">School Profile</h2>
              <p className="text-sm text-gray-500 mb-6">
                Confirm your school details.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    School Name (English)
                  </label>
                  <input
                    type="text"
                    value={schoolNameEn}
                    onChange={(e) => setSchoolNameEn(e.target.value)}
                    className={inputClass}
                    placeholder="e.g. Nihon Moment"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    School Name (Myanmar)
                    <span className="text-gray-400 font-normal"> — optional</span>
                  </label>
                  <input
                    type="text"
                    value={schoolNameMm}
                    onChange={(e) => setSchoolNameMm(e.target.value)}
                    className={`${inputClass} font-myanmar`}
                    placeholder="e.g. နီဟွန်းမိုးမန့်"
                  />
                </div>
              </div>

              <div className="mt-8 flex justify-end">
                <button
                  onClick={handleStep1Next}
                  disabled={loading || !schoolNameEn.trim()}
                  className={btnPrimary}
                >
                  {loading ? "Saving..." : "Next"}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 2: Payment Setup ──────────────────────────────── */}
          {step === 2 && (
            <div>
              <h2 className="text-lg font-bold text-gray-900 mb-1">Payment Setup</h2>
              <p className="text-sm text-gray-500 mb-6">
                Add bank accounts so students can transfer their fees.
              </p>

              <div className="space-y-4">
                {banks.map((bank, i) => (
                  <div key={i} className="border border-gray-200 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-400 uppercase">
                        Account {i + 1}
                      </span>
                      {banks.length > 1 && (
                        <button
                          onClick={() => removeBank(i)}
                          className="text-xs text-red-500 hover:text-red-700"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Bank
                      </label>
                      <select
                        value={bank.bank_name}
                        onChange={(e) => updateBank(i, "bank_name", e.target.value)}
                        className={`${inputClass} bg-white`}
                      >
                        {BANK_OPTIONS.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account Number
                      </label>
                      <input
                        type="text"
                        value={bank.account_number}
                        onChange={(e) => updateBank(i, "account_number", e.target.value)}
                        className={inputClass}
                        placeholder="e.g. 1234567890"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account Holder Name
                      </label>
                      <input
                        type="text"
                        value={bank.account_holder}
                        onChange={(e) => updateBank(i, "account_holder", e.target.value)}
                        className={inputClass}
                        placeholder="e.g. U Aung Aung"
                      />
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={addBankRow}
                className="mt-3 flex items-center gap-1.5 text-sm text-[#6d28d9] font-medium hover:underline"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Add Another Account
              </button>

              <div className="mt-8 flex items-center justify-between">
                <button onClick={() => setStep(3)} className={btnSecondary}>
                  Skip for now
                </button>
                <button
                  onClick={handleStep2Next}
                  disabled={loading}
                  className={btnPrimary}
                >
                  {loading ? "Saving..." : "Next"}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: First Intake ───────────────────────────────── */}
          {step === 3 && (
            <div>
              <h2 className="text-lg font-bold text-gray-900 mb-1">
                Create Your First Intake
              </h2>
              <p className="text-sm text-gray-500 mb-6">
                An intake is an enrollment period (e.g. April 2026).
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Intake Month
                  </label>
                  <select
                    value={intakeMonth}
                    onChange={(e) => setIntakeMonth(e.target.value)}
                    className={`${inputClass} bg-white`}
                  >
                    {INTAKE_MONTHS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Year
                  </label>
                  <input
                    type="number"
                    value={intakeYear}
                    onChange={(e) => setIntakeYear(Number(e.target.value))}
                    min={2024}
                    max={2100}
                    className={inputClass}
                  />
                </div>

                <label className="flex items-center gap-3 p-4 border border-gray-200 rounded-xl cursor-pointer hover:bg-gray-50 transition-colors">
                  <input
                    type="checkbox"
                    checked={addAllClasses}
                    onChange={(e) => setAddAllClasses(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-[#6d28d9] focus:ring-[#6d28d9]"
                  />
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      Add all 5 JLPT classes (N5–N1)
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      With default fees and 30 seats each
                    </p>
                  </div>
                </label>
              </div>

              <div className="mt-8 flex items-center justify-between">
                <button onClick={() => setStep(2)} className={btnSecondary}>
                  Back
                </button>
                <button
                  onClick={handleStep3Next}
                  disabled={loading}
                  className={btnPrimary}
                >
                  {loading ? "Creating..." : "Create Intake"}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 4: Done! ──────────────────────────────────────── */}
          {step === 4 && (
            <div className="text-center py-4">
              {/* Green checkmark */}
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 mb-5">
                <svg
                  className="w-8 h-8 text-[#1a6b3c]"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>

              <h2 className="text-xl font-bold text-gray-900 mb-1">
                You&apos;re Ready!
              </h2>
              <p className="text-sm text-gray-500 mb-2">
                Your school is set up and ready to accept enrollments.
              </p>
              <p className="text-sm text-gray-400 font-myanmar mb-6">
                သင့်ကျောင်းသည် စာရင်းသွင်းမှုများ လက်ခံရန် အဆင်သင့်ဖြစ်ပါပြီ။
              </p>

              {/* Enrollment link */}
              {enrollLink && (
                <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-6 text-left">
                  <p className="text-xs font-semibold text-gray-500 mb-2 uppercase">
                    Your Enrollment Link
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-sm text-[#6d28d9] font-mono bg-white border border-gray-200 rounded-lg px-3 py-2 truncate">
                      {enrollLink}
                    </code>
                    <button
                      onClick={copyLink}
                      className="shrink-0 px-3 py-2 bg-[#6d28d9] text-white text-xs font-semibold rounded-lg hover:bg-[#5b21b6] transition-colors"
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={() => router.push("/admin/dashboard")}
                className={`w-full ${btnPrimary}`}
              >
                Go to Dashboard
              </button>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          Step {step} of 4
        </p>
      </div>
    </main>
  );
}
