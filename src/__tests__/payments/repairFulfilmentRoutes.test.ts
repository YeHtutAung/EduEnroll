import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { generateKeyPairSync } from "crypto";

// ─── Where a repair is triggered ────────────────────────────────────────────
//
// The status poll stops asking the provider once a payment is verified, so an
// order cut off mid-settlement stayed that way even while the buyer's page was
// still polling it. These routes are what give it another chance.

type Row = Record<string, unknown>;

let payment: Row | null;
let enrollment: Row;
let tenant: Row;
let tickets: Row[];

vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn(async () => "ten-1") }));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/server/payments/settleMmqrPayment", () => ({ settleMmqrPayment: vi.fn() }));
vi.mock("@/server/payments/settleCbmmqrPayment", () => ({ settleCbmmqrPayment: vi.fn() }));

const mockRepair = vi.fn();
const mockSweep = vi.fn();
vi.mock("@/server/payments/repairFulfilment", () => ({
  repairInterruptedFulfilment: (...a: unknown[]) => mockRepair(...a),
  sweepInterruptedFulfilment: (...a: unknown[]) => mockSweep(...a),
}));

function chainFor(table: string) {
  const single = async () => {
    if (table === "payments") return { data: payment, error: null };
    if (table === "enrollments") return { data: enrollment, error: null };
    if (table === "tenants") return { data: tenant, error: null };
    return { data: null, error: null };
  };
  const chain: Record<string, unknown> = { single, maybeSingle: single };
  for (const m of ["select", "eq", "in", "order", "limit"]) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) => {
    const data = table === "tickets"
      ? tickets
      : table === "intakes" ? [{ id: "i-1", ticket_qr_format: "uuid" }] : [];
    return Promise.resolve({ data, error: null }).then(resolve);
  };
  return chain;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: chainFor }),
}));

const VERIFIED = {
  enrollment_id: "e-1", status: "verified", mmqr_status: "SUCCESS", kbzpay_merchant: "M",
  payment_ref: "KBZ_1", payment_method: "kbzpay_mmqr",
};

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.TICKET_SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  process.env.TICKET_KID = "test-kid";
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRepair.mockResolvedValue(undefined);
  payment = { ...VERIFIED };
  tickets = [];
  tenant = { org_type: "event", payment_mode: "mmqr", mmqr_provider: "kbzpay", platform_fee_mode: "none", platform_fee_amount: 0 };
  enrollment = {
    id: "e-1", enrollment_ref: "R", status: "confirmed", student_name_en: "T", email: "t@example.test", quantity: 1,
    enrollment_items: null, payments: [], classes: { level: "GA", fee_amount: 1000, pack_size: 1, intakes: { id: "i-1", name: "E", slug: "e" } },
  };
});

describe("the status polls", () => {
  it("KBZPay repairs a verified order before answering SUCCESS", async () => {
    const { GET } = await import("@/app/api/public/payments/kbzpay/status/route");
    const res = await GET(new NextRequest("https://t.kuunyi.com/api/public/payments/kbzpay/status?ref=KBZ_1"));

    expect(mockRepair).toHaveBeenCalledExactlyOnceWith("e-1");
    expect(await res.json()).toEqual({ mmqr_status: "SUCCESS" });
  });

  it("CB repairs a verified order before answering SUCCESS", async () => {
    const ref = `CB${"A".repeat(23)}`;
    payment = { ...VERIFIED, payment_ref: ref, payment_method: "cb_mmqr", cbmmqr_merchant: "M" };
    const { GET } = await import("@/app/api/public/payments/cbmmqr/status/route");
    const res = await GET(new NextRequest(`https://t.kuunyi.com/api/public/payments/cbmmqr/status?ref=${ref}`));

    expect(mockRepair).toHaveBeenCalledExactlyOnceWith("e-1");
    expect(await res.json()).toEqual({ mmqr_status: "SUCCESS" });
  });

  it("KBZPay does not repair an unpaid order", async () => {
    payment = { ...VERIFIED, status: "awaiting_payment", mmqr_status: "FAILED" };
    const { GET } = await import("@/app/api/public/payments/kbzpay/status/route");
    await GET(new NextRequest("https://t.kuunyi.com/api/public/payments/kbzpay/status?ref=KBZ_1"));

    expect(mockRepair).not.toHaveBeenCalled();
  });
});

describe("the enrollment endpoint", () => {
  const load = async () => {
    const { GET } = await import("@/app/api/public/enrollment/[ref]/route");
    return GET(new NextRequest("https://t.kuunyi.com/api/public/enrollment/R"), { params: { ref: "R" } });
  };

  it("repairs a confirmed event order with no tickets and returns what it issued", async () => {
    mockRepair.mockImplementation(async () => {
      tickets = [{ id: "t-1", intake_id: "i-1", tier: "GA", admits: 1, exp: "2027-01-01T00:00:00Z", status: "valid" }];
    });

    const res = await load();

    expect(mockRepair).toHaveBeenCalledExactlyOnceWith("e-1");
    expect((await res.json()).tickets).toHaveLength(1);
  });

  it("does not repair an order that already has tickets", async () => {
    tickets = [{ id: "t-1", intake_id: "i-1", tier: "GA", admits: 1, exp: "2027-01-01T00:00:00Z", status: "valid" }];

    await load();

    expect(mockRepair).not.toHaveBeenCalled();
  });

  it("does not spend a repair on a language school order", async () => {
    tenant = { ...tenant, org_type: "language_school" };

    await load();

    expect(mockRepair).not.toHaveBeenCalled();
  });

  it("does not repair an unconfirmed order", async () => {
    enrollment = { ...enrollment, status: "pending_payment" };

    await load();

    expect(mockRepair).not.toHaveBeenCalled();
  });
});

describe("the daily cron", () => {
  const run = async (auth?: string) => {
    const { GET } = await import("@/app/api/cron/fulfilment/route");
    return GET(new NextRequest("https://kuunyi.com/api/cron/fulfilment", {
      headers: auth ? { authorization: auth } : {},
    }));
  };

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    mockSweep.mockResolvedValue({ checked: 1, repaired: 1, readFailed: false });
  });

  it("refuses a call without the secret", async () => {
    expect((await run()).status).toBe(401);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it("runs the sweep with the secret", async () => {
    const res = await run("Bearer cron-secret");

    expect(res.status).toBe(200);
    expect(mockSweep).toHaveBeenCalledOnce();
  });

  it("reports a run that could not read as failed", async () => {
    mockSweep.mockResolvedValue({ checked: 0, repaired: 0, readFailed: true });

    expect((await run("Bearer cron-secret")).status).toBe(500);
  });
});
