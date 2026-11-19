// ─── Sales analytics: shared types, filter parsing and derived metrics ──────
//
// The database (public.sales_analytics) returns raw sums and counts; the
// ratios below are derived here so the definitions live in one tested place.
// Nothing in this module carries buyer names, emails or phones.

export const DEFAULT_EVENT_NAME = "Sky Festival 2026";

export interface SalesFilters {
  intakeId: string | null;
  from: string | null; // YYYY-MM-DD, MMT, inclusive
  to: string | null; // YYYY-MM-DD, MMT, inclusive
  classId: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Parses ?intake_id&from&to&class_id. Returns an error message for bad input. */
export function parseSalesFilters(
  params: URLSearchParams,
): { filters: SalesFilters } | { error: string } {
  const pick = (k: string) => {
    const v = params.get(k)?.trim();
    return v ? v : null;
  };
  const intakeId = pick("intake_id");
  const classId = pick("class_id");
  const from = pick("from");
  const to = pick("to");

  if (intakeId && !UUID_RE.test(intakeId)) return { error: "intake_id must be a uuid." };
  if (classId && !UUID_RE.test(classId)) return { error: "class_id must be a uuid." };
  if (from && !isRealDate(from)) return { error: "from must be YYYY-MM-DD." };
  if (to && !isRealDate(to)) return { error: "to must be YYYY-MM-DD." };
  if (from && to && from > to) return { error: "from must not be after to." };

  return { filters: { intakeId, from, to, classId } };
}

/** Event chosen when none is given: the named default, else the newest. */
export function pickDefaultIntake<T extends { id: string; name: string }>(
  intakes: T[],
): T | null {
  return intakes.find((i) => i.name.trim() === DEFAULT_EVENT_NAME) ?? intakes[0] ?? null;
}

// ─── Raw shape returned by public.sales_analytics ───────────────────────────
export interface RawSalesAnalytics {
  kpis: {
    revenue: number;
    tickets: number;
    confirmed_orders: number;
    unique_buyers: number;
    rejected_orders: number;
    rejected_value: number;
    last7: {
      anchor: string;
      launch: string | null;
      last_days: number | null;
      last_tickets: number | null;
      prev_days: number | null;
      prev_tickets: number | null;
    };
  };
  daily: {
    date: string;
    types: { type: string; tickets: number; revenue: number }[];
    confirmed_orders: number;
    rejected_orders: number;
  }[];
  mix: { type: string; tickets: number; revenue: number }[];
  price_tiers: {
    type: string;
    unit_price: number;
    tickets: number;
    first_date: string;
    last_date: string;
  }[];
  by_hour: { hour: number; tickets: number }[];
  order_sizes: { bucket: string; orders: number }[];
  recovery: { rejected_buyers: number; recovered_buyers: number };
}

// ─── Shape the page renders ─────────────────────────────────────────────────
export interface SalesMetrics {
  kpis: {
    revenue: number;
    tickets: number;
    confirmedOrders: number;
    avgOrderValue: number | null;
    uniqueBuyers: number;
    rejectedOrders: number;
    rejectedValue: number;
    rejectionRate: number | null; // 0..1
    last7: {
      anchor: string;
      launch: string | null;
      lastAvg: number | null; // tickets / day
      prevAvg: number | null;
      lastDays: number;
      prevDays: number;
      changePct: number | null; // e.g. 12.5 for +12.5 %
    };
  };
  types: string[]; // ticket types, in display order
  daily: ({ date: string; total: number } & Record<string, number | string>)[];
  dailyRevenue: Record<string, Record<string, number>>; // date → type → revenue
  mix: { type: string; tickets: number; revenue: number; share: number | null; avgPrice: number | null }[];
  priceTiers: RawSalesAnalytics["price_tiers"];
  byHour: RawSalesAnalytics["by_hour"];
  orderSizes: RawSalesAnalytics["order_sizes"];
  dailyRejection: { date: string; rate: number | null; rejected: number; confirmed: number }[];
  recovery: { rejectedBuyers: number; recoveredBuyers: number; rate: number | null };
  isEmpty: boolean;
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/** Sorts "Day 1".."Day 9" numerically, then "All Day", then anything else A–Z. */
export function compareTicketTypes(a: string, b: string): number {
  const rank = (t: string): [number, number, string] => {
    const m = /^day\s*(\d+)$/i.exec(t.trim());
    if (m) return [0, Number(m[1]), t];
    if (/^all\s*day$/i.test(t.trim())) return [1, 0, t];
    return [2, 0, t];
  };
  const [ga, na, sa] = rank(a);
  const [gb, nb, sb] = rank(b);
  return ga - gb || na - nb || sa.localeCompare(sb);
}

export function deriveSalesMetrics(raw: RawSalesAnalytics): SalesMetrics {
  const k = raw.kpis;
  const n = (v: number | null | undefined) => Number(v ?? 0);

  const lastDays = n(k.last7.last_days);
  const prevDays = n(k.last7.prev_days);
  const lastAvg = lastDays > 0 ? n(k.last7.last_tickets) / lastDays : null;
  const prevAvg = prevDays > 0 ? n(k.last7.prev_tickets) / prevDays : null;
  const changePct =
    lastAvg !== null && prevAvg !== null && prevAvg > 0 ? ((lastAvg - prevAvg) / prevAvg) * 100 : null;

  const typeSet = new Set<string>();
  raw.mix.forEach((m) => typeSet.add(m.type));
  raw.daily.forEach((d) => d.types.forEach((t) => typeSet.add(t.type)));
  const types = Array.from(typeSet).sort(compareTicketTypes);

  const dailyRevenue: SalesMetrics["dailyRevenue"] = {};
  const daily = raw.daily.map((d) => {
    const row: { date: string; total: number } & Record<string, number | string> = { date: d.date, total: 0 };
    dailyRevenue[d.date] = {};
    for (const t of types) row[t] = 0;
    for (const t of d.types) {
      row[t.type] = n(t.tickets);
      row.total += n(t.tickets);
      dailyRevenue[d.date][t.type] = n(t.revenue);
    }
    return row;
  });

  const revenue = n(k.revenue);
  const mix = [...raw.mix]
    .sort((a, b) => n(b.revenue) - n(a.revenue) || compareTicketTypes(a.type, b.type))
    .map((m) => ({
      type: m.type,
      tickets: n(m.tickets),
      revenue: n(m.revenue),
      share: ratio(n(m.revenue), revenue),
      avgPrice: ratio(n(m.revenue), n(m.tickets)),
    }));

  const priceTiers = [...raw.price_tiers].sort(
    (a, b) => compareTicketTypes(a.type, b.type) || n(a.unit_price) - n(b.unit_price),
  );

  const confirmedOrders = n(k.confirmed_orders);
  const rejectedOrders = n(k.rejected_orders);

  return {
    kpis: {
      revenue,
      tickets: n(k.tickets),
      confirmedOrders,
      avgOrderValue: ratio(revenue, confirmedOrders),
      uniqueBuyers: n(k.unique_buyers),
      rejectedOrders,
      rejectedValue: n(k.rejected_value),
      rejectionRate: ratio(rejectedOrders, rejectedOrders + confirmedOrders),
      last7: { anchor: k.last7.anchor, launch: k.last7.launch, lastAvg, prevAvg, lastDays, prevDays, changePct },
    },
    types,
    daily,
    dailyRevenue,
    mix,
    priceTiers,
    byHour: raw.by_hour ?? [],
    orderSizes: raw.order_sizes ?? [],
    dailyRejection: raw.daily.map((d) => ({
      date: d.date,
      confirmed: n(d.confirmed_orders),
      rejected: n(d.rejected_orders),
      rate: ratio(n(d.rejected_orders), n(d.rejected_orders) + n(d.confirmed_orders)),
    })),
    recovery: {
      rejectedBuyers: n(raw.recovery.rejected_buyers),
      recoveredBuyers: n(raw.recovery.recovered_buyers),
      rate: ratio(n(raw.recovery.recovered_buyers), n(raw.recovery.rejected_buyers)),
    },
    isEmpty: confirmedOrders === 0 && rejectedOrders === 0,
  };
}

// ─── Formatting ─────────────────────────────────────────────────────────────
/** 1379000 → "1,379,000 MMK" (Arabic numerals, thousands separators). */
export function formatMMK(amount: number | null): string {
  if (amount === null) return "—";
  return `${Math.round(amount).toLocaleString("en-US")} MMK`;
}

export function formatPct(r: number | null, digits = 1): string {
  return r === null ? "—" : `${(r * 100).toFixed(digits)}%`;
}

/**
 * Quotes a CSV cell and neutralises spreadsheet formula injection: names and
 * emails come from a public form, so a leading = + - @ or control character
 * is forced to text with an apostrophe (same rule as the interest export).
 */
export function csvCell(value: string): string {
  const dangerous = /^[=+\-@\t\r]/.test(value);
  const escaped = (dangerous ? `'${value}` : value).replace(/"/g, '""');
  return `"${escaped}"`;
}

/** MMT (UTC+06:30, no DST) date and time for an ISO timestamp. */
export function toMMT(iso: string): { date: string; time: string } {
  const d = new Date(new Date(iso).getTime() + 390 * 60_000);
  const s = d.toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}
