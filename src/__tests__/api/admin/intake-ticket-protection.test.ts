import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import type { AuthContext } from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, requireOwner: vi.fn(), requireAuth: vi.fn() };
});

import { requireAuth, requireOwner } from "@/lib/api";
import { GET, PATCH } from "@/app/api/intakes/[id]/route";

// Task 14 (design 3, 9): the "Account-bound tickets" switch on an event.

interface Capture {
  payload: Record<string, unknown> | null;
}

function patchSupabase(result: { data?: unknown; error?: unknown }, capture: Capture) {
  const resolved = { data: null, error: null, ...result };
  const obj: Record<string, unknown> = {};
  obj.from = vi.fn().mockReturnValue(obj);
  obj.update = vi.fn((payload: Record<string, unknown>) => {
    capture.payload = payload;
    return obj;
  });
  obj.eq = vi.fn().mockReturnValue(obj);
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

function ctx(supabase: unknown): AuthContext {
  return {
    supabase: supabase as never,
    tenantId: "tenant-owner",
    user: {} as never,
    isAgent: false,
    agentChatId: null,
  };
}

const params = { params: { id: "intake-1" } };

beforeEach(() => vi.clearAllMocks());

describe("PATCH /api/intakes/[id] — ticket_protection", () => {
  it.each([["yes"], [1], [null], [{}]])("400 when ticket_protection is %j, with no write", async (value) => {
    const capture: Capture = { payload: null };
    vi.mocked(requireOwner).mockResolvedValue(ctx(patchSupabase({ data: { id: "intake-1" } }, capture)));
    const res = await PATCH(request({ ticket_protection: value }) as never, params);
    expect(res.status).toBe(400);
    expect(capture.payload).toBeNull();
  });

  it.each([[true], [false]])("an owner can set it to %s", async (value) => {
    const capture: Capture = { payload: null };
    vi.mocked(requireOwner).mockResolvedValue(
      ctx(patchSupabase({ data: { id: "intake-1", ticket_protection: value } }, capture)),
    );
    const res = await PATCH(request({ ticket_protection: value }) as never, params);
    expect(res.status).toBe(200);
    expect(capture.payload).toEqual({ ticket_protection: value });
  });

  it("is not sent when absent", async () => {
    const capture: Capture = { payload: null };
    vi.mocked(requireOwner).mockResolvedValue(ctx(patchSupabase({ data: { id: "intake-1" } }, capture)));
    await PATCH(request({ name: "Sky Festival" }) as never, params);
    expect(capture.payload).not.toHaveProperty("ticket_protection");
  });

  it("the trigger's ticket_protection_locked → 409 with the orders message", async () => {
    const capture: Capture = { payload: null };
    vi.mocked(requireOwner).mockResolvedValue(
      ctx(patchSupabase({ error: { code: "P0001", message: "ticket_protection_locked" } }, capture)),
    );
    const res = await PATCH(request({ ticket_protection: true }) as never, params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Conflict",
      message: "This event already has orders, so account-bound tickets can't be switched.",
    });
  });

  it("the CHECK intakes_ticket_protection_needs_jwt (23514) → 409 with the QR format message", async () => {
    const capture: Capture = { payload: null };
    vi.mocked(requireOwner).mockResolvedValue(
      ctx(
        patchSupabase(
          {
            error: {
              code: "23514",
              message: 'new row for relation "intakes" violates check constraint "intakes_ticket_protection_needs_jwt"',
            },
          },
          capture,
        ),
      ),
    );
    const res = await PATCH(request({ ticket_protection: true }) as never, params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Conflict",
      message: "Account-bound tickets need the signed QR format.",
    });
  });

  it("another check violation is not mistaken for it", async () => {
    const capture: Capture = { payload: null };
    vi.mocked(requireOwner).mockResolvedValue(
      ctx(patchSupabase({ error: { code: "23514", message: 'violates check constraint "intakes_year_check"' } }, capture)),
    );
    const res = await PATCH(request({ ticket_protection: true }) as never, params);
    expect(res.status).not.toBe(409);
  });

  it("a non-owner stays 403, with no write", async () => {
    vi.mocked(requireOwner).mockResolvedValue(
      NextResponse.json({ error: "Forbidden", message: "Owner only." }, { status: 403 }),
    );
    const res = await PATCH(request({ ticket_protection: true }) as never, params);
    expect(res.status).toBe(403);
  });
});

// ─── GET has_orders ──────────────────────────────────────────────────────────

interface CountAnswer {
  count: number | null;
  error: unknown;
}

function getSupabase(counts: { enrollments: CountAnswer; enrollment_items: CountAnswer }, seen: string[][]) {
  return {
    from(table: string) {
      const calls: string[] = [table];
      seen.push(calls);
      const b: Record<string, unknown> = {
        select(cols: string, opts?: { count?: string; head?: boolean }) {
          calls.push(`select:${cols}:${opts?.count ?? ""}:${opts?.head ? "head" : ""}`);
          return b;
        },
        eq(col: string, val: unknown) {
          calls.push(`eq:${col}=${String(val)}`);
          return b;
        },
        single() {
          return Promise.resolve({ data: { id: "intake-1", name: "Sky", ticket_protection: false }, error: null });
        },
        then(resolve: (v: unknown) => unknown) {
          const answer = counts[table as "enrollments" | "enrollment_items"];
          return Promise.resolve({ data: null, ...answer }).then(resolve);
        },
      };
      return b;
    },
  };
}

async function getHasOrders(counts: { enrollments: CountAnswer; enrollment_items: CountAnswer }) {
  const seen: string[][] = [];
  vi.mocked(requireAuth).mockResolvedValue(ctx(getSupabase(counts, seen)));
  const res = await GET(new Request("http://acme.localhost/api/intakes/intake-1") as never, params);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string; has_orders: unknown };
  expect(body.id).toBe("intake-1");
  return { hasOrders: body.has_orders, seen };
}

const none: CountAnswer = { count: 0, error: null };

describe("GET /api/intakes/[id] — has_orders", () => {
  it("false when neither count finds an order", async () => {
    expect((await getHasOrders({ enrollments: none, enrollment_items: none })).hasOrders).toBe(false);
  });

  it("true from a single order", async () => {
    expect((await getHasOrders({ enrollments: { count: 2, error: null }, enrollment_items: none })).hasOrders).toBe(true);
  });

  it("true from a cart order", async () => {
    expect((await getHasOrders({ enrollments: none, enrollment_items: { count: 1, error: null } })).hasOrders).toBe(true);
  });

  it("true when a count fails (the switch is then disabled, not offered)", async () => {
    expect(
      (await getHasOrders({ enrollments: { count: null, error: { message: "x" } }, enrollment_items: none })).hasOrders,
    ).toBe(true);
  });

  it("counts both tables on this intake's classes, head only", async () => {
    const { seen } = await getHasOrders({ enrollments: none, enrollment_items: none });
    for (const table of ["enrollments", "enrollment_items"]) {
      const calls = seen.find((c) => c[0] === table);
      expect(calls).toEqual([
        table,
        "select:id, classes!inner(intake_id):exact:head",
        "eq:classes.intake_id=intake-1",
      ]);
    }
  });
});
