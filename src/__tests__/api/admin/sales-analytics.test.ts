import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// GET /api/admin/analytics/sales and /sales/not-converted:
// admin session only, scoped to the caller's own events, aggregates without PII.

const SKY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FOREIGN = "33333333-3333-4333-8333-333333333333";
const DAY1 = "44444444-4444-4444-8444-444444444444";

const RAW = {
  kpis: {
    revenue: 30000, tickets: 1, confirmed_orders: 1, unique_buyers: 1, rejected_orders: 0, rejected_value: 0,
    last7: { anchor: "2026-11-19", launch: "2026-11-05", last_days: 7, last_tickets: 1, prev_days: 7, prev_tickets: 0 },
  },
  daily: [{ date: "2026-11-05", types: [{ type: "Day 1", tickets: 1, revenue: 30000 }], confirmed_orders: 1, rejected_orders: 0 }],
  mix: [{ type: "Day 1", tickets: 1, revenue: 30000 }],
  price_tiers: [],
  by_hour: [],
  order_sizes: [],
  recovery: { rejected_buyers: 0, recovered_buyers: 0 },
};

const NOT_CONVERTED = [
  { ref: "SF-1", name: "=cmd", email: "a@x.com", phone: "09", ticket_type: "Day 1", qty: 2, fee: 60000, enrolled_at: "2026-11-05T13:30:00Z" },
];

const WALLETS = [{ method: "kbzpay_mmqr", wallet: "AB", orders: 1, payments: 1, amount: 30000 }];

const rpcCalls: { fn: string; args: unknown }[] = [];
function builder(result: unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) b[m] = () => b;
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return b;
}
const supabase = {
  from: vi.fn((table: string) =>
    table === "intakes"
      ? builder({ data: [{ id: OTHER, name: "Newer Event" }, { id: SKY, name: "Sky Festival 2026" }], error: null })
      : builder({ data: [{ id: DAY1, level: "Day 1" }], error: null }),
  ),
  rpc: vi.fn(async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    if (fn === "sales_analytics") return { data: RAW, error: null };
    if (fn === "sales_payment_wallets") return walletResult;
    return { data: NOT_CONVERTED, error: null };
  }),
};

let authResult: unknown;
let walletResult: { data: unknown; error: unknown };
vi.mock("@/lib/api", () => ({
  requireAuth: vi.fn(async () => authResult),
  badRequest: (message: string) => NextResponse.json({ error: "Bad Request", message }, { status: 400 }),
}));

const { GET: getSales } = await import("@/app/api/admin/analytics/sales/route");
const { GET: getNotConverted } = await import("@/app/api/admin/analytics/sales/not-converted/route");

const req = (path: string, qs = "") => new NextRequest(`http://localhost${path}${qs ? `?${qs}` : ""}`);
const asRole = (role: string, isAgent = false) => {
  authResult = { supabase, tenantId: "t-1", isAgent, user: { role } };
};

beforeEach(() => {
  rpcCalls.length = 0;
  vi.clearAllMocks();
  asRole("staff");
  walletResult = { data: WALLETS, error: null };
});

describe("GET /api/admin/analytics/sales", () => {
  it("defaults to Sky Festival 2026 and returns aggregates only", async () => {
    const res = await getSales(req("/api/admin/analytics/sales"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const args = { p_intake_id: SKY, p_from: null, p_to: null, p_class_id: null };
    expect(rpcCalls).toEqual([
      { fn: "sales_analytics", args },
      { fn: "sales_payment_wallets", args },
    ]);
    expect(body.metrics.payments.rows[0]).toMatchObject({ methodLabel: "KBZPay MMQR", wallet: "AB", orders: 1 });
    expect(body.filters.selected.intakeId).toBe(SKY);
    expect(body.metrics.kpis.revenue).toBe(30000);
    // No contact details anywhere in the aggregate response.
    expect(JSON.stringify(body)).not.toMatch(/email|phone|student_name/i);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("passes the filters through", async () => {
    await getSales(req("/api/admin/analytics/sales", `intake_id=${SKY}&from=2026-11-01&to=2026-11-10&class_id=${DAY1}`));
    const want = { p_intake_id: SKY, p_from: "2026-11-01", p_to: "2026-11-10", p_class_id: DAY1 };
    expect(rpcCalls.map((c) => c.args)).toEqual([want, want]);
  });

  it("fails the whole response when the wallet query fails", async () => {
    walletResult = { data: null, error: { code: "42883" } };
    const res = await getSales(req("/api/admin/analytics/sales"));
    expect(res.status).toBe(500);
  });

  it("404s an event of another tenant without calling the database function", async () => {
    const res = await getSales(req("/api/admin/analytics/sales", `intake_id=${FOREIGN}`));
    expect(res.status).toBe(404);
    expect(rpcCalls).toHaveLength(0);
  });

  it("400s a ticket type outside the event", async () => {
    const res = await getSales(req("/api/admin/analytics/sales", `class_id=${FOREIGN}`));
    expect(res.status).toBe(400);
  });

  it("refuses the signed bot path", async () => {
    asRole("owner", true);
    expect((await getSales(req("/api/admin/analytics/sales"))).status).toBe(403);
  });

  it("passes through an unauthenticated response", async () => {
    authResult = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    expect((await getSales(req("/api/admin/analytics/sales"))).status).toBe(401);
  });
});

describe("GET /api/admin/analytics/sales/not-converted", () => {
  it("returns the follow-up list to staff, in MMT", async () => {
    const res = await getNotConverted(req("/api/admin/analytics/sales/not-converted"));
    expect(res.status).toBe(200);
    const { rows } = await res.json();
    expect(rows[0]).toMatchObject({ ref: "SF-1", email: "a@x.com", qty: 2, fee: 60000, date: "2026-11-05", time: "20:00" });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("exports CSV with a BOM and formula-safe cells", async () => {
    const res = await getNotConverted(req("/api/admin/analytics/sales/not-converted", "format=csv"));
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="not-converted-/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // UTF-8 BOM; text() would strip it on decode.
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain(`"SF-1","'=cmd","a@x.com","09","Day 1","2","60000","2026-11-05","20:00"`);
  });

  it("refuses the signed bot path", async () => {
    asRole("owner", true);
    expect((await getNotConverted(req("/api/admin/analytics/sales/not-converted"))).status).toBe(403);
    expect(rpcCalls).toHaveLength(0);
  });
});
