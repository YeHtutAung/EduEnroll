"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import StatusBadge from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import type { Intake } from "@/types/database";

// ── Constants ─────────────────────────────────────────────────────────────────

const INTAKE_MONTHS = ["January", "April", "July", "October"] as const;
type IntakeMonth = (typeof INTAKE_MONTHS)[number];

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Pulse({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />;
}

function RowSkeleton() {
  return (
    <tr>
      <td className="px-5 py-3.5"><Pulse className="h-4 w-48" /></td>
      <td className="px-5 py-3.5"><Pulse className="h-4 w-12" /></td>
      <td className="px-5 py-3.5"><Pulse className="h-5 w-16 rounded-full" /></td>
      <td className="px-5 py-3.5"><Pulse className="h-5 w-10 rounded-full" /></td>
      <td className="px-5 py-3.5"><Pulse className="h-8 w-24 rounded-lg" /></td>
    </tr>
  );
}

// ── Create Intake Modal ───────────────────────────────────────────────────────

function CreateIntakeModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (intake: Intake) => void;
}) {
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
      onCreated(intake);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create intake.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-0.5">Create New Intake</h2>
        <p className="text-sm text-gray-400 font-myanmar mb-6">သင်တန်းအသစ်ဖွင့်မည်</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Month
            </label>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value as IntakeMonth)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent bg-white"
            >
              {INTAKE_MONTHS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Year
            </label>
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
            <svg className="w-4 h-4 text-[#1a3f8a] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
            </svg>
            <span className="text-gray-600">
              Intake name: <span className="font-semibold text-[#1a3f8a]">{intakeName}</span>
            </span>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function IntakesPage() {
  const [intakes, setIntakes] = useState<Intake[]>([]);
  const [classCounts, setClassCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/intakes");
      if (!res.ok) throw new Error(`Failed to fetch intakes (${res.status})`);
      const list = (await res.json()) as Intake[];
      setIntakes(list);

      // Fetch class counts in parallel — at most ~8 intakes for a school
      const counts = await Promise.all(
        list.map(async (intake) => {
          try {
            const r = await fetch(`/api/intakes/${intake.id}/classes`);
            const classes = r.ok ? await r.json() : [];
            return { id: intake.id, count: Array.isArray(classes) ? classes.length : 0 };
          } catch {
            return { id: intake.id, count: 0 };
          }
        }),
      );
      setClassCounts(Object.fromEntries(counts.map(({ id, count }) => [id, count])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load intakes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function handleCreated(intake: Intake) {
    setIntakes((prev) => [intake, ...prev]);
    setClassCounts((prev) => ({ ...prev, [intake.id]: 0 }));
    setShowCreate(false);
  }

  // ── Error state ─────────────────────────────────────────────────────────────
  if (!loading && error) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 p-8">
        <p className="text-gray-500 text-sm">{error}</p>
        <button
          onClick={fetchData}
          className="px-4 py-2 bg-[#1a3f8a] text-white rounded-lg text-sm"
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Main render ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#f0f4ff] px-6 py-8 lg:px-8">

      {/* Header */}
      <div className="flex items-start justify-between mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 leading-tight">
            Intakes &amp; Classes
          </h1>
          <p className="text-sm font-myanmar text-gray-400 mt-0.5">
            သင်တန်းနှင့် အတန်းများ
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[#1a3f8a] text-white text-sm font-medium rounded-xl hover:bg-blue-900 transition-colors shadow-sm shrink-0"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2.5}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Create New Intake
        </button>
      </div>

      {/* Table card */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {!loading && intakes.length === 0 ? (
          <div className="py-20 flex flex-col items-center gap-3 text-center">
            <div className="w-14 h-14 rounded-full bg-[#f0f4ff] flex items-center justify-center text-2xl">
              🏫
            </div>
            <p className="text-base font-semibold text-gray-700">No intakes yet</p>
            <p className="text-sm text-gray-400 max-w-xs">
              Create your first intake to start managing classes and enrollments.
            </p>
            <button
              onClick={() => setShowCreate(true)}
              className="mt-2 px-5 py-2 bg-[#1a3f8a] text-white text-sm font-medium rounded-xl hover:bg-blue-900 transition-colors"
            >
              Create First Intake
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[580px] text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-left">
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Intake Name
                  </th>
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Year
                  </th>
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Classes
                  </th>
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading
                  ? Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={i} />)
                  : intakes.map((intake) => {
                      const count = classCounts[intake.id] ?? 0;
                      return (
                        <tr
                          key={intake.id}
                          className="hover:bg-[#f0f4ff]/60 transition-colors"
                        >
                          <td className="px-5 py-4">
                            <p className="font-medium text-gray-800">{intake.name}</p>
                          </td>
                          <td className="px-5 py-4 text-gray-600 tabular-nums">
                            {intake.year}
                          </td>
                          <td className="px-5 py-4">
                            <StatusBadge status={intake.status} />
                          </td>
                          <td className="px-5 py-4">
                            <span
                              className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-semibold ${
                                count === 5
                                  ? "bg-emerald-50 text-emerald-700"
                                  : count > 0
                                    ? "bg-amber-50 text-amber-700"
                                    : "bg-gray-100 text-gray-500"
                              }`}
                            >
                              {count}
                              <span className="opacity-50">/5</span>
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <Link
                              href={`/admin/intakes/${intake.id}`}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1a3f8a] text-white text-xs font-medium rounded-lg hover:bg-blue-900 transition-colors"
                            >
                              Manage
                              <svg
                                className="w-3 h-3"
                                fill="none"
                                viewBox="0 0 24 24"
                                strokeWidth={2.5}
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"
                                />
                              </svg>
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <CreateIntakeModal
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
