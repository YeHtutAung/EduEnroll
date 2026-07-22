import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }));

import { resolveTenantId } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET, PATCH } from "@/app/api/public/enrollment/[ref]/route";

// ─── Supabase query builder factory ──────────────────────────────────────────

interface MockOptions {
  /** Result for enrollments.select().eq().eq().single() */
  enrollment?: { data: unknown; error: unknown };
  /** Result for tenant_appearance.select().eq().single() */
  appearance?: { data: unknown; error: unknown };
  /** Result for tenants.select().eq().single() */
  tenant?: { data: unknown; error: unknown };
  /** Result for bank_accounts.select().eq().eq().order() */
  bankAccounts?: { data: unknown[]; error: unknown };
}

const NULL_SINGLE = { data: null, error: null };
const EMPTY_LIST  = { data: [],   error: null };

function makeChain(result: unknown) {
  const order  = vi.fn().mockResolvedValue(result);
  const single = vi.fn().mockResolvedValue(result);
  const eqInner: ReturnType<typeof vi.fn> = vi.fn().mockReturnValue({ single, order, eq: vi.fn().mockReturnValue({ single, order }) });
  const eq = vi.fn().mockReturnValue({ eq: eqInner, single, order });
  const select = vi.fn().mockReturnValue({ eq });
  const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  return { select, eq, update };
}

function makeSupabaseMock(options: MockOptions | { data: unknown; error: unknown } = {}) {
  // Legacy single-argument form (used by PATCH tests) — treat as enrollment result
  const isLegacy = "data" in options;
  const enrollmentResult  = isLegacy ? (options as { data: unknown; error: unknown }) : ((options as MockOptions).enrollment ?? NULL_SINGLE);
  const appearanceResult  = isLegacy ? NULL_SINGLE : ((options as MockOptions).appearance  ?? NULL_SINGLE);
  const tenantResult      = isLegacy ? NULL_SINGLE : ((options as MockOptions).tenant      ?? NULL_SINGLE);
  const bankResult        = isLegacy ? EMPTY_LIST  : ((options as MockOptions).bankAccounts ?? EMPTY_LIST);

  return {
    from: vi.fn().mockImplementation((table: string) => {
      // Singular — the real table. This mock answered the route's typo, so the
      // suite passed while production returned no branding.
      if (table === "tenant_appearance") return makeChain(appearanceResult);
      if (table === "tenants")            return makeChain(tenantResult);
      if (table === "bank_accounts")      return makeChain(bankResult);
      return makeChain(enrollmentResult); // enrollments (and any other table)
    }),
  };
}

function makeRequest(method = "GET", body?: unknown) {
  return new Request("http://localhost/api/public/enrollment/NM-2026-00001", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const routeParams = { params: { ref: "NM-2026-00001" } };

// ─── GET tests ────────────────────────────────────────────────────────────────

describe("GET /api/public/enrollment/[ref]", () => {
  beforeEach(() => {
    vi.mocked(resolveTenantId).mockResolvedValue("tenant-uuid");
  });

  it("returns 404 when enrollment not found", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({ data: null, error: null }) as never,
    );
    const res = await GET(makeRequest() as never, routeParams);
    expect(res.status).toBe(404);
  });

  it("returns 404 when supabase returns an error (e.g. invalid column)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({ data: null, error: { message: "column does not exist" } }) as never,
    );
    const res = await GET(makeRequest() as never, routeParams);
    expect(res.status).toBe(404);
  });

  it("returns 200 with items for a cart enrollment", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        data: {
          enrollment_ref: "NM-2026-00001",
          status: "pending_payment",
          student_name_en: "Test User",
          email: "test@example.com",
          quantity: 2,
          enrollment_items: [
            { quantity: 1, fee_amount: 5000, classes: { level: "GA" } },
            { quantity: 1, fee_amount: 3000, classes: { level: "VIP" } },
          ],
          classes: null,
          payments: [],
        },
        error: null,
      }) as never,
    );

    const res = await GET(makeRequest() as never, routeParams);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.enrollment_ref).toBe("NM-2026-00001");
    expect(body.total_amount).toBe(8000);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].level).toBe("GA");
  });

  it("returns 200 with items for a single-class enrollment", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        data: {
          enrollment_ref: "NM-2026-00001",
          status: "pending_payment",
          student_name_en: "Test User",
          email: null,
          quantity: 1,
          enrollment_items: [],
          classes: { level: "N3", fee_amount: 4000, intakes: { name: "August 2026", slug: "august-2026" } },
          payments: [],
        },
        error: null,
      }) as never,
    );

    const res = await GET(makeRequest() as never, routeParams);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total_amount).toBe(4000);
    expect(body.items[0].level).toBe("N3");
    expect(body.event_name).toBe("August 2026");
  });

  it("returns 410 when enrollment is cancelled", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        data: {
          enrollment_ref: "NM-2026-00001",
          status: "cancelled",
          student_name_en: "",
          email: null,
          quantity: 1,
          enrollment_items: [],
          classes: null,
          payments: [],
        },
        error: null,
      }) as never,
    );

    const res = await GET(makeRequest() as never, routeParams);
    expect(res.status).toBe(410);
  });

  it("returns 400 when tenant cannot be resolved", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(resolveTenantId).mockResolvedValue(
      NextResponse.json({ error: "Not Found" }, { status: 404 }),
    );
    const res = await GET(makeRequest() as never, routeParams);
    expect(res.status).toBe(404);
  });

  it("returns payment_mode and bank_accounts from tenant config", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        enrollment: {
          data: {
            enrollment_ref: "NM-2026-00001",
            status: "pending_payment",
            student_name_en: "Aung Ko",
            email: "aung@example.com",
            quantity: 1,
            enrollment_items: [],
            classes: { level: "N3", fee_amount: 5000, intakes: { id: "intake-1", name: "Oct 2026", slug: "oct-2026" } },
            payments: [],
          },
          error: null,
        },
        appearance: {
          data: {
            logo_url: "https://cdn.example.com/logo.png",
            primary_color: "#1a3f8a",
            sponsor_config: {
              presenting: { name: "Acme", logo_url: "https://cdn.example.com/acme.svg", url: "https://acme.example" },
              partners: [],
              supported_by: [],
            },
          },
          error: null,
        },
        tenant: { data: { payment_mode: "bank_transfer", mmqr_provider: null }, error: null },
        bankAccounts: {
          data: [
            { bank_name: "AYA Bank", account_number: "123456789", account_holder: "Nihon Moment", qr_code_url: null },
          ],
          error: null,
        },
      }) as never,
    );

    const res = await GET(makeRequest() as never, routeParams);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.payment_mode).toBe("bank_transfer");
    expect(body.mmqr_provider).toBeNull();
    expect(body.bank_accounts).toHaveLength(1);
    expect(body.bank_accounts[0].bank_name).toBe("AYA Bank");
    expect(body.logo_url).toBe("https://cdn.example.com/logo.png");
    expect(body.brand_color).toBe("#1a3f8a");
    expect(body.sponsor_config.presenting.name).toBe("Acme");
  });

  it("returns mmqr payment_mode and mmqr_provider", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        enrollment: {
          data: {
            enrollment_ref: "NM-2026-00002",
            status: "pending_payment",
            student_name_en: "Ma Su",
            email: "masu@example.com",
            quantity: 1,
            enrollment_items: [],
            classes: { level: "N4", fee_amount: 4000, intakes: { id: "intake-2", name: "Nov 2026", slug: "nov-2026" } },
            payments: [],
          },
          error: null,
        },
        tenant: { data: { payment_mode: "mmqr", mmqr_provider: "abank" }, error: null },
        bankAccounts: { data: [], error: null },
      }) as never,
    );

    const res = await GET(makeRequest() as never, { params: { ref: "NM-2026-00002" } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.payment_mode).toBe("mmqr");
    expect(body.mmqr_provider).toBe("abank");
    expect(body.bank_accounts).toHaveLength(0);
  });

  it("defaults to bank_transfer when tenant has no payment_mode", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        enrollment: {
          data: {
            enrollment_ref: "NM-2026-00003",
            status: "pending_payment",
            student_name_en: "Kyaw Zin",
            email: "kz@example.com",
            quantity: 1,
            enrollment_items: [],
            classes: { level: "N5", fee_amount: 3000, intakes: { id: "intake-3", name: "Jan 2027", slug: "jan-2027" } },
            payments: [],
          },
          error: null,
        },
        tenant: { data: null, error: null },
        bankAccounts: { data: [], error: null },
      }) as never,
    );

    const res = await GET(makeRequest() as never, { params: { ref: "NM-2026-00003" } });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.payment_mode).toBe("bank_transfer");
  });
});

// ─── PATCH tests ──────────────────────────────────────────────────────────────

describe("PATCH /api/public/enrollment/[ref]", () => {
  beforeEach(() => {
    vi.mocked(resolveTenantId).mockResolvedValue("tenant-uuid");
  });

  it("returns 400 when name or email is missing", async () => {
    vi.mocked(createAdminClient).mockReturnValue(makeSupabaseMock({ data: null, error: null }) as never);
    const res = await PATCH(makeRequest("PATCH", { student_name_en: "Test" }) as never, routeParams);
    expect(res.status).toBe(400);
  });

  it("returns 404 when enrollment not found", async () => {
    vi.mocked(createAdminClient).mockReturnValue(makeSupabaseMock({ data: null, error: null }) as never);
    const res = await PATCH(
      makeRequest("PATCH", { student_name_en: "Test", email: "t@t.com" }) as never,
      routeParams,
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when enrollment is no longer pending", async () => {
    const mock = makeSupabaseMock({ data: { id: "uuid", status: "confirmed" }, error: null });
    vi.mocked(createAdminClient).mockReturnValue(mock as never);
    const res = await PATCH(
      makeRequest("PATCH", { student_name_en: "Test", email: "t@t.com" }) as never,
      routeParams,
    );
    expect(res.status).toBe(409);
  });
});
