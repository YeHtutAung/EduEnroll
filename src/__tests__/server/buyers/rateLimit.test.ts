import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { makeAdminClientMock } from "../../helpers/mockSupabase";
import { consumeRateLimit } from "@/server/buyers/rateLimit";

// ─── consumeRateLimit: the durable per-key counter from Plan 2 ──────────────
// "unavailable" is the answer for anything that isn't a clear yes or no, so a
// caller can fail closed. It never throws.

function adminWith(rpcImpl: () => unknown) {
  const admin = makeAdminClientMock();
  admin.rpc.mockImplementation(rpcImpl);
  return { admin, client: admin as unknown as SupabaseClient<Database> };
}

describe("consumeRateLimit", () => {
  it("calls consume_rate_limit with the key, window and limit", async () => {
    const { admin, client } = adminWith(async () => ({ data: true, error: null }));
    await consumeRateLimit(client, "bind:buyer-1", 600, 5);
    expect(admin.rpc).toHaveBeenCalledTimes(1);
    expect(admin.rpc).toHaveBeenCalledWith("consume_rate_limit", {
      p_key: "bind:buyer-1",
      p_window_seconds: 600,
      p_limit: 5,
    });
  });

  it("answers ok for true", async () => {
    const { client } = adminWith(async () => ({ data: true, error: null }));
    expect(await consumeRateLimit(client, "k", 60, 1)).toBe("ok");
  });

  it("answers limited for false", async () => {
    const { client } = adminWith(async () => ({ data: false, error: null }));
    expect(await consumeRateLimit(client, "k", 60, 1)).toBe("limited");
  });

  it.each([
    ["null", null],
    ["a string", "true"],
    ["a number", 1],
    ["an object", { ok: true }],
  ])("answers unavailable for %s data", async (_label, data) => {
    const { client } = adminWith(async () => ({ data, error: null }));
    expect(await consumeRateLimit(client, "k", 60, 1)).toBe("unavailable");
  });

  it("answers unavailable for an RPC error, even with data", async () => {
    const { client } = adminWith(async () => ({ data: true, error: { message: "boom" } }));
    expect(await consumeRateLimit(client, "k", 60, 1)).toBe("unavailable");
  });

  it("answers unavailable when the call rejects", async () => {
    const { client } = adminWith(async () => {
      throw new Error("network");
    });
    await expect(consumeRateLimit(client, "k", 60, 1)).resolves.toBe("unavailable");
  });

  it("answers unavailable when the call throws synchronously", async () => {
    const { client } = adminWith(() => {
      throw new Error("sync");
    });
    await expect(consumeRateLimit(client, "k", 60, 1)).resolves.toBe("unavailable");
  });
});
