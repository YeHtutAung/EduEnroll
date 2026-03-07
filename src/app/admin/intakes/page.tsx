"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import StatusBadge from "@/components/ui/StatusBadge";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { useToast } from "@/components/ui/Toast";
import { useTenantLabels } from "@/components/admin/TenantLabelsContext";
import type { Intake, IntakeStatus } from "@/types/database";

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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function IntakesPage() {
  const toast = useToast();
  const labels = useTenantLabels();
  const [intakes, setIntakes] = useState<Intake[]>([]);
  const [classCounts, setClassCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState<{ intakeId: string; intakeName: string } | null>(null);

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

  async function handleStatusChange(intakeId: string, newStatus: IntakeStatus) {
    setUpdatingStatus(intakeId);
    try {
      const res = await fetch(`/api/intakes/${intakeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to update status.");
      }
      const updated = (await res.json()) as Intake;
      setIntakes((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      toast.success(`Status changed to "${newStatus}".`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update status.");
    } finally {
      setUpdatingStatus(null);
    }
  }

  function requestStatusChange(intakeId: string, intakeName: string, newStatus: IntakeStatus) {
    if (newStatus === "open") {
      setConfirmOpen({ intakeId, intakeName });
    } else {
      handleStatusChange(intakeId, newStatus);
    }
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
            {labels.intake}s &amp; {labels.class}es
          </h1>
          <p className="text-sm font-myanmar text-gray-400 mt-0.5">
            သင်တန်းနှင့် အတန်းများ
          </p>
        </div>
        <Link
          href="/admin/intakes/new"
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
          Create New {labels.intake}
        </Link>
      </div>

      {/* Table card */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        {!loading && intakes.length === 0 ? (
          <div className="py-20 flex flex-col items-center gap-3 text-center">
            <div className="w-14 h-14 rounded-full bg-[#f0f4ff] flex items-center justify-center text-2xl">
              🏫
            </div>
            <p className="text-base font-semibold text-gray-700">No {labels.intake.toLowerCase()}s yet</p>
            <p className="text-sm text-gray-400 max-w-xs">
              Create your first {labels.intake.toLowerCase()} to start managing {labels.class.toLowerCase()}es and enrollments.
            </p>
            <Link
              href="/admin/intakes/new"
              className="mt-2 px-5 py-2 bg-[#1a3f8a] text-white text-sm font-medium rounded-xl hover:bg-blue-900 transition-colors"
            >
              Create First {labels.intake}
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[580px] text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100 text-left">
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    {labels.intake} Name
                  </th>
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Year
                  </th>
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-5 py-3.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    {labels.class}es
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
                            <div className="flex items-center gap-2">
                              <select
                                value={intake.status}
                                onChange={(e) =>
                                  requestStatusChange(
                                    intake.id,
                                    intake.name,
                                    e.target.value as IntakeStatus,
                                  )
                                }
                                disabled={updatingStatus === intake.id}
                                className={`text-xs font-medium rounded-lg border px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-[#1a3f8a] focus:border-transparent transition-colors disabled:opacity-50 ${
                                  intake.status === "open"
                                    ? "border-emerald-300 text-emerald-700"
                                    : intake.status === "closed"
                                      ? "border-red-300 text-red-600"
                                      : "border-gray-300 text-gray-600"
                                }`}
                              >
                                <option value="draft">Draft</option>
                                <option value="open">Open</option>
                                <option value="closed">Closed</option>
                              </select>
                              <Link
                                href={`/admin/intakes/${intake.id}/form`}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 text-gray-600 text-xs font-medium rounded-lg hover:bg-gray-50 transition-colors"
                                title="Edit enrollment form"
                              >
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                                </svg>
                                Form
                              </Link>
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
                            </div>
                          </td>
                        </tr>
                      );
                    })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirm opening intake */}
      {confirmOpen && (
        <ConfirmModal
          variant="success"
          title={`Open "${confirmOpen.intakeName}"?`}
          message="This will make the enrollment portal live. Students can start enrolling immediately."
          confirmLabel="Open Enrollment"
          onConfirm={() => {
            handleStatusChange(confirmOpen.intakeId, "open");
            setConfirmOpen(null);
          }}
          onCancel={() => setConfirmOpen(null)}
        />
      )}
    </div>
  );
}
