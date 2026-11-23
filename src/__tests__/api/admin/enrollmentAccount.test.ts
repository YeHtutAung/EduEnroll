import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Result = { data: unknown; error: unknown };
type Call = { table: string; op: string; args: unknown[] };

let results: Record<string, Result>;
const calls: Call[] = [];

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, requireAuth: vi.fn() };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const done = () => Promise.resolve(results[table] ?? { data: [], error: null });
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "is", "order"]) {
        chain[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return chain;
        };
      }
      chain.maybeSingle = () => done();
      chain.then = (ok: (v: Result) => unknown, bad?: (e: unknown) => unknown) => done().then(ok, bad);
      return chain;
    },
  }),
}));

import { requireAuth } from "@/lib/api";
import { GET } from "@/app/api/admin/enrollments/[id]/account/route";

const PUBLIC_KEY = "Q".repeat(87);
const BUYER_A = "buyer-aaaa-1111";
const BUYER_B = "buyer-bbbb-2222";

function get() {
  return GET(new NextRequest("http://localhost/api/admin/enrollments/order-1/account"), {
    params: { id: "order-1" },
  });
}

function signedIn(isAgent = false) {
  vi.mocked(requireAuth).mockResolvedValue({
    tenantId: "tenant-A",
    user: { id: "admin-1" },
    isAgent,
  } as unknown as Awaited<ReturnType<typeof requireAuth>>);
}

function callsOn(table: string, op?: string) {
  return calls.filter((c) => c.table === table && (!op || c.op === op));
}

beforeEach(() => {
  calls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  signedIn();
  results = {
    enrollments: { data: { id: "order-1", buyer_id: BUYER_B }, error: null },
    tickets: {
      data: [
        { id: "t-1", tier: "VIP", seat_no: 1, status: "valid" },
        { id: "t-2", tier: "VIP", seat_no: 2, status: "void" },
      ],
      error: null,
    },
    ticket_devices: {
      data: [
        // t-1: rebound once; the active row is the newer one.
        { ticket_id: "t-1", created_at: "2026-11-20T10:00:00Z", revoked_at: "2026-11-21T09:00:00Z", public_key: PUBLIC_KEY, buyer_id: BUYER_A },
        { ticket_id: "t-1", created_at: "2026-11-21T09:00:00Z", revoked_at: null, public_key: PUBLIC_KEY, buyer_id: BUYER_B },
        // t-2: bound once, then revoked by the move.
        { ticket_id: "t-2", created_at: "2026-11-19T08:00:00Z", revoked_at: "2026-11-22T12:00:00Z", public_key: PUBLIC_KEY, buyer_id: BUYER_A },
      ],
      error: null,
    },
    order_moves: {
      data: [
        {
          created_at: "2026-11-22T12:00:00Z",
          from_buyer_id: BUYER_A,
          to_buyer_id: BUYER_B,
          moved_by: "admin-1",
          reason: "Lost the old account",
        },
      ],
      error: null,
    },
    buyer_profiles: {
      data: [
        { id: BUYER_A, email: "aung@gmail.com", deleted_at: null },
        { id: BUYER_B, email: "kyaw@gmail.com", deleted_at: null },
      ],
      error: null,
    },
    users: { data: [{ id: "admin-1", full_name: "Daw Owner" }], error: null },
  };
});

describe("GET /api/admin/enrollments/[id]/account", () => {
  it("shows the masked account, each ticket's phone status and the move history", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      buyer: { email: "k***@gmail.com" },
      tickets: [
        { id: "t-1", tier: "VIP", seatNo: 1, status: "valid", bound: true, lastBoundAt: "2026-11-21T09:00:00Z" },
        { id: "t-2", tier: "VIP", seatNo: 2, status: "void", bound: false, lastBoundAt: "2026-11-19T08:00:00Z" },
      ],
      moves: [
        {
          createdAt: "2026-11-22T12:00:00Z",
          from: "a***@gmail.com",
          to: "k***@gmail.com",
          reason: "Lost the old account",
          movedBy: "Daw Owner",
        },
      ],
    });
  });

  it("never sends a public key, a token or a buyer id", async () => {
    const res = await get();
    const text = await res.text();

    expect(text).not.toContain(PUBLIC_KEY);
    expect(text).not.toContain(BUYER_A);
    expect(text).not.toContain(BUYER_B);
    expect(text).not.toContain("aung@gmail.com");
    expect(text).not.toContain("kyaw@gmail.com");
    expect(text.toLowerCase()).not.toContain("token");
    expect(text).not.toContain("public_key");
    // and never asks for them
    for (const c of calls.filter((c) => c.op === "select")) {
      expect(String(c.args[0])).not.toMatch(/public_key|token|kid/);
    }
  });

  it("only looks inside the admin's own tenant", async () => {
    await get();

    expect(callsOn("enrollments", "eq")).toContainEqual({ table: "enrollments", op: "eq", args: ["tenant_id", "tenant-A"] });
    expect(callsOn("tickets", "eq")).toContainEqual({ table: "tickets", op: "eq", args: ["enrollment_id", "order-1"] });
    expect(callsOn("tickets", "eq")).toContainEqual({ table: "tickets", op: "eq", args: ["tenant_id", "tenant-A"] });
    expect(callsOn("order_moves", "eq")).toContainEqual({ table: "order_moves", op: "eq", args: ["enrollment_id", "order-1"] });
    expect(callsOn("order_moves", "eq")).toContainEqual({ table: "order_moves", op: "eq", args: ["tenant_id", "tenant-A"] });
    expect(callsOn("ticket_devices", "in")).toContainEqual({ table: "ticket_devices", op: "in", args: ["ticket_id", ["t-1", "t-2"]] });
    expect(callsOn("users", "eq")).toContainEqual({ table: "users", op: "eq", args: ["tenant_id", "tenant-A"] });
  });

  it("answers 404 for another tenant's order (it is not found in this tenant)", async () => {
    results.enrollments = { data: null, error: null };
    const res = await get();

    expect(res.status).toBe(404);
    expect(callsOn("tickets")).toHaveLength(0);
  });

  it("refuses the bot", async () => {
    signedIn(true);
    const res = await get();

    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("passes on requireAuth's own refusal", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireAuth).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as unknown as Awaited<ReturnType<typeof requireAuth>>,
    );
    const res = await get();

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("answers 500, never a false 404, when the order lookup fails", async () => {
    results.enrollments = { data: null, error: { code: "57014" } };
    const res = await get();

    expect(res.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("[order-account] order lookup failed");
  });

  it.each(["tickets", "order_moves", "ticket_devices", "buyer_profiles", "users"])(
    "answers 500 when the %s read fails",
    async (table) => {
      results[table] = { data: null, error: { code: "XX000" } };
      const res = await get();

      expect(res.status).toBe(500);
      expect(console.error).toHaveBeenCalledWith("[order-account] read failed");
    },
  );

  it("a guest order with no moves has no account and no history", async () => {
    results.enrollments = { data: { id: "order-1", buyer_id: null }, error: null };
    results.order_moves = { data: [], error: null };
    results.ticket_devices = { data: [], error: null };
    const res = await get();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      buyer: null,
      tickets: [
        { id: "t-1", tier: "VIP", seatNo: 1, status: "valid", bound: false, lastBoundAt: null },
        { id: "t-2", tier: "VIP", seatNo: 2, status: "void", bound: false, lastBoundAt: null },
      ],
      moves: [],
    });
    expect(callsOn("buyer_profiles")).toHaveLength(0);
    expect(callsOn("users")).toHaveLength(0);
  });

  it("an order with no tickets yet does not read ticket_devices", async () => {
    results.tickets = { data: [], error: null };
    const res = await get();

    expect(res.status).toBe(200);
    expect((await res.json()).tickets).toEqual([]);
    expect(callsOn("ticket_devices")).toHaveLength(0);
  });

  it("a buyer whose profile is gone or deleted shows as *** ; an empty side of a move is null", async () => {
    results.order_moves = {
      data: [
        { created_at: "2026-11-22T12:00:00Z", from_buyer_id: null, to_buyer_id: BUYER_B, moved_by: null, reason: "r" },
        { created_at: "2026-11-21T12:00:00Z", from_buyer_id: BUYER_A, to_buyer_id: null, moved_by: "gone-staff", reason: "r2" },
      ],
      error: null,
    };
    results.buyer_profiles = {
      data: [{ id: BUYER_A, email: "aung@gmail.com", deleted_at: "2026-11-22T00:00:00Z" }],
      error: null,
    };
    results.users = { data: [{ id: "gone-staff", full_name: null }], error: null };
    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.buyer).toEqual({ email: "***" });
    expect(body.moves).toEqual([
      { createdAt: "2026-11-22T12:00:00Z", from: null, to: "***", reason: "r", movedBy: "Staff" },
      { createdAt: "2026-11-21T12:00:00Z", from: "***", to: null, reason: "r2", movedBy: "Staff" },
    ]);
  });
});
