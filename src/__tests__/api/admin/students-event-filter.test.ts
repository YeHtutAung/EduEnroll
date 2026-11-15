import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// GET /api/admin/students — the event / tier filter must include cart orders.
// A cart order has class_id NULL and its ticket types in enrollment_items, so
// the route reads through enrollments_for_classes() when that filter is set,
// and from the table otherwise.

type Call = { target: string; method: string; args: unknown[] };
let calls: Call[] = [];

/** Thenable builder: records every call; awaiting resolves to `result`. */
function builder(target: string, result: unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "in", "not", "or", "order", "range", "single"]) {
    b[m] = (...args: unknown[]) => {
      calls.push({ target, method: m, args });
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return b;
}

const EMPTY_LIST = { data: [], error: null, count: 0 };
const supabase = {
  from: vi.fn((table: string) => {
    calls.push({ target: table, method: "from", args: [] });
    if (table === "classes") {
      return builder("classes", { data: [{ id: "c-10k" }, { id: "c-5k" }], error: null });
    }
    return builder(table, EMPTY_LIST);
  }),
  rpc: vi.fn(function (this: unknown, fn: string, args: unknown, opts: unknown) {
    // Called as a method: a detached call would lose the client.
    expect(this).toBe(supabase);
    calls.push({ target: "rpc", method: fn, args: [args, opts] });
    return builder("rpc", EMPTY_LIST);
  }),
};

vi.mock("@/lib/api", () => ({
  requireAuth: vi.fn(async () => ({ supabase, tenantId: "tenant-1" })),
  badRequest: (message: string) => NextResponse.json({ error: "Bad Request", message }, { status: 400 }),
}));

const { GET } = await import("@/app/api/admin/students/route");

const req = (qs: string) => new NextRequest(`http://localhost/api/admin/students?${qs}`);

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
});

describe("GET /api/admin/students — event filter", () => {
  it("reads single and cart orders of the event through enrollments_for_classes", async () => {
    const res = await GET(req("intake_id=intake-1"));
    expect(res.status).toBe(200);

    const rpc = calls.find((c) => c.target === "rpc");
    expect(rpc?.method).toBe("enrollments_for_classes");
    expect(rpc?.args).toEqual([{ p_class_ids: ["c-10k", "c-5k"] }, { count: "exact" }]);
    // No class_id IN (...) on top: that is what dropped cart orders.
    expect(calls.some((c) => c.method === "in" && c.args[0] === "class_id")).toBe(false);
    expect(calls.some((c) => c.target === "enrollments" && c.method === "from")).toBe(false);
    // Tenant scoping still applies to the function's rows.
    expect(calls).toContainEqual({ target: "rpc", method: "eq", args: ["tenant_id", "tenant-1"] });
  });

  it("reads an event with no ticket types as no orders, not all orders", async () => {
    supabase.from.mockImplementationOnce((table: string) => {
      calls.push({ target: table, method: "from", args: [] });
      return builder("classes", { data: [], error: null });
    });
    await GET(req("intake_id=intake-empty"));
    expect(calls.find((c) => c.target === "rpc")?.args[0]).toEqual({ p_class_ids: [] });
  });

  it("reads the table directly without an event or tier filter", async () => {
    const res = await GET(req("status=confirmed"));
    expect(res.status).toBe(200);
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(calls.some((c) => c.target === "enrollments" && c.method === "from")).toBe(true);
  });

  it("answers 500 when the ticket types can't be loaded", async () => {
    supabase.from.mockImplementationOnce((table: string) => builder(table, { data: null, error: { code: "x" } }));
    const res = await GET(req("intake_id=intake-1"));
    expect(res.status).toBe(500);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
