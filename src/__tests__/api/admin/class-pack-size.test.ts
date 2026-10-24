import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthContext } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, requireOwner: vi.fn() };
});

import { requireOwner } from "@/lib/api";
import { PATCH } from "@/app/api/classes/[id]/route";

// ─── Package tiers: pack_size is frozen once a tier has sold ────────────────
//
// issueTickets() multiplies by the CURRENT pack_size, including when it repairs
// an already-paid order. Changing it after a sale would issue the wrong number
// of admissions, so the route refuses with 409 before the
// classes_guard_pack_size trigger (20261024120000_ticket_packs.sql) has to.

const baseClass = {
  id: "class-1",
  tenant_id: "tenant-owner",
  level: "GA 3-Pack",
  fee_amount: 125000,
  seat_total: 50,
  seat_remaining: 50,
  status: "open",
  pack_size: 1,
  compare_at_amount: null,
};

function makeSupabase(existing: Record<string, unknown>, capture: { payload: Record<string, unknown> | null }) {
  const obj: Record<string, unknown> = {};
  obj.from = vi.fn().mockReturnValue(obj);
  obj.select = vi.fn().mockReturnValue(obj);
  obj.eq = vi.fn().mockReturnValue(obj);
  obj.update = vi.fn((payload: Record<string, unknown>) => {
    capture.payload = payload;
    return obj;
  });
  // First single(): the existing row. Second: the updated row.
  obj.single = vi
    .fn()
    .mockResolvedValueOnce({ data: existing, error: null })
    .mockImplementationOnce(async () => ({ data: { ...existing, ...capture.payload }, error: null }));
  return obj;
}

function authWith(supabase: unknown) {
  vi.mocked(requireOwner).mockResolvedValue({
    supabase: supabase as never,
    tenantId: "tenant-owner",
    user: {} as never,
    isAgent: false,
    agentChatId: null,
  } satisfies AuthContext);
}

function patch(body: unknown) {
  const req = new Request("http://acme.localhost/api/classes/class-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return PATCH(req as never, { params: { id: "class-1" } });
}

beforeEach(() => vi.clearAllMocks());

describe("PATCH /api/classes/[id] — package fields", () => {
  it("sets pack_size and compare_at_amount on a tier that has not sold", async () => {
    const capture = { payload: null as Record<string, unknown> | null };
    authWith(makeSupabase(baseClass, capture));

    const res = await patch({ pack_size: 3, compare_at_amount: 135000 });

    expect(res.status).toBe(200);
    expect(capture.payload).toEqual({ pack_size: 3, compare_at_amount: 135000 });
  });

  it("refuses a pack_size change once the tier has sold", async () => {
    const capture = { payload: null as Record<string, unknown> | null };
    authWith(makeSupabase({ ...baseClass, pack_size: 3, seat_remaining: 49 }, capture));

    const res = await patch({ pack_size: 2 });

    expect(res.status).toBe(409);
    expect(capture.payload).toBeNull();
  });

  it("allows other edits on a sold pack tier when pack_size is unchanged", async () => {
    const capture = { payload: null as Record<string, unknown> | null };
    authWith(makeSupabase({ ...baseClass, pack_size: 3, seat_remaining: 49 }, capture));

    const res = await patch({ pack_size: 3, compare_at_amount: null });

    expect(res.status).toBe(200);
    expect(capture.payload).toEqual({ compare_at_amount: null });
  });

  it.each([0, 21, 2.5, "3"])("rejects pack_size %p", async (value) => {
    const capture = { payload: null as Record<string, unknown> | null };
    authWith(makeSupabase(baseClass, capture));

    const res = await patch({ pack_size: value });

    expect(res.status).toBe(400);
  });

  it.each([0, -1, 1.5])("rejects compare_at_amount %p", async (value) => {
    const capture = { payload: null as Record<string, unknown> | null };
    authWith(makeSupabase(baseClass, capture));

    const res = await patch({ compare_at_amount: value });

    expect(res.status).toBe(400);
  });
});
