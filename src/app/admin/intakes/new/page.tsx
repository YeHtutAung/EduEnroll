"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import type { Intake } from "@/types/database";

const ALL_MONTHS = [
  "January", "February", "March", "April",
  "May", "June", "July", "August",
  "September", "October", "November", "December",
] as const;

const MIN_YEAR = 2020;
const MAX_YEAR = 2030;

export default function NewIntakePage() {
  const router = useRouter();
  const toast = useToast();
  const [month, setMonth] = useState<string>("");
  const [year, setYear] = useState(new Date().getFullYear());
  const [nameOverride, setNameOverride] = useState("");
  const [saving, setSaving] = useState(false);

  const autoName = month ? `${month} ${year} Intake` : "";
  const intakeName = nameOverride || autoName;

  // When month/year changes, clear manual override so auto-name takes effect
  function selectMonth(m: string) {
    setMonth(m);
    setNameOverride("");
  }
  function changeYear(delta: number) {
    const next = year + delta;
    if (next >= MIN_YEAR && next <= MAX_YEAR) {
      setYear(next);
      setNameOverride("");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!month) {
      toast.error("Please select a month.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/intakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: intakeName, year }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to create intake.");
      }
      const intake = (await res.json()) as Intake;
      toast.success(`"${intake.name}" created.`);
      router.push(`/admin/intakes/${intake.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create intake.");
      setSaving(false);
    }
  }

  return (
    <div className="p-6 lg:p-10 max-w-xl mx-auto">
      {/* Header */}
      <button
        onClick={() => router.push("/admin/intakes")}
        className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors mb-6"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
        </svg>
        Back to Intakes
      </button>

      <h1 className="text-2xl font-bold text-gray-900 mb-0.5">Create New Intake</h1>
      <p className="text-sm text-gray-400 font-myanmar mb-8">သင်တန်းအသစ်ဖွင့်မည်</p>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
        <form onSubmit={handleSubmit} className="space-y-5">

          {/* Year picker */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Year</label>
            <div className="flex items-center justify-center gap-1">
              <button
                type="button"
                onClick={() => changeYear(-1)}
                disabled={year <= MIN_YEAR}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                aria-label="Previous year"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
              </button>
              {[year - 1, year, year + 1].filter((y) => y >= MIN_YEAR && y <= MAX_YEAR).map((y) => (
                <button
                  key={y}
                  type="button"
                  onClick={() => { setYear(y); setNameOverride(""); }}
                  className={[
                    "px-4 py-2 rounded-lg text-sm font-semibold transition-colors",
                    y === year
                      ? "bg-[#6d28d9] text-white"
                      : "text-gray-400 hover:text-gray-700 hover:bg-gray-100",
                  ].join(" ")}
                >
                  {y}
                </button>
              ))}
              <button
                type="button"
                onClick={() => changeYear(1)}
                disabled={year >= MAX_YEAR}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                aria-label="Next year"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            </div>
          </div>

          {/* Month grid picker */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Month</label>
            <div className="grid grid-cols-4 gap-2">
              {ALL_MONTHS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => selectMonth(m)}
                  className={[
                    "py-2.5 rounded-lg text-sm font-medium transition-colors",
                    m === month
                      ? "bg-[#6d28d9] text-white shadow-sm"
                      : "bg-gray-50 text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                  ].join(" ")}
                >
                  {m.slice(0, 3)}
                </button>
              ))}
            </div>
          </div>

          {/* Intake name (auto-generated, editable) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Intake Name
            </label>
            <input
              type="text"
              value={intakeName}
              onChange={(e) => setNameOverride(e.target.value)}
              required
              placeholder="Select a month to auto-generate"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent"
            />
            {nameOverride && autoName && nameOverride !== autoName && (
              <button
                type="button"
                onClick={() => setNameOverride("")}
                className="mt-1 text-xs text-[#6d28d9] hover:underline"
              >
                Reset to &ldquo;{autoName}&rdquo;
              </button>
            )}
          </div>

          {/* Preview */}
          {intakeName && (
            <div className="flex items-center gap-2 rounded-xl bg-[#f0f4ff] px-4 py-3 text-sm">
              <svg
                className="w-4 h-4 text-[#1a3f8a] shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"
                />
              </svg>
              <span className="text-gray-600">
                Will create: <span className="font-semibold text-[#1a3f8a]">{intakeName}</span>
                <span className="text-gray-400 ml-1">({year})</span>
              </span>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => router.push("/admin/intakes")}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !month}
              className="flex-1 px-4 py-2.5 bg-[#1a3f8a] text-white rounded-xl text-sm font-medium hover:bg-blue-900 disabled:opacity-50 transition-colors"
            >
              {saving ? "Creating…" : "Create Intake"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
