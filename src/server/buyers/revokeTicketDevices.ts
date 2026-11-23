import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export type RevokeDevicesResult = { ok: true; revoked: number } | { ok: false };

/**
 * Revoke every phone bound to this buyer's tickets (SQL function
 * `revoke_buyer_ticket_devices`, service_role only).
 *
 * Account deletion (mobile spec 11.1 step 1a, design 9) calls this after
 * `deleted_at` is set and before `auth.admin.deleteUser`, and the deletion
 * sweep calls it again. It is idempotent.
 *
 * Never throws. Logs a fixed string only (no ids, no error objects).
 */
export async function revokeBuyerTicketDevices(
  admin: SupabaseClient<Database>,
  buyerId: string,
): Promise<RevokeDevicesResult> {
  try {
    const { data, error } = await admin.rpc("revoke_buyer_ticket_devices" as never, { p_buyer_id: buyerId } as never);
    if (!error && typeof data === "number" && Number.isInteger(data)) {
      return { ok: true, revoked: data };
    }
  } catch {
    // fall through to the single failure path
  }
  console.error("[revokeBuyerTicketDevices] failed");
  return { ok: false };
}
