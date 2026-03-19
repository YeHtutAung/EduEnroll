"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import StatsCard from "@/components/ui/StatsCard";
import StatusBadge from "@/components/ui/StatusBadge";
import { formatMMKSimple } from "@/lib/utils";
import { useTenantLabels } from "@/components/admin/TenantLabelsContext";
import { mm } from "@/lib/mm-labels";
import type { EnrollmentStatus, JlptLevel } from "@/types/database";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SeatRow {
  level: JlptLevel;
  seat_remaining: number;
  seat_total: number;
}

interface StatsData {
  total_enrollments: number;
  confirmed_count: number;
  pending_payment_count: number;
  payment_submitted_count: number;
  total_revenue_mmk: number;
  seats_by_class: SeatRow[];
}

interface RecentEnrollment {
  enrollment_id: string;
  enrollment_ref: string;
  student_name_en: string;
  class_level: JlptLevel;
  enrolled_at: string;
  status: EnrollmentStatus;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  if (s < 60)   return "just now";
  if (m < 60)   return `${m}m ago`;
  if (h < 24)   return `${h}h ago`;
  if (d === 1)  return "yesterday";
  if (d < 30)   return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function seatBarColor(remaining: number, total: number): { bar: string; text: string } {
  if (total === 0) return { bar: "bg-gray-300", text: "text-gray-400" };
  const pct = ((total - remaining) / total) * 100;
  if (remaining === 0) return { bar: "bg-[#c0392b]", text: "text-[#c0392b]" };
  if (pct > 80)        return { bar: "bg-[#b07d2a]", text: "text-[#b07d2a]" };
  return { bar: "bg-[#1a6b3c]", text: "text-[#1a6b3c]" };
}

// ── Skeleton primitives ───────────────────────────────────────────────────────

function Pulse({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />;
}

function CardSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 border-l-4 border-l-gray-200">
      <Pulse className="h-3 w-28 mb-3" />
      <Pulse className="h-8 w-16 mb-2" />
      <Pulse className="h-3 w-20" />
    </div>
  );
}

function BarSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="flex items-center justify-between mb-1.5">
        <Pulse className="h-4 w-8" />
        <Pulse className="h-3 w-14" />
      </div>
      <Pulse className="h-2.5 w-full rounded-full" />
    </div>
  );
}

function RowSkeleton() {
  return (
    <tr>
      <td className="px-4 py-3.5"><Pulse className="h-4 w-36" /></td>
      <td className="px-4 py-3.5"><Pulse className="h-4 w-8" /></td>
      <td className="px-4 py-3.5"><Pulse className="h-3.5 w-20" /></td>
      <td className="px-4 py-3.5"><Pulse className="h-5 w-28 rounded-full" /></td>
    </tr>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SeatsBar({ row }: { row: SeatRow }) {
  const taken = row.seat_total - row.seat_remaining;
  const pct   = row.seat_total > 0 ? Math.round((taken / row.seat_total) * 100) : 0;
  const clr   = seatBarColor(row.seat_remaining, row.seat_total);

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className={`text-sm font-bold ${clr.text}`}>{row.level}</span>
        <span className="text-xs text-gray-500 tabular-nums">
          {taken} <span className="text-gray-300">/</span> {row.seat_total}
        </span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-gray-100 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${clr.bar}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${row.level}: ${pct}% full`}
        />
      </div>
      {row.seat_remaining === 0 && (
        <p className="mt-1 text-xs text-[#c0392b] font-medium">Class full</p>
      )}
    </div>
  );
}

// ── Dashboard page ────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const tl = useTenantLabels();
  const [stats,   setStats]   = useState<StatsData | null>(null);
  const [recent,  setRecent]  = useState<RecentEnrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [lastAt,  setLastAt]  = useState<Date | null>(null);

  const fetchAll = useCallback(async (isBackground = false) => {
    if (!isBackground) setLoading(true);
    setError(null);
    try {
      const [sRes, rRes] = await Promise.all([
        fetch("/api/admin/stats"),
        fetch("/api/admin/students?page_size=5"),
      ]);
      if (!sRes.ok) throw new Error(`Stats: ${sRes.status}`);
      if (!rRes.ok) throw new Error(`Students: ${rRes.status}`);

      const [sJson, rJson] = await Promise.all([sRes.json(), rRes.json()]);
      setStats(sJson);
      setRecent(rJson.data ?? []);
      setLastAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(() => fetchAll(true), 60_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  // ── Error state ────────────────────────────────────────────────────────────

  if (!loading && error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="bg-white rounded-2xl border border-red-100 shadow-sm px-8 py-10 max-w-md w-full text-center">
          <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-[#c0392b]" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
            </svg>
          </div>
          <p className="text-base font-semibold text-gray-800 mb-1">Failed to load dashboard</p>
          <p className="text-sm text-gray-400 mb-6">{error}</p>
          <button
            onClick={() => fetchAll()}
            className="px-5 py-2 bg-[#1a3f8a] text-white text-sm font-medium rounded-lg hover:bg-blue-900 transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const paymentQueue = stats?.payment_submitted_count ?? 0;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#f0f4ff] px-6 py-8 lg:px-8">

      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="flex items-start justify-between mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 leading-tight">Dashboard</h1>
          <p className="text-sm font-myanmar text-gray-400 mt-0.5">ဒက်ရှ်ဘုတ်</p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {lastAt && (
            <p className="text-xs text-gray-400 hidden sm:block">
              Updated {timeAgo(lastAt.toISOString())}
            </p>
          )}
          <button
            onClick={() => fetchAll()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 transition-colors shadow-sm"
            aria-label="Refresh dashboard"
          >
            <svg
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
              fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* ── Stats row ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)
        ) : (
          <>
            <StatsCard
              title="Total Enrolled"
              value={stats?.total_enrollments ?? 0}
              subtitle="All-time enrollments"
              colorAccent="#1a3f8a"
            />
            <StatsCard
              title={`Confirmed ${tl.student}s`}
              value={stats?.confirmed_count ?? 0}
              subtitle="Payment verified"
              colorAccent="#1a6b3c"
            />
            <div className="relative">
              <StatsCard
                title="Awaiting Review"
                value={stats?.payment_submitted_count ?? 0}
                subtitle="Payment proofs submitted"
                colorAccent="#b07d2a"
              />
              {/* Pulsing dot when queue has items */}
              {(stats?.payment_submitted_count ?? 0) > 0 && (
                <span className="absolute top-4 right-4 flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#b07d2a] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#b07d2a]" />
                </span>
              )}
            </div>
            <StatsCard
              title="Total Revenue"
              value={formatMMKSimple(stats?.total_revenue_mmk ?? 0)}
              subtitle="Verified payments"
              colorAccent="#0891b2"
            />
          </>
        )}
      </div>

      {/* ── Middle row: Seats Overview + Quick Actions ───────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-8">

        {/* Seats Overview (wider) */}
        <section className="lg:col-span-3 bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wider mb-5">
            {tl.seat}s Overview
          </h2>

          {loading ? (
            <div className="space-y-5">
              {Array.from({ length: 5 }).map((_, i) => <BarSkeleton key={i} />)}
            </div>
          ) : stats?.seats_by_class?.length ? (
            <div className="space-y-5">
              {stats.seats_by_class.map((row) => (
                <SeatsBar key={row.level} row={row} />
              ))}
            </div>
          ) : (
            <div className="py-10 text-center text-sm text-gray-400">
              No classes configured yet.
            </div>
          )}
        </section>

        {/* Quick Actions */}
        <section className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wider mb-5">
            Quick Actions
          </h2>

          <div className="flex flex-col gap-3">
            {/* Create New Intake */}
            <Link
              href="/admin/intakes/new"
              className="flex items-center gap-3 px-4 py-3.5 rounded-xl border-2 border-dashed border-[#1a3f8a]/30 text-[#1a3f8a] hover:bg-[#1a3f8a] hover:text-white hover:border-[#1a3f8a] transition-all group"
            >
              <span className="text-xl">🏫</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">Create New {tl.intake}</p>
                <p className="text-xs opacity-60 font-myanmar">{mm(tl.orgType, "createIntake")}</p>
              </div>
              <svg className="w-4 h-4 ml-auto shrink-0 opacity-50 group-hover:opacity-100" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </Link>

            {/* View Payment Queue */}
            <Link
              href="/admin/payments?status=payment_submitted"
              className="flex items-center gap-3 px-4 py-3.5 rounded-xl border-2 border-dashed border-[#b07d2a]/30 text-[#b07d2a] hover:bg-[#b07d2a] hover:text-white hover:border-[#b07d2a] transition-all group"
            >
              <span className="text-xl">💳</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold flex items-center gap-2">
                  Payment Queue
                  {!loading && paymentQueue > 0 && (
                    <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-[#b07d2a] text-white text-xs font-bold group-hover:bg-white group-hover:text-[#b07d2a] transition-colors">
                      {paymentQueue}
                    </span>
                  )}
                </p>
                <p className="text-xs opacity-60 font-myanmar">ငွေပေးချေမှု စစ်ဆေးမည်</p>
              </div>
              <svg className="w-4 h-4 shrink-0 opacity-50 group-hover:opacity-100" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </Link>

            {/* View All Students */}
            <Link
              href="/admin/students"
              className="flex items-center gap-3 px-4 py-3.5 rounded-xl border-2 border-dashed border-[#0891b2]/30 text-[#0891b2] hover:bg-[#0891b2] hover:text-white hover:border-[#0891b2] transition-all group"
            >
              <span className="text-xl">👥</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">View All {tl.student}s</p>
                <p className="text-xs opacity-60 font-myanmar">ကျောင်းသားများကြည့်မည်</p>
              </div>
              <svg className="w-4 h-4 ml-auto shrink-0 opacity-50 group-hover:opacity-100" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </Link>
          </div>

          {/* Subtle stats at bottom */}
          {!loading && stats && (
            <div className="mt-6 pt-4 border-t border-gray-100 grid grid-cols-2 gap-3">
              <div className="text-center">
                <p className="text-xl font-bold text-[#1a3f8a]">{stats.pending_payment_count}</p>
                <p className="text-xs text-gray-400 mt-0.5">Pending payment</p>
              </div>
              <div className="text-center">
                <p className="text-xl font-bold text-[#1a6b3c]">{stats.confirmed_count}</p>
                <p className="text-xs text-gray-400 mt-0.5">Confirmed</p>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* ── Recent Enrollments ───────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wider">
              Recent Enrollments
            </h2>
            <p className="text-xs text-gray-400 font-myanmar mt-0.5">{mm(tl.orgType, "recentEnrollments")}</p>
          </div>
          <Link
            href="/admin/students"
            className="text-xs font-medium text-[#1a3f8a] hover:underline"
          >
            View all →
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="bg-gray-50 text-left">
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{tl.student}</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">{tl.class}</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Enrolled</th>
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => <RowSkeleton key={i} />)
              ) : recent.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-sm text-gray-400">
                    No enrollments yet.
                  </td>
                </tr>
              ) : (
                recent.map((row) => (
                  <tr
                    key={row.enrollment_id}
                    className="hover:bg-[#f0f4ff]/50 transition-colors"
                  >
                    <td className="px-4 py-3.5">
                      <p className="font-medium text-gray-800 truncate max-w-[200px]">
                        {row.student_name_en}
                      </p>
                      <p className="text-xs text-gray-400 font-mono mt-0.5">
                        {row.enrollment_ref}
                      </p>
                    </td>
                    <td className="px-4 py-3.5">
                      {row.class_level ? (
                        <div className="flex flex-wrap gap-1">
                          {row.class_level.split(",").map((lvl, i) => (
                            <span
                              key={i}
                              className="inline-flex items-center justify-center px-2 h-7 rounded-lg text-xs font-bold text-white whitespace-nowrap"
                              style={{ backgroundColor: "#1a3f8a" }}
                            >
                              {lvl.trim()}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-sm text-gray-500 whitespace-nowrap">
                      {timeAgo(row.enrolled_at)}
                    </td>
                    <td className="px-4 py-3.5">
                      <StatusBadge status={row.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
