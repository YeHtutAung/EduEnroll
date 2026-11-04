import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── What a partial-payment top-up charges ──────────────────────────────────
//
// The buyer is told the saved order amount minus what was received. Every
// gateway route must charge that figure, however the tenant's fee or the ticket
// price has changed since. These drive the real routes, because each one works
// out its own charge and a single route left behind would keep the bug.

type Row = Record<string, unknown>;

vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn(async () => "ten-1") }));

let enrollment: Row;
let tenant: Row;
let history: Row[];
const charged: number[] = [];

// Answers by table. The first awaited payments chain is the history query;
// Stripe's attempt lookup comes after it and must find no live attempt.
let historyServed: boolean;

function chainFor(table: string) {
  const single = async () => {
    if (table === "enrollments") return { data: enrollment, error: null };
    if (table === "tenants") return { data: tenant, error: null };
    if (table === "payments") return { data: history[history.length - 1] ?? null, error: null };
    return { data: null, error: null };
  };
  const chain: Record<string, unknown> = { single, maybeSingle: single };
  for (const m of ["select", "update", "insert", "eq", "in", "or", "not", "is", "neq", "order", "limit"]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => unknown) => {
    const isHistory = table === "payments" && !historyServed;
    if (isHistory) historyServed = true;
    return Promise.resolve({ data: isHistory ? history : [], error: null }).then(resolve);
  };
  return chain;
}

// KBZPay and CB pass their charge to the claim before any provider call. The
// error stops them there.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: chainFor,
    rpc: vi.fn(async (_name: string, args: Row) => {
      if (typeof args?.p_amount === "number") charged.push(args.p_amount);
      return { data: null, error: { message: "stop after the claim" } };
    }),
  }),
}));

vi.mock("@/lib/abank", () => ({
  default: { createOrder: async (a: { amount: number }) => { charged.push(a.amount); return { data: { qr: "q" } }; } },
}));
vi.mock("@/lib/mmpay", () => {
  const pay = async (a: { amount: number }) => { charged.push(a.amount); return { qr: "q" }; };
  return { default: { pay, sandboxPay: pay } };
});
vi.mock("@/lib/paypay", () => ({
  default: { createQR: async (a: { amount: number }) => { charged.push(a.amount); return { data: {} }; } },
}));
vi.mock("@/lib/hitpay", () => ({
  default: { createPaymentRequest: async (a: { amount: string }) => { charged.push(Number(a.amount)); return { id: "h" }; } },
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: async (a: { line_items: { price_data: { unit_amount: number }; quantity: number }[] }) => {
          charged.push(a.line_items.reduce((sum, l) => sum + l.price_data.unit_amount * l.quantity, 0) / 100);
          return { id: "cs", url: "https://stripe.test/pay" };
        },
      },
    },
  }),
}));
vi.mock("@/server/payments/settlePaidPayment", () => ({ settlePaidPayment: vi.fn() }));
vi.mock("@/server/payments/resolveKbzpayOrder", () => ({ resolveKbzpayOrder: vi.fn() }));
vi.mock("@/server/payments/resolveCbmmqrOrder", () => ({ resolveCbmmqrOrder: vi.fn() }));

const ROUTES: Record<string, () => Promise<{ POST: (req: NextRequest) => Promise<Response> }>> = {
  abank: () => import("@/app/api/public/payments/abank/route"),
  cbmmqr: () => import("@/app/api/public/payments/cbmmqr/route"),
  hitpay: () => import("@/app/api/public/payments/hitpay/route"),
  kbzpay: () => import("@/app/api/public/payments/kbzpay/route"),
  mmpay: () => import("@/app/api/public/payments/mmpay/route"),
  paypay: () => import("@/app/api/public/payments/paypay/route"),
  stripe: () => import("@/app/api/public/payments/stripe/route"),
};

async function charge(route: string) {
  const { POST } = await ROUTES[route]();
  const res = await POST(new NextRequest("https://t.kuunyi.com/api/public/payments/x", {
    method: "POST",
    body: JSON.stringify({ enrollmentRef: "R", method: "paynow_online" }),
  }));
  return { status: res.status, amount: charged[0] };
}

const orderRow = (amount: number, platform_fee: number, received_amount: number | null) => ({
  id: "p-1", amount, platform_fee, received_amount, status: "pending", admin_note: "short", created_at: "2026-01-01T00:00:00Z",
});
const topUpRow = (amount: number) => ({
  id: "p-2", amount, platform_fee: 0, received_amount: null, status: "verified", admin_note: null, created_at: "2026-01-02T00:00:00Z",
});

function setOrder(price: number, fee: number, rows: Row[], status = "partial_payment") {
  enrollment = {
    id: "e-1", enrollment_ref: "R", tenant_id: "ten-1", class_id: "c-1", quantity: 1, status,
    enrolled_at: new Date().toISOString(), student_name_en: "T", email: null,
    classes: { id: "c-1", fee_amount: price, level: "GA", pack_size: 1, intakes: null },
    enrollment_items: null, tenants: { subdomain: "t" }, payments: rows,
  };
  tenant = {
    org_type: "event", currency: "SGD", name: "T", auto_cancel_hours: null, payment_mode: "mmqr", mmqr_provider: "abank",
    platform_fee_mode: fee > 0 ? "per_transaction" : "none", platform_fee_amount: fee,
  };
  history = rows;
}

async function statusPayment() {
  const { GET } = await import("@/app/api/public/status/route");
  const res = await GET(new NextRequest("https://t.kuunyi.com/api/public/status?ref=R"));
  historyServed = false;
  return (await res.json()).payment as Record<string, number | null>;
}

beforeEach(() => {
  charged.length = 0;
  historyServed = false;
  process.env.STRIPE_SALES_OPEN = "true";
  delete process.env.STRIPE_SMOKE_REFS;
});

describe.each(Object.keys(ROUTES))("%s top-up", (route) => {
  it("charges the saved remainder when a fee was added after the upload", async () => {
    setOrder(100_000, 3_000, [orderRow(100_000, 0, 60_000)]);
    expect((await charge(route)).amount).toBe(40_000);
  });

  it("still collects a saved fee that was removed after the upload", async () => {
    setOrder(100_000, 0, [orderRow(103_000, 3_000, 60_000)]);
    expect((await charge(route)).amount).toBe(43_000);
  });

  it("ignores a ticket price raised after the upload", async () => {
    setOrder(120_000, 0, [orderRow(100_000, 0, 60_000)]);
    expect((await charge(route)).amount).toBe(40_000);
  });

  it("charges a fee saved at upload that is unchanged", async () => {
    setOrder(100_000, 3_000, [orderRow(103_000, 3_000, 60_000)]);
    expect((await charge(route)).amount).toBe(43_000);
  });

  it("charges the saved remainder again after an abandoned top-up", async () => {
    setOrder(100_000, 3_000, [orderRow(100_000, 0, 60_000), { ...topUpRow(40_000), status: "awaiting_payment" }]);
    expect((await charge(route)).amount).toBe(40_000);
  });

  it("charges nothing when no balance is left on the saved amount", async () => {
    setOrder(100_000, 3_000, [orderRow(100_000, 0, 100_000)]);
    const { status, amount } = await charge(route);
    expect(status).toBe(409);
    expect(amount).toBeUndefined();
  });

  it("charges the full order at the current fee when no amount was recorded", async () => {
    setOrder(100_000, 3_000, [orderRow(100_000, 0, null)]);
    expect((await charge(route)).amount).toBe(103_000);
  });
});

describe("what the buyer is told", () => {
  it.each(Object.keys(ROUTES))("%s charges what the status page shows", async (route) => {
    setOrder(100_000, 3_000, [orderRow(100_000, 0, 60_000)]);
    const shown = (await statusPayment()).remaining_amount;
    expect((await charge(route)).amount).toBe(shown);
  });
});

// A settled top-up holds only the remainder and records no fee, so a receipt
// that reads it falls back to the tenant's current fee and overstates the order.
describe("the receipt after a top-up settles", () => {
  const settled = () => setOrder(100_000, 3_000, [orderRow(100_000, 0, 60_000), topUpRow(40_000)], "confirmed");

  it("status reports the saved order total and fee, and nothing owing", async () => {
    settled();
    const payment = await statusPayment();
    expect(payment).toMatchObject({ total_amount: 100_000, platform_fee: 0 });
    expect(payment.remaining_amount).toBeNull();
  });

  it("the enrollment endpoint reports the saved order total and fee", async () => {
    settled();
    const { GET } = await import("@/app/api/public/enrollment/[ref]/route");
    const res = await GET(new NextRequest("https://t.kuunyi.com/api/public/enrollment/R"), { params: { ref: "R" } });
    expect(await res.json()).toMatchObject({ total_amount: 100_000, platform_fee: 0 });
  });

  it("the enrollment endpoint keeps a saved fee the tenant has since removed", async () => {
    setOrder(100_000, 0, [orderRow(103_000, 3_000, 60_000), topUpRow(43_000)], "confirmed");
    const { GET } = await import("@/app/api/public/enrollment/[ref]/route");
    const res = await GET(new NextRequest("https://t.kuunyi.com/api/public/enrollment/R"), { params: { ref: "R" } });
    expect(await res.json()).toMatchObject({ total_amount: 103_000, platform_fee: 3_000 });
  });
});
