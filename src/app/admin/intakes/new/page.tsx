"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import type { Intake } from "@/types/database";

const INTAKE_MONTHS = ["January", "April", "July", "October"] as const;
type IntakeMonth = (typeof INTAKE_MONTHS)[number];

export default function NewIntakePage() {
  const router = useRouter();
  const toast = useToast();
  const [month, setMonth] = useState<IntakeMonth>("April");
  const [year, setYear] = useState(new Date().getFullYear());
  const [saving, setSaving] = useState(false);

  const intakeName = `${month} ${year} Intake`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Month</label>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value as IntakeMonth)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent bg-white"
            >
              {INTAKE_MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Year</label>
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              min={2020}
              max={2100}
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent"
            />
          </div>

          {/* Preview */}
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
              Intake name: <span className="font-semibold text-[#1a3f8a]">{intakeName}</span>
            </span>
          </div>

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
              disabled={saving}
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
