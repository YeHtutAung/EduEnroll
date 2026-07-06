import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }));

import { resolveTenantId } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET, PATCH } from "@/app/api/public/enrollment/[ref]/route";

// ─── Supabase query builder factory ──────────────────────────────────────────

function makeSupabaseMock(singleResult: { data: unknown; error: unknown }) {
  const single = vi.fn().mockResolvedValue(singleResult);
  const eq     = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single }), single });
  const select = vi.fn().mockReturnValue({ eq });
  const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  return { from: vi.fn().mockReturnValue({ select, eq, update }) };
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
