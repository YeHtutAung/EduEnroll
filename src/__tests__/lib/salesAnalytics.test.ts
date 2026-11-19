import { describe, expect, it } from "vitest";
import {
  compareTicketTypes,
  csvCell,
  deriveSalesMetrics,
  formatMMK,
  parseSalesFilters,
  pickDefaultIntake,
  toMMT,
  type RawSalesAnalytics,
} from "@/lib/analytics/sales";

const raw = (over: Partial<RawSalesAnalytics> = {}): RawSalesAnalytics => ({
  kpis: {
    revenue: 1_379_000,
    tickets: 37,
    confirmed_orders: 27,
    unique_buyers: 9,
    rejected_orders: 15,
    rejected_value: 364_000,
    last7: { anchor: "2026-11-08", launch: "2026-11-02", last_days: 5, last_tickets: 23, prev_days: null, prev_tickets: null },
  },
  daily: [
    { date: "2026-11-05", types: [{ type: "Day 1", tickets: 4, revenue: 120_000 }, { type: "All Day", tickets: 2, revenue: 200_000 }], confirmed_orders: 10, rejected_orders: 2 },
    { date: "2026-11-06", types: [], confirmed_orders: 0, rejected_orders: 0 },
  ],
  mix: [
    { type: "Day 1", tickets: 5, revenue: 165_000 },
    { type: "All Day", tickets: 6, revenue: 840_000 },
  ],
  price_tiers: [
    { type: "Day 1", unit_price: 45_000, tickets: 1, first_date: "2026-11-03", last_date: "2026-11-03" },
    { type: "Day 1", unit_price: 30_000, tickets: 4, first_date: "2026-11-05", last_date: "2026-11-05" },
  ],
  by_hour: [{ hour: 19, tickets: 10 }],
  order_sizes: [{ bucket: "1", orders: 22 }],
  recovery: { rejected_buyers: 13, recovered_buyers: 5 },
  ...over,
});

describe("deriveSalesMetrics", () => {
  const m = deriveSalesMetrics(raw());

  it("derives the KPI ratios from the database sums", () => {
    expect(m.kpis.revenue).toBe(1_379_000);
    expect(m.kpis.avgOrderValue).toBeCloseTo(1_379_000 / 27);
    expect(m.kpis.rejectionRate).toBeCloseTo(15 / (15 + 27));
    expect(m.recovery.rate).toBeCloseTo(5 / 13);
  });

  it("averages the last-7 window over its eligible days and has no change without a prior window", () => {
    expect(m.kpis.last7.lastAvg).toBeCloseTo(23 / 5);
    expect(m.kpis.last7.prevAvg).toBeNull();
    expect(m.kpis.last7.changePct).toBeNull();
  });

  it("computes the % change against the prior 7 days", () => {
    const r = raw();
    r.kpis.last7 = { anchor: "2026-11-30", launch: "2026-11-02", last_days: 7, last_tickets: 70, prev_days: 7, prev_tickets: 56 };
    const k = deriveSalesMetrics(r).kpis.last7;
    expect(k.lastAvg).toBe(10);
    expect(k.prevAvg).toBe(8);
    expect(k.changePct).toBeCloseTo(25);
  });

  it("builds stacked daily rows with every type, zero-filled, plus revenue for the tooltip", () => {
    expect(m.types).toEqual(["Day 1", "All Day"]);
    expect(m.daily[0]).toMatchObject({ date: "2026-11-05", "Day 1": 4, "All Day": 2, total: 6 });
    expect(m.daily[1]).toMatchObject({ date: "2026-11-06", "Day 1": 0, "All Day": 0, total: 0 });
    expect(m.dailyRevenue["2026-11-05"]["All Day"]).toBe(200_000);
  });

  it("gives each type its revenue share and average price", () => {
    const allDay = m.mix.find((x) => x.type === "All Day")!;
    expect(m.mix[0].type).toBe("All Day"); // highest revenue first
    expect(allDay.share).toBeCloseTo(840_000 / 1_379_000);
    expect(allDay.avgPrice).toBe(140_000);
  });

  it("returns a daily rejection rate, null on days with no orders", () => {
    expect(m.dailyRejection[0].rate).toBeCloseTo(2 / 12);
    expect(m.dailyRejection[1].rate).toBeNull();
  });

  it("is empty with no confirmed or rejected orders, without dividing by zero", () => {
    const e = deriveSalesMetrics(
      raw({
        kpis: { ...raw().kpis, revenue: 0, tickets: 0, confirmed_orders: 0, rejected_orders: 0, rejected_value: 0, unique_buyers: 0 },
        mix: [],
        daily: [],
        recovery: { rejected_buyers: 0, recovered_buyers: 0 },
      }),
    );
    expect(e.isEmpty).toBe(true);
    expect(e.kpis.avgOrderValue).toBeNull();
    expect(e.kpis.rejectionRate).toBeNull();
    expect(e.recovery.rate).toBeNull();
  });
});

describe("parseSalesFilters", () => {
  const p = (qs: string) => parseSalesFilters(new URLSearchParams(qs));
  it("accepts an empty query", () => {
    expect(p("")).toEqual({ filters: { intakeId: null, from: null, to: null, classId: null } });
  });
  it("rejects bad ids and dates", () => {
    expect(p("intake_id=1;drop")).toHaveProperty("error");
    expect(p("from=2026-02-30")).toHaveProperty("error");
    expect(p("from=2026-11-10&to=2026-11-01")).toHaveProperty("error");
  });
});

describe("helpers", () => {
  it("defaults to Sky Festival 2026, else the newest event", () => {
    expect(pickDefaultIntake([{ id: "a", name: "Other" }, { id: "b", name: "Sky Festival 2026" }])?.id).toBe("b");
    expect(pickDefaultIntake([{ id: "a", name: "Other" }])?.id).toBe("a");
    expect(pickDefaultIntake([])).toBeNull();
  });
  it("orders Day 1..Day 4 then All Day", () => {
    expect(["All Day", "Day 10", "Day 2", "GA", "Day 1"].sort(compareTicketTypes)).toEqual([
      "Day 1", "Day 2", "Day 10", "All Day", "GA",
    ]);
  });
  it("formats MMK with thousands separators", () => {
    expect(formatMMK(1_379_000)).toBe("1,379,000 MMK");
    expect(formatMMK(null)).toBe("—");
  });
  it("converts to Myanmar time (UTC+06:30)", () => {
    expect(toMMT("2026-11-05T17:45:00Z")).toEqual({ date: "2026-11-06", time: "00:15" });
  });
  it("neutralises formula injection in CSV cells", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell('a "b"')).toBe(`"a ""b"""`);
  });
});
