import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// GET /api/admin/students/[id] tells the admin page whether the order belongs to a
// buyer account, so it can hide Edit Email (Plan 3, Task 16; the PATCH refuses it).

type Result = { data: unknown; error: unknown };
const results: Record<string, Result> = {};

function chainFor(table: string) {
  const result = () => Promise.resolve(results[table] ?? { data: null, error: null });
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "in"]) chain[m] = () => chain;
  chain.single = result;
  chain.maybeSingle = result;
  chain.then = (ok: (v: Result) => unknown, fail?: (e: unknown) => unknown) => result().then(ok, fail);
  return chain;
}

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, requireAuth: vi.fn() };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: () => ({ data: null }) }) } }),
}));

import { requireAuth } from "@/lib/api";
import { GET } from "@/app/api/admin/students/[id]/route";

function order(buyerId: string | null) {
  return {
    id: "order-1",
    enrollment_ref: "REF-1",
    student_name_en: "A",
    phone: "09",
    email: "a@gmail.com",
    form_data: {},
    status: "confirmed",
    enrolled_at: "2026-11-23T00:00:00Z",
    class_id: "class-1",
    quantity: 1,
    buyer_id: buyerId,
    classes: { level: "VIP", fee_amount: 1000, intakes: { name: "Event" } },
  };
}

async function detail() {
  const res = await GET(new NextRequest("http://localhost/api/admin/students/order-1"), {
    params: { id: "order-1" },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { buyer_id?: unknown };
}

beforeEach(() => {
  for (const k of Object.keys(results)) delete results[k];
  vi.mocked(requireAuth).mockResolvedValue({
    supabase: { from: (table: string) => chainFor(table) },
    tenantId: "tenant-A",
    user: { id: "admin-1" },
    isAgent: false,
  } as unknown as Awaited<ReturnType<typeof requireAuth>>);
});

describe("GET /api/admin/students/[id] buyer_id", () => {
  it("returns the order's buyer_id when it belongs to an account", async () => {
    results.enrollments = { data: order("buyer-1"), error: null };
    await expect(detail()).resolves.toMatchObject({ buyer_id: "buyer-1" });
  });

  it("returns null for a guest order", async () => {
    results.enrollments = { data: order(null), error: null };
    await expect(detail()).resolves.toMatchObject({ buyer_id: null });
  });
});
