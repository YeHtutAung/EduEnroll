import { createAdminClient } from "@/lib/supabase/admin";
import { sendPendingConversions } from "@/server/conversions/sendPendingConversions";

// A time budget, not a fixed batch: a lapsed token during an on-sale can leave
// hundreds of orders pending, which would expire unsent at a few dozen a day. A
// chunk can start just inside 45 seconds and takes at most 6, inside the route's
// 60. Rows not reached wait for the next run.
const BATCH_ROWS = 1000;
const SWEEP_BUDGET_MS = 45_000;
const CONCURRENCY = 5;

export interface SweepCounts {
  expired: number;
  contextDeleted: number;
  processed: number;
  /** IP data is not being deleted. The route reports this as a failed run. */
  cleanupFailed: boolean;
}

export async function sweepConversions(): Promise<SweepCounts> {
  const started = Date.now();
  const supabase = createAdminClient();
  const counts: SweepCounts = { expired: 0, contextDeleted: 0, processed: 0, cleanupFailed: false };

  // First, so a sending backlog can't stop IP data being deleted.
  const { data: cleaned, error: cleanupError } = (await supabase.rpc(
    "cleanup_conversion_data" as never,
  )) as unknown as { data: { expired: number; context_deleted: number }[] | null; error: { code?: string } | null };
  if (cleanupError) {
    console.error("[conversions] clean-up failed:", cleanupError.code ?? "unknown");
    counts.cleanupFailed = true;
  } else if (cleaned?.[0]) {
    counts.expired = cleaned[0].expired;
    counts.contextDeleted = cleaned[0].context_deleted;
  }

  const { data: rows, error: rowsError } = (await supabase
    .from("conversion_events" as never)
    .select("enrollment_id")
    .eq("status", "pending")
    .order("occurred_at", { ascending: true })
    .limit(BATCH_ROWS)) as unknown as {
    data: { enrollment_id: string }[] | null;
    error: { code?: string } | null;
  };
  if (rowsError) {
    // Nothing is lost: the rows stay pending for the next run.
    console.error("[conversions] pending read failed:", rowsError.code ?? "unknown");
    return counts;
  }

  const ids = Array.from(new Set((rows ?? []).map((r) => r.enrollment_id)));
  for (let i = 0; i < ids.length && Date.now() - started < SWEEP_BUDGET_MS; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map((id) => sendPendingConversions(id)));
    counts.processed += chunk.length;
  }
  return counts;
}
