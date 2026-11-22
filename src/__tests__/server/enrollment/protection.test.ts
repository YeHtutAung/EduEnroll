import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { protectedClassIds } from "@/server/enrollment/protection";

// ─── protectedClassIds: which classes sit on an account-bound intake ────────
// null means "couldn't tell"; callers answer 503 and never treat it as
// "not protected" (fail closed).

function adminReturning(result: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "in", "eq"]) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    });
  }
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  const from = vi.fn(() => chain);
  return { from, calls, client: { from } as unknown as SupabaseClient<Database> };
}

describe("protectedClassIds", () => {
  it("returns an empty set for no ids, without a query", async () => {
    const { from, client } = adminReturning({ data: [], error: null });
    const out = await protectedClassIds(client, []);
    expect(out).toEqual(new Set());
    expect(from).not.toHaveBeenCalled();
  });

  it("queries classes joined to intakes for the given ids", async () => {
    const { from, calls, client } = adminReturning({ data: [], error: null });
    await protectedClassIds(client, ["c1", "c2"]);
    expect(from).toHaveBeenCalledWith("classes");
    const select = calls.find((c) => c.method === "select");
    expect(String(select?.args[0])).toContain("intakes!inner(ticket_protection)");
    expect(calls).toContainEqual({ method: "in", args: ["id", ["c1", "c2"]] });
  });

  it("returns only the ids whose intake has ticket_protection = true", async () => {
    const { client } = adminReturning({
      data: [
        { id: "c1", intakes: { ticket_protection: true } },
        { id: "c2", intakes: { ticket_protection: false } },
        { id: "c3", intakes: null },
      ],
      error: null,
    });
    const out = await protectedClassIds(client, ["c1", "c2", "c3", "c4"]);
    expect(out).toEqual(new Set(["c1"]));
  });

  it("deduplicates repeated ids in the query", async () => {
    const { calls, client } = adminReturning({ data: [], error: null });
    await protectedClassIds(client, ["c1", "c1"]);
    expect(calls).toContainEqual({ method: "in", args: ["id", ["c1"]] });
  });

  it("returns null on a query error (fail closed)", async () => {
    const { client } = adminReturning({ data: null, error: { message: "boom" } });
    expect(await protectedClassIds(client, ["c1"])).toBeNull();
  });

  it("returns null when the query throws", async () => {
    const from = vi.fn(() => {
      throw new Error("network");
    });
    const client = { from } as unknown as SupabaseClient<Database>;
    expect(await protectedClassIds(client, ["c1"])).toBeNull();
  });
});
