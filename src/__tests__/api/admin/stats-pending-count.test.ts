import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/api", () => ({ requireAuth: vi.fn() }));

import { requireAuth } from "@/lib/api";
import { GET } from "@/app/api/admin/stats/pending-count/route";

function fakeSupabase(result: { count: number | null; error: unknown }) {
  const calls = {
    from: [] as string[],
    select: [] as unknown[][],
    eq: [] as [string, unknown][],
    is: [] as [string, unknown][],
  };
  const builder = {
    select(...args: unknown[]) {
      calls.select.push(args);
      return builder;
    },
    eq(column: string, value: unknown) {
      calls.eq.push([column, value]);
      return builder;
    },
    is(column: string, value: unknown) {
      calls.is.push([column, value]);
      return builder;
    },
    then(resolve: (value: typeof result) => unknown) {
      return Promise.resolve(result).then(resolve);
    },
  };
  const rpc = vi.fn();
  return {
    calls,
    rpc,
    client: {
      rpc,
      from(table: string) {
        calls.from.push(table);
        return builder;
      },
    },
  };
}

function signedIn(supabase: ReturnType<typeof fakeSupabase>) {
  vi.mocked(requireAuth).mockResolvedValue({
    supabase: supabase.client,
    tenantId: "tenant-A",
  } as unknown as Awaited<ReturnType<typeof requireAuth>>);
}

describe("GET /api/admin/stats/pending-count", () => {
  beforeEach(() => vi.mocked(requireAuth).mockReset());

  it("returns the count of this tenant's real orders awaiting verification", async () => {
    const supabase = fakeSupabase({ count: 7, error: null });
    signedIn(supabase);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ payment_submitted_count: 7 });
    expect(supabase.calls.eq).toEqual(
      expect.arrayContaining([
        ["tenant_id", "tenant-A"],
        ["status", "payment_submitted"],
      ]),
    );
    expect(supabase.calls.is).toEqual([["internal_test_at", null]]);
  });

  it("runs one count query that fetches no rows, and no revenue", async () => {
    const supabase = fakeSupabase({ count: 0, error: null });
    signedIn(supabase);

    await GET();

    expect(supabase.calls.from).toEqual(["enrollments"]);
    expect(supabase.calls.select).toEqual([["id", { count: "exact", head: true }]]);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("treats a null count as zero", async () => {
    signedIn(fakeSupabase({ count: null, error: null }));

    const res = await GET();

    expect(await res.json()).toEqual({ payment_submitted_count: 0 });
  });

  it("returns 500 when the query fails", async () => {
    signedIn(fakeSupabase({ count: null, error: new Error("timeout") }));

    const res = await GET();

    expect(res.status).toBe(500);
  });

  it("passes the auth failure through without querying", async () => {
    vi.mocked(requireAuth).mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const res = await GET();

    expect(res.status).toBe(401);
  });
});
