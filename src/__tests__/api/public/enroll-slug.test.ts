import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api", () => ({ resolveTenantId: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { resolveTenantId } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET } from "@/app/api/public/enroll/[slug]/route";

// ─── Supabase query builder factory ──────────────────────────────────────────
//
// The route chains a variable number of `.eq()` / `.in()` / `.not()` /
// `.order()` / `.limit()` calls before awaiting the builder (or calling
// `.single()` / `.maybeSingle()`). Rather than replicate each exact chain,
// this returns one object that is both chainable (every method returns
// itself) and awaitable (resolves to the configured result), regardless of
// which methods were called or how many times.

function chainable(result: { data: unknown; error?: unknown }) {
  const resolved = { error: null, ...result };
  const obj: Record<string, unknown> = {
    then: (resolve: (v: unknown) => void) => resolve(resolved),
  };
  for (const method of ["select", "eq", "in", "not", "order", "limit", "single", "maybeSingle"]) {
    obj[method] = vi.fn().mockReturnValue(obj);
  }
  return obj;
}

interface MockOptions {
  appearance?: { data: unknown; error?: unknown };
  tenant?: { data: unknown; error?: unknown };
  intakes?: { data: unknown; error?: unknown };
  classes?: { data: unknown; error?: unknown };
}

function makeSupabaseMock(opts: MockOptions = {}) {
  const appearanceResult = opts.appearance ?? { data: null, error: null };
  const tenantResult = opts.tenant ?? {
    data: { name: "Test School", org_type: "event", currency: "MMK", label_intake: null, label_class: null, label_student: null, label_seat: null, label_fee: null },
    error: null,
  };
  const intakesResult = opts.intakes ?? { data: [], error: null };
  const classesResult = opts.classes ?? { data: [], error: null };

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "tenant_appearance") return chainable(appearanceResult);
      if (table === "tenants") return chainable(tenantResult);
      if (table === "intakes") return chainable(intakesResult);
      if (table === "classes") return chainable(classesResult);
      return chainable({ data: null, error: null });
    }),
  };
}

function makeRequest() {
  return new Request("http://localhost/api/public/enroll/summer-fest", { method: "GET" });
}

const routeParams = { params: { slug: "summer-fest" } };

const BASE_INTAKE = {
  id: "intake-1",
  name: "Summer Fest",
  year: 2026,
  status: "open",
  hero_image_url: null,
};

function makeClass(overrides: Record<string, unknown>) {
  return {
    id: "class-1",
    level: "GA",
    fee_amount: 10000,
    seat_remaining: 50,
    seat_total: 100,
    enrollment_open_at: null,
    enrollment_close_at: null,
    status: "open",
    mode: "offline",
    event_date: null,
    start_time: null,
    end_time: null,
    venue: null,
    image_url: null,
    max_tickets_per_person: 4,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/public/enroll/[slug] — priority window fields", () => {
  beforeEach(() => {
    vi.mocked(resolveTenantId).mockResolvedValue("tenant-uuid");
    vi.useRealTimers();
  });

  it("returns the intake's priority_open_at and covers a tier still behind it", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
    const priorityOpen = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // +30m

    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        intakes: { data: [{ ...BASE_INTAKE, priority_open_at: priorityOpen }], error: null },
        classes: {
          data: [makeClass({ id: "class-future", level: "VIP", enrollment_open_at: future })],
          error: null,
        },
      }) as never,
    );

    const res = await GET(makeRequest() as never, routeParams);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.intake.priority_open_at).toBe(priorityOpen);
    expect(body.priority_covered_class_ids).toEqual(["class-future"]);
  });

  it("excludes a tier that is already on public sale (past enrollment_open_at)", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // -1h

    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        intakes: { data: [{ ...BASE_INTAKE, priority_open_at: null }], error: null },
        classes: {
          data: [makeClass({ id: "class-open", level: "GA", enrollment_open_at: past })],
          error: null,
        },
      }) as never,
    );

    const res = await GET(makeRequest() as never, routeParams);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.intake.priority_open_at).toBeNull();
    expect(body.priority_covered_class_ids).toEqual([]);
  });

  it("excludes a tier with no enrollment_open_at (already unconditionally public)", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        intakes: { data: [{ ...BASE_INTAKE, priority_open_at: null }], error: null },
        classes: {
          data: [makeClass({ id: "class-null", level: "GA", enrollment_open_at: null })],
          error: null,
        },
      }) as never,
    );

    const res = await GET(makeRequest() as never, routeParams);
    const body = await res.json();

    expect(body.priority_covered_class_ids).toEqual([]);
  });

  it("covers only the tiers still gated when the event has a mix of open and gated tiers", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    vi.mocked(createAdminClient).mockReturnValue(
      makeSupabaseMock({
        intakes: { data: [{ ...BASE_INTAKE, priority_open_at: past }], error: null },
        classes: {
          data: [
            makeClass({ id: "class-vip", level: "N2", enrollment_open_at: future }),
            makeClass({ id: "class-ga", level: "N5", enrollment_open_at: past }),
          ],
          error: null,
        },
      }) as never,
    );

    const res = await GET(makeRequest() as never, routeParams);
    const body = await res.json();

    expect(body.priority_covered_class_ids).toEqual(["class-vip"]);
  });
});
