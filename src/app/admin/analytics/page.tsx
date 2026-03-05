"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import LoadingSpinner from "@/components/ui/LoadingSpinner";
import { formatMMK } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────
interface AnalyticsData {
  daily_enrollments: { date: string; count: number }[];
  enrollments_by_level: { level: string; count: number }[];
  revenue_by_level: { level: string; revenue: number }[];
  conversion_rate: number;
  seat_fill_rates: {
    level: string;
    class_id: string;
    seat_remaining: number;
    seat_total: number;
    fill_pct: number;
  }[];
  avg_payment_hours: number;
  total_enrolled: number;
  confirmed_count: number;
  total_revenue_mmk: number;
}

type RangeKey = "intake" | "30d" | "90d" | "all";

const RANGE_OPTIONS: { key: RangeKey; labelEn: string; labelMm: string }[] = [
  { key: "intake", labelEn: "This Intake", labelMm: "ယခုသင်တန်း" },
  { key: "30d", labelEn: "Last 30 Days", labelMm: "ရက် ၃၀" },
  { key: "90d", labelEn: "Last 90 Days", labelMm: "ရက် ၉၀" },
  { key: "all", labelEn: "All Time", labelMm: "အားလုံး" },
];

// ─── Stats Card ─────────────────────────────────────────────────────────────
function StatCard({
  label,
  labelMm,
  value,
  sub,
}: {
  label: string;
  labelMm: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-xs text-gray-400 font-myanmar">{labelMm}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Fill bar color ─────────────────────────────────────────────────────────
function fillColor(pct: number): string {
  if (pct > 90) return "bg-red-500";
  if (pct >= 70) return "bg-orange-400";
  return "bg-[#1a6b3c]";
}

// ─── Inner content (uses useSearchParams) ───────────────────────────────────
function AnalyticsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const range = (searchParams.get("range") as RangeKey) ?? "30d";

  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/analytics?range=${range}`);
      if (res.ok) setData(await res.json());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function setRange(key: RangeKey) {
    router.push(`/admin/analytics?range=${key}`);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-96 text-gray-400">
        Failed to load analytics.
      </div>
    );
  }

  // Merge enrollment + revenue for bar chart
  const barData = data.enrollments_by_level.map((e, i) => ({
    level: e.level,
    enrolled: e.count,
    revenue: data.revenue_by_level[i]?.revenue ?? 0,
  }));

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      {/* ── Header + Range filter ──────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-sm text-gray-400 font-myanmar">
            စာရင်းအင်းခွဲခြမ်းစိတ်ဖြာခြင်း
          </p>
        </div>
        <div className="flex gap-1 bg-white rounded-lg border border-gray-200 p-1">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setRange(opt.key)}
              className={[
                "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                range === opt.key
                  ? "bg-[#1a3f8a] text-white"
                  : "text-gray-600 hover:bg-gray-100",
              ].join(" ")}
            >
              <span>{opt.labelEn}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Top stats row ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Enrolled"
          labelMm="စာရင်းသွင်းသူ စုစုပေါင်း"
          value={data.total_enrolled.toLocaleString()}
        />
        <StatCard
          label="Confirmed Rate"
          labelMm="အတည်ပြုနှုန်း"
          value={`${data.conversion_rate}%`}
          sub={`${data.confirmed_count} confirmed`}
        />
        <StatCard
          label="Total Revenue"
          labelMm="စုစုပေါင်းဝင်ငွေ"
          value={formatMMK(data.total_revenue_mmk)}
        />
        <StatCard
          label="Avg Payment Time"
          labelMm="ပျမ်းမျှငွေပေးချေချိန်"
          value={`${data.avg_payment_hours}h`}
          sub="enrollment to payment"
        />
      </div>

      {/* ── Charts row ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Enrollment Trend */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">
            Enrollment Trend
          </h2>
          <p className="text-xs text-gray-400 font-myanmar mb-4">
            နေ့စဉ်စာရင်းသွင်းမှု
          </p>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data.daily_enrollments}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "#9ca3af" }}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#9ca3af" }}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                  fontSize: 13,
                }}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke="#1a6b3c"
                strokeWidth={2}
                dot={false}
                name="Enrollments"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Class Distribution */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">
            Class Distribution
          </h2>
          <p className="text-xs text-gray-400 font-myanmar mb-4">
            အတန်းအလိုက်ခွဲခြမ်း
          </p>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={barData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="level"
                tick={{ fontSize: 12, fill: "#6b7280" }}
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 11, fill: "#9ca3af" }}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11, fill: "#9ca3af" }}
                tickFormatter={(v: number) =>
                  v >= 1000000
                    ? `${(v / 1000000).toFixed(1)}M`
                    : v >= 1000
                      ? `${(v / 1000).toFixed(0)}K`
                      : String(v)
                }
              />
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                  fontSize: 13,
                }}
                /* eslint-disable @typescript-eslint/no-explicit-any */
                formatter={((value: any, name: any) =>
                  name === "Revenue" ? formatMMK(value ?? 0) : (value ?? 0)
                ) as any}
                /* eslint-enable @typescript-eslint/no-explicit-any */
              />
              <Legend />
              <Bar
                yAxisId="left"
                dataKey="enrolled"
                name="Enrolled"
                fill="#1a3f8a"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                yAxisId="right"
                dataKey="revenue"
                name="Revenue"
                fill="#1a6b3c"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Seat Fill Rate ─────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-1">
          Seat Fill Rate
        </h2>
        <p className="text-xs text-gray-400 font-myanmar mb-4">
          နေရာပြည့်နှုန်း
        </p>
        {data.seat_fill_rates.length === 0 ? (
          <p className="text-sm text-gray-400">No classes found.</p>
        ) : (
          <div className="space-y-3">
            {data.seat_fill_rates.map((s) => {
              const filled = s.seat_total - s.seat_remaining;
              return (
                <div key={s.class_id} className="flex items-center gap-3">
                  <span className="text-sm font-medium text-gray-700 w-10 shrink-0">
                    {s.level}
                  </span>
                  <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${fillColor(s.fill_pct)}`}
                      style={{ width: `${Math.min(s.fill_pct, 100)}%` }}
                    />
                  </div>
                  <span className="text-sm text-gray-500 w-24 text-right shrink-0">
                    {filled}/{s.seat_total} ({s.fill_pct}%)
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page wrapper with Suspense ─────────────────────────────────────────────
export default function AnalyticsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-96">
          <LoadingSpinner />
        </div>
      }
    >
      <AnalyticsContent />
    </Suspense>
  );
}
