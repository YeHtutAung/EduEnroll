import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthContext } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, requireOwner: vi.fn(), requireAuth: vi.fn() };
});

import { requireOwner } from "@/lib/api";
import { PATCH } from "@/app/api/intakes/[id]/route";

/**
 * The exact message the cross-table trigger raises
 * (assert_priority_window_valid, in
 * 20260827120000_event_interest_priority_window.sql). Copied verbatim so this
 * test breaks if the migration's wording drifts away from what the route
 * matches on.
 */
const TRIGGER_MESSAGE =
  "priority_open_at must not be later than any ticket tier's enrollment_open_at";

interface UpdateCapture {
  payload: Record<string, unknown> | null;
  eqs: Record<string, unknown>;
}

function makeSupabase(result: { data?: unknown; error?: unknown }, capture: UpdateCapture) {
  const resolved = { data: null, error: null, ...result };
  const obj: Record<string, unknown> = {};
  obj.from = vi.fn().mockReturnValue(obj);
  obj.update = vi.fn((payload: Record<string, unknown>) => {
    capture.payload = payload;
    return obj;
  });
  obj.eq = vi.fn((col: string, val: unknown) => {
    capture.eqs[col] = val;
    return obj;
  });
  obj.select = vi.fn().mockReturnValue(obj);
  obj.single = vi.fn().mockResolvedValue(resolved);
  return obj;
}

function request(body: unknown) {
  return new Request("http://acme.localhost/api/intakes/intake-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

beforeEach(() => vi.clearAllMocks());

describe("PATCH /api/intakes/[id] — priority_open_at", () => {
  it("accepts an ISO string and scopes the write to the caller's tenant", async () => {
    const capture: UpdateCapture = { payload: null, eqs: {} };
    authWith(makeSupabase({ data: { id: "intake-1" } }, capture));

    const res = await PATCH(request({ priority_open_at: "2026-09-01T10:00:00.000Z" }) as never, {
      params: { id: "intake-1" },
    });

    expect(res.status).toBe(200);
    expect(capture.payload).toMatchObject({ priority_open_at: "2026-09-01T10:00:00.000Z" });
    expect(capture.eqs).toMatchObject({ id: "intake-1", tenant_id: "tenant-owner" });
  });

  it("accepts null to clear the window", async () => {
    const capture: UpdateCapture = { payload: null, eqs: {} };
    authWith(makeSupabase({ data: { id: "intake-1" } }, capture));

    const res = await PATCH(request({ priority_open_at: null }) as never, {
      params: { id: "intake-1" },
    });

    expect(res.status).toBe(200);
    expect(capture.payload).toHaveProperty("priority_open_at", null);
  });

  it("rejects a non-string, non-null value", async () => {
    const capture: UpdateCapture = { payload: null, eqs: {} };
    authWith(makeSupabase({ data: { id: "intake-1" } }, capture));

    const res = await PATCH(request({ priority_open_at: 1759312800 }) as never, {
      params: { id: "intake-1" },
    });

    expect(res.status).toBe(400);
    expect(capture.payload).toBeNull();
  });

  it("turns the trigger's exception into a readable validation message, not a raw database error", async () => {
    const capture: UpdateCapture = { payload: null, eqs: {} };
    authWith(
      makeSupabase({ data: null, error: { code: "P0001", message: TRIGGER_MESSAGE } }, capture),
    );

    const res = await PATCH(request({ priority_open_at: "2026-12-01T10:00:00.000Z" }) as never, {
      params: { id: "intake-1" },
    });

    // 400, not 404: the organiser's date is the problem, and telling them the
    // intake does not exist would send them looking in the wrong place.
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.message).toMatch(/priority window/i);
    expect(body.message).toMatch(/sale time/i);
    // None of the database's own vocabulary reaches the organiser.
    expect(body.message).not.toContain("P0001");
    expect(body.message).not.toContain("enrollment_open_at");
    expect(body.message).not.toContain("priority_open_at");
  });

  it("still reports an unrelated write failure as not found", async () => {
    // Keyed on the message, not on SQLSTATE: P0001 is the generic plpgsql
    // RAISE code, shared with every other hand-written check in the schema.
    const capture: UpdateCapture = { payload: null, eqs: {} };
    authWith(
      makeSupabase(
        { data: null, error: { code: "P0001", message: "seat_remaining must not go negative" } },
        capture,
      ),
    );

    const res = await PATCH(request({ priority_open_at: "2026-09-01T10:00:00.000Z" }) as never, {
      params: { id: "intake-1" },
    });

    expect(res.status).toBe(404);
  });
});
