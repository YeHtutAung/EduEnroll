import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export type RateLimitResult = "ok" | "limited" | "unavailable";

/** The durable per-key counter from Plan 2 (never the in-memory src/lib/rateLimit.ts). */
export async function consumeRateLimit(
  admin: SupabaseClient<Database>,
  key: string,
  windowSeconds: number,
  limit: number,
): Promise<RateLimitResult> {
  try {
    const { data, error } = await admin.rpc("consume_rate_limit" as never, {
      p_key: key,
      p_window_seconds: windowSeconds,
      p_limit: limit,
    } as never);
    if (error) return "unavailable";
    if (data === true) return "ok";
    if (data === false) return "limited";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}
