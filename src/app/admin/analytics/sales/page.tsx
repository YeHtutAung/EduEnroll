"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMMK, formatPct, type SalesMetrics } from "@/lib/analytics/sales";

// ─── Types ──────────────────────────────────────────────────────────────────
interface SalesResponse {
  filters: {
    events: { id: string; name: string }[];
    ticketTypes: { id: string; level: string }[];
    selected: { intakeId: string | null; from: string | null; to: string | null; classId: string | null };
  };
  metrics: SalesMetrics | null;
}

interface NotConvertedRow {
  ref: string;
  name: string;
  email: string;
  phone: string;
  ticketType: string;
  qty: number;
  fee: number;
  date: string;
  time: string;
}

// Categorical order (validated set, light surface). A type keeps its colour
// for the whole event, so filtering never repaints the survivors.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const OTHER_COLOR = "#a3a29c";
const SINGLE = "#2a78d6";
const AXIS = { fontSize: 11, fill: "#6b7280" };
const GRID = "#eef0f3";

const num = (v: number) => v.toLocaleString("en-US");

// ─── Small building blocks ──────────────────────────────────────────────────
function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5 min-w-0">
      <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: "up" | "down" }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 min-w-0">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="text-xl sm:text-2xl font-bold text-gray-900 mt-1 tabular-nums break-words">{value}</p>
      {sub && (
        <p
          className={`text-xs mt-1 ${tone === "up" ? "text-emerald-700" : tone === "down" ? "text-red-700" : "text-gray-500"}`}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

function TooltipBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm px-3 py-2 text-xs text-gray-700 max-w-[260px]">
      {children}
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: color }} aria-hidden />;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-500 py-8 text-center">{children}</p>;
}

function Skeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading sales analytics">
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 bg-white rounded-xl border border-gray-200" />
        ))}
      </div>
      <div className="h-80 bg-white rounded-xl border border-gray-200" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-64 bg-white rounded-xl border border-gray-200" />
        <div className="h-64 bg-white rounded-xl border border-gray-200" />
      </div>
    </div>
  );
}

// ─── Page content ───────────────────────────────────────────────────────────
function SalesAnalyticsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const qs = searchParams.toString();

  const [data, setData] = useState<SalesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/analytics/sales${qs ? `?${qs}` : ""}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.message ?? body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setData(body as SalesResponse);
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [qs]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const selected = data?.filters.selected;

  function setFilter(patch: Record<string, string | null>) {
    const p = new URLSearchParams(qs);
    // The event in view must be explicit once the user starts filtering.
    if (selected?.intakeId && !p.get("intake_id")) p.set("intake_id", selected.intakeId);
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    router.push(`/admin/analytics/sales?${p.toString()}`);
  }

  // Colour per ticket type of the event (not of the filtered result).
  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    (data?.filters.ticketTypes ?? []).forEach((t, i) => map.set(t.level, SERIES[i] ?? OTHER_COLOR));
    return (type: string) => map.get(type) ?? OTHER_COLOR;
  }, [data?.filters.ticketTypes]);

  const m = data?.metrics ?? null;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1">
        <Link href="/admin/analytics" className="text-xs text-[#1a3f8a] hover:underline w-fit">
          ← Analytics
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">Sales Analytics</h1>
        <p className="text-sm text-gray-500">
          Confirmed sales by ticket line, Myanmar time (MMT). Test orders are excluded.
        </p>
      </div>

      {/* ── Filters ────────────────────────────────────────────── */}
      {data && (
        <div className="bg-white rounded-xl border border-gray-200 p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1.5fr_auto] gap-3 items-end">
          <label className="text-xs font-medium text-gray-600 min-w-0">
            Event
            <select
              className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white"
              value={selected?.intakeId ?? ""}
              onChange={(e) => {
                // Ticket types belong to an event: clear the type on change.
                const p = new URLSearchParams(qs);
                p.set("intake_id", e.target.value);
                p.delete("class_id");
                router.push(`/admin/analytics/sales?${p.toString()}`);
              }}
            >
              {data.filters.events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600">
            From
            <input
              type="date"
              className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900"
              value={selected?.from ?? ""}
              max={selected?.to ?? undefined}
              onChange={(e) => setFilter({ from: e.target.value || null })}
            />
          </label>
          <label className="text-xs font-medium text-gray-600">
            To
            <input
              type="date"
              className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900"
              value={selected?.to ?? ""}
              min={selected?.from ?? undefined}
              onChange={(e) => setFilter({ to: e.target.value || null })}
            />
          </label>
          <label className="text-xs font-medium text-gray-600 min-w-0">
            Ticket type
            <select
              className="mt-1 block w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 bg-white"
              value={selected?.classId ?? ""}
              onChange={(e) => setFilter({ class_id: e.target.value || null })}
            >
              <option value="">All types</option>
              {data.filters.ticketTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.level}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setFilter({ from: null, to: null, class_id: null })}
            className="px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Reset
          </button>
        </div>
      )}

      {/* ── States ─────────────────────────────────────────────── */}
      {loading && !data && <Skeleton />}

      {error && (
        <div className="bg-white rounded-xl border border-red-200 p-8 text-center" role="alert">
          <p className="text-sm font-medium text-red-700">Couldn&apos;t load sales analytics.</p>
          <p className="text-xs text-gray-500 mt-1">{error}</p>
          <button
            onClick={fetchData}
            className="mt-4 px-4 py-2 text-sm bg-[#1a3f8a] text-white rounded-lg hover:bg-blue-900"
          >
            Retry
          </button>
        </div>
      )}

      {!error && data && !m && (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <p className="text-base font-semibold text-gray-700">No events yet</p>
          <p className="text-sm text-gray-500 mt-1">Create an event to see its sales here.</p>
        </div>
      )}

      {!error && m && m.isEmpty && (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <p className="text-base font-semibold text-gray-700">No confirmed or rejected orders</p>
          <p className="text-sm text-gray-500 mt-1">
            Nothing matches these filters. Try a wider date range or all ticket types.
          </p>
        </div>
      )}

      {!error && m && !m.isEmpty && (
        <div className={`space-y-6 transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          <KpiRow m={m} />
          <DailyByType m={m} colorOf={colorOf} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <MixTable m={m} colorOf={colorOf} />
            <PriceTierTable m={m} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ByHour m={m} />
            <OrderSizes m={m} />
          </div>
          <Rejections m={m} />
        </div>
      )}

      {!error && data && m && <NotConverted qs={qs} intakeId={selected?.intakeId ?? null} />}
    </div>
  );
}

// ─── 1. KPI cards ───────────────────────────────────────────────────────────
function KpiRow({ m }: { m: SalesMetrics }) {
  const k = m.kpis;
  const l7 = k.last7;
  const change = l7.changePct;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
      <Kpi label="Confirmed revenue" value={formatMMK(k.revenue)} />
      <Kpi label="Tickets sold" value={num(k.tickets)} />
      <Kpi
        label="Confirmed orders"
        value={num(k.confirmedOrders)}
        sub={`Avg order ${formatMMK(k.avgOrderValue)}`}
      />
      <Kpi label="Unique buyers" value={num(k.uniqueBuyers)} />
      <Kpi
        label="Last 7 days, tickets/day"
        value={l7.lastAvg === null ? "—" : l7.lastAvg.toFixed(1)}
        tone={change === null ? undefined : change >= 0 ? "up" : "down"}
        sub={
          change !== null
            ? `${change >= 0 ? "▲ +" : "▼ "}${change.toFixed(1)}% vs prior 7 days (${l7.prevAvg!.toFixed(1)}/day)`
            : l7.lastAvg === null
              ? "Not enough days after launch"
              : "No prior 7 days to compare"
        }
      />
      <Kpi
        label="Rejected orders"
        value={num(k.rejectedOrders)}
        sub={`${formatMMK(k.rejectedValue)} · ${formatPct(k.rejectionRate)} of orders`}
      />
    </div>
  );
}

// ─── 2. Daily confirmed tickets by type (stacked) ──────────────────────────
function DailyByType({ m, colorOf }: { m: SalesMetrics; colorOf: (t: string) => string }) {
  const many = m.daily.length > 14;
  return (
    <Card title="Confirmed tickets per day" sub="By ticket type. Hover a day for counts and revenue.">
      <div className="h-72 sm:h-80" role="img" aria-label="Stacked bar chart of confirmed tickets per day by ticket type">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={m.daily} margin={{ top: 4, right: 8, left: -12, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis
              dataKey="date"
              tick={AXIS}
              tickLine={false}
              axisLine={{ stroke: "#d1d5db" }}
              tickFormatter={(v: string) => v.slice(5)}
              interval={many ? "preserveStartEnd" : 0}
              minTickGap={8}
            />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
            <Tooltip
              cursor={{ fill: "rgba(26,63,138,0.06)" }}
              content={({ active, label }) => {
                if (!active || !label) return null;
                const row = m.daily.find((d) => d.date === label);
                const rev = m.dailyRevenue[label as string] ?? {};
                if (!row) return null;
                const totalRev = Object.values(rev).reduce((s, v) => s + v, 0);
                return (
                  <TooltipBox>
                    <p className="font-semibold text-gray-900 mb-1">{label as string}</p>
                    {m.types
                      .filter((t) => Number(row[t]) > 0)
                      .map((t) => (
                        <div key={t} className="flex items-center gap-2 py-0.5">
                          <Swatch color={colorOf(t)} />
                          <span className="flex-1">{t}</span>
                          <span className="tabular-nums">{num(Number(row[t]))}</span>
                          <span className="tabular-nums text-gray-500">{formatMMK(rev[t] ?? 0)}</span>
                        </div>
                      ))}
                    <div className="border-t border-gray-100 mt-1 pt-1 flex gap-2 font-medium">
                      <span className="flex-1">Total</span>
                      <span className="tabular-nums">{num(row.total)}</span>
                      <span className="tabular-nums">{formatMMK(totalRev)}</span>
                    </div>
                  </TooltipBox>
                );
              }}
            />
            <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12, color: "#374151" }} />
            {m.types.map((t) => (
              <Bar key={t} dataKey={t} stackId="day" fill={colorOf(t)} stroke="#ffffff" strokeWidth={1} maxBarSize={36} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

// ─── 3. Ticket mix ──────────────────────────────────────────────────────────
function MixTable({ m, colorOf }: { m: SalesMetrics; colorOf: (t: string) => string }) {
  return (
    <Card title="Ticket mix" sub="Confirmed tickets, by revenue.">
      {m.mix.length === 0 ? (
        <EmptyNote>No confirmed tickets.</EmptyNote>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full min-w-[440px] text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                <th className="py-2 px-4 sm:px-2 font-medium">Type</th>
                <th className="py-2 px-2 font-medium text-right">Tickets</th>
                <th className="py-2 px-2 font-medium text-right">Revenue</th>
                <th className="py-2 px-2 font-medium text-right">Share</th>
                <th className="py-2 px-4 sm:px-2 font-medium text-right">Avg price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 tabular-nums">
              {m.mix.map((r) => (
                <tr key={r.type}>
                  <td className="py-2 px-4 sm:px-2">
                    <span className="flex items-center gap-2">
                      <Swatch color={colorOf(r.type)} />
                      {r.type}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right">{num(r.tickets)}</td>
                  <td className="py-2 px-2 text-right whitespace-nowrap">{formatMMK(r.revenue)}</td>
                  <td className="py-2 px-2 text-right">{formatPct(r.share)}</td>
                  <td className="py-2 px-4 sm:px-2 text-right whitespace-nowrap">{formatMMK(r.avgPrice)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-200 font-semibold tabular-nums">
                <td className="py-2 px-4 sm:px-2">Total</td>
                <td className="py-2 px-2 text-right">{num(m.kpis.tickets)}</td>
                <td className="py-2 px-2 text-right whitespace-nowrap">{formatMMK(m.kpis.revenue)}</td>
                <td className="py-2 px-2 text-right">{m.kpis.revenue > 0 ? "100.0%" : "—"}</td>
                <td className="py-2 px-4 sm:px-2 text-right whitespace-nowrap">
                  {formatMMK(m.kpis.tickets > 0 ? m.kpis.revenue / m.kpis.tickets : null)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

// ─── 4. Price tiers ─────────────────────────────────────────────────────────
function PriceTierTable({ m }: { m: SalesMetrics }) {
  return (
    <Card title="Price tiers" sub="Unit price = line fee ÷ qty. Dates in MMT.">
      {m.priceTiers.length === 0 ? (
        <EmptyNote>No confirmed tickets.</EmptyNote>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full min-w-[460px] text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                <th className="py-2 px-4 sm:px-2 font-medium">Type</th>
                <th className="py-2 px-2 font-medium text-right">Unit price</th>
                <th className="py-2 px-2 font-medium text-right">Tickets</th>
                <th className="py-2 px-2 font-medium">First sale</th>
                <th className="py-2 px-4 sm:px-2 font-medium">Last sale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 tabular-nums">
              {m.priceTiers.map((r) => (
                <tr key={`${r.type}-${r.unit_price}`}>
                  <td className="py-2 px-4 sm:px-2">{r.type}</td>
                  <td className="py-2 px-2 text-right whitespace-nowrap">{formatMMK(Number(r.unit_price))}</td>
                  <td className="py-2 px-2 text-right">{num(Number(r.tickets))}</td>
                  <td className="py-2 px-2 whitespace-nowrap">{r.first_date}</td>
                  <td className="py-2 px-4 sm:px-2 whitespace-nowrap">{r.last_date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ─── Shared single-series bar ───────────────────────────────────────────────
function SingleBar<T extends object>({
  data,
  xKey,
  yKey,
  label,
  xFormat,
  tooltip,
  ariaLabel,
  yFormat,
  yMax,
}: {
  data: T[];
  xKey: keyof T & string;
  yKey: keyof T & string;
  label: string;
  ariaLabel: string;
  xFormat?: (v: string | number) => string;
  yFormat?: (v: number) => string;
  yMax?: number;
  tooltip: (row: T) => React.ReactNode;
}) {
  return (
    <div className="h-60" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }} barCategoryGap="18%">
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis
            dataKey={xKey}
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: "#d1d5db" }}
            tickFormatter={xFormat}
            interval="preserveStartEnd"
            minTickGap={4}
          />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            allowDecimals={!!yFormat}
            tickFormatter={yFormat}
            domain={yMax !== undefined ? [0, yMax] : undefined}
            width={44}
          />
          <Tooltip
            cursor={{ fill: "rgba(26,63,138,0.06)" }}
            content={({ active, payload }) =>
              active && payload?.[0] ? <TooltipBox>{tooltip(payload[0].payload as T)}</TooltipBox> : null
            }
          />
          <Bar dataKey={yKey} name={label} fill={SINGLE} radius={[4, 4, 0, 0]} maxBarSize={32} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── 5. By hour ─────────────────────────────────────────────────────────────
function ByHour({ m }: { m: SalesMetrics }) {
  const pad = (h: number) => String(h).padStart(2, "0");
  return (
    <Card title="Confirmed tickets by hour of day" sub="Hour the order was placed, MMT.">
      <SingleBar
        data={m.byHour}
        xKey="hour"
        yKey="tickets"
        label="Tickets"
        ariaLabel="Bar chart of confirmed tickets by hour of day"
        xFormat={(v) => pad(Number(v))}
        tooltip={(r) => (
          <>
            <p className="font-semibold text-gray-900">
              {pad(r.hour)}:00–{pad(r.hour)}:59
            </p>
            <p>{num(r.tickets)} tickets</p>
          </>
        )}
      />
    </Card>
  );
}

// ─── 6. Tickets per order ───────────────────────────────────────────────────
function OrderSizes({ m }: { m: SalesMetrics }) {
  return (
    <Card title="Confirmed orders by tickets per order" sub="Tickets in the order (all lines).">
      <SingleBar
        data={m.orderSizes}
        xKey="bucket"
        yKey="orders"
        label="Orders"
        ariaLabel="Bar chart of confirmed orders by number of tickets per order"
        tooltip={(r) => (
          <>
            <p className="font-semibold text-gray-900">
              {r.bucket} ticket{r.bucket === "1" ? "" : "s"}
            </p>
            <p>{num(r.orders)} orders</p>
          </>
        )}
      />
    </Card>
  );
}

// ─── 7. Rejections ──────────────────────────────────────────────────────────
function Rejections({ m }: { m: SalesMetrics }) {
  const data = m.dailyRejection.map((d) => ({ ...d, pct: d.rate === null ? 0 : d.rate * 100 }));
  const r = m.recovery;
  return (
    <Card title="Daily rejection rate" sub="Rejected orders ÷ (rejected + confirmed orders), by order date.">
      <SingleBar
        data={data}
        xKey="date"
        yKey="pct"
        label="Rejection rate"
        ariaLabel="Bar chart of the daily order rejection rate"
        xFormat={(v) => String(v).slice(5)}
        yFormat={(v) => `${Math.round(v)}%`}
        yMax={100}
        tooltip={(d) => (
          <>
            <p className="font-semibold text-gray-900">{d.date}</p>
            <p>{d.rate === null ? "No orders" : `${(d.rate * 100).toFixed(1)}% rejected`}</p>
            <p className="text-gray-500">
              {num(d.rejected)} rejected · {num(d.confirmed)} confirmed
            </p>
          </>
        )}
      />
      <p className="text-sm text-gray-700 mt-3">
        {r.rejectedBuyers === 0 ? (
          "No buyers had an order rejected."
        ) : (
          <>
            <span className="font-semibold">Recovery:</span> {num(r.recoveredBuyers)} of {num(r.rejectedBuyers)} buyers
            with a rejected order also have a confirmed order ({formatPct(r.rate)}).{" "}
            {num(r.rejectedBuyers - r.recoveredBuyers)} have not converted.
          </>
        )}
      </p>
    </Card>
  );
}

// ─── 8. Not converted ───────────────────────────────────────────────────────
function NotConverted({ qs, intakeId }: { qs: string; intakeId: string | null }) {
  const [rows, setRows] = useState<NotConvertedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const query = useMemo(() => {
    const p = new URLSearchParams(qs);
    if (intakeId && !p.get("intake_id")) p.set("intake_id", intakeId);
    return p.toString();
  }, [qs, intakeId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/analytics/sales/not-converted?${query}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.message ?? body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setRows(body.rows as NotConvertedRow[]);
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  const buyers = rows ? new Set(rows.map((r) => `${r.email.trim().toLowerCase()}${r.phone}`)).size : 0;
  const csvHref = `/api/admin/analytics/sales/not-converted?${query}${query ? "&" : ""}format=csv`;

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-800">Not converted</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Buyers whose every order for this event was rejected, for follow-up. Contains contact details. Don&apos;t
            share outside the team.
          </p>
        </div>
        {rows && rows.length > 0 && (
          <a
            href={csvHref}
            className="shrink-0 inline-flex items-center justify-center px-3 py-2 text-sm rounded-lg bg-[#1a3f8a] text-white hover:bg-blue-900"
          >
            Export CSV
          </a>
        )}
      </div>

      <div className="mt-4">
        {loading && !rows && <div className="h-24 bg-gray-50 rounded-lg animate-pulse" aria-busy="true" />}
        {error && (
          <div className="text-center py-6" role="alert">
            <p className="text-sm text-red-700">Couldn&apos;t load the list. {error}</p>
            <button onClick={load} className="mt-2 px-3 py-1.5 text-sm border border-gray-300 rounded-lg">
              Retry
            </button>
          </div>
        )}
        {!error && rows && rows.length === 0 && <EmptyNote>Every buyer with a rejected order also has another order.</EmptyNote>}
        {!error && rows && rows.length > 0 && (
          <>
            <p className="text-xs text-gray-500 mb-2">
              {num(buyers)} buyer{buyers === 1 ? "" : "s"}, {num(rows.length)} ticket line{rows.length === 1 ? "" : "s"}
            </p>
            <div className="overflow-x-auto -mx-4 sm:mx-0 max-h-[480px] overflow-y-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                    <th className="py-2 px-4 sm:px-2 font-medium">Ref</th>
                    <th className="py-2 px-2 font-medium">Name</th>
                    <th className="py-2 px-2 font-medium">Email</th>
                    <th className="py-2 px-2 font-medium">Phone</th>
                    <th className="py-2 px-2 font-medium">Ticket type</th>
                    <th className="py-2 px-2 font-medium text-right">Qty</th>
                    <th className="py-2 px-2 font-medium text-right">Fee</th>
                    <th className="py-2 px-4 sm:px-2 font-medium">Date (MMT)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.map((r, i) => (
                    <tr key={`${r.ref}-${r.ticketType}-${i}`}>
                      <td className="py-2 px-4 sm:px-2">
                        <code className="text-xs font-mono text-[#1a3f8a] font-semibold whitespace-nowrap">{r.ref}</code>
                      </td>
                      <td className="py-2 px-2 text-gray-800">{r.name || "—"}</td>
                      <td className="py-2 px-2 text-gray-600 text-xs break-all">{r.email || "—"}</td>
                      <td className="py-2 px-2 text-gray-600 text-xs whitespace-nowrap tabular-nums">{r.phone || "—"}</td>
                      <td className="py-2 px-2 whitespace-nowrap">{r.ticketType}</td>
                      <td className="py-2 px-2 text-right tabular-nums">{num(r.qty)}</td>
                      <td className="py-2 px-2 text-right tabular-nums whitespace-nowrap">{formatMMK(r.fee)}</td>
                      <td className="py-2 px-4 sm:px-2 whitespace-nowrap tabular-nums text-xs">
                        {r.date} {r.time}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export default function SalesAnalyticsPage() {
  return (
    <Suspense fallback={<div className="p-6"><Skeleton /></div>}>
      <SalesAnalyticsContent />
    </Suspense>
  );
}
