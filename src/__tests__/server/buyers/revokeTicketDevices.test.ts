import { describe, it, expect, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { makeAdminClientMock } from "../../helpers/mockSupabase";
import { revokeBuyerTicketDevices } from "@/server/buyers/revokeTicketDevices";

// ─── revokeBuyerTicketDevices: the deletion step that frees bound phones ────
// Never throws; anything but an integer from the RPC is { ok: false }.

function adminWith(rpcImpl: () => unknown) {
  const admin = makeAdminClientMock();
  admin.rpc.mockImplementation(rpcImpl);
  return { admin, client: admin as unknown as SupabaseClient<Database> };
}

describe("revokeBuyerTicketDevices", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls revoke_buyer_ticket_devices and returns the count", async () => {
    const { admin, client } = adminWith(async () => ({ data: 3, error: null }));
    expect(await revokeBuyerTicketDevices(client, "buyer-1")).toEqual({ ok: true, revoked: 3 });
    expect(admin.rpc).toHaveBeenCalledWith("revoke_buyer_ticket_devices", { p_buyer_id: "buyer-1" });
  });

  it("accepts zero (idempotent second run)", async () => {
    const { client } = adminWith(async () => ({ data: 0, error: null }));
    expect(await revokeBuyerTicketDevices(client, "buyer-1")).toEqual({ ok: true, revoked: 0 });
  });

  it("returns ok:false on an RPC error, a non-number, or a throw, and logs a fixed string", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const impl of [
      async () => ({ data: null, error: { message: "boom buyer-1" } }),
      async () => ({ data: "3", error: null }),
      async () => ({ data: null, error: null }),
      async () => {
        throw new Error("boom buyer-1");
      },
    ]) {
      const { client } = adminWith(impl);
      expect(await revokeBuyerTicketDevices(client, "buyer-1")).toEqual({ ok: false });
    }
    expect(spy).toHaveBeenCalledTimes(4);
    for (const call of spy.mock.calls) {
      expect(call).toEqual(["[revokeBuyerTicketDevices] failed"]);
    }
  });
});
