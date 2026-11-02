import { createAdminClient } from "@/lib/supabase/admin";
import { sendPendingConversions } from "@/server/conversions/sendPendingConversions";

// 40 enrollments, 5 at a time, 6 seconds each: at most 48 seconds, inside the
// route's 60. Rows not reached wait for the next run.
const BATCH_ENROLLMENTS = 40;
const CONCURRENCY = 5;

export interface SweepCounts {
  expired: number;
  contextDeleted: number;
  processed: number;
}

export async function sweepConversions(): Promise<SweepCounts> {
  const supabase = createAdminClient();
  const counts: SweepCounts = { expired: 0, contextDeleted: 0, processed: 0 };

  // First, so a sending backlog can't stop IP data being deleted.
  const { data: cleaned, error: cleanupError } = (await supabase.rpc(
    "cleanup_conversion_data" as never,
  )) as unknown as { data: { expired: number; context_deleted: number }[] | null; error: { code?: string } | null };
  if (cleanupError) {
    console.error("[conversions] clean-up failed:", cleanupError.code ?? "unknown");
  } else if (cleaned?.[0]) {
    counts.expired = cleaned[0].expired;
    counts.contextDeleted = cleaned[0].context_deleted;
  }

  const { data: rows, error: rowsError } = (await supabase
    .from("conversion_events" as never)
    .select("enrollment_id")
    .eq("status", "pending")
    .order("occurred_at", { ascending: true })
    .limit(BATCH_ENROLLMENTS * 2)) as unknown as {
    data: { enrollment_id: string }[] | null;
    error: { code?: string } | null;
  };
  if (rowsError) {
    // Nothing is lost: the rows stay pending for the next run.
    console.error("[conversions] pending read failed:", rowsError.code ?? "unknown");
    return counts;
  }

  const ids = Array.from(new Set((rows ?? []).map((r) => r.enrollment_id))).slice(0, BATCH_ENROLLMENTS);
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    await Promise.all(ids.slice(i, i + CONCURRENCY).map((id) => sendPendingConversions(id)));
  }
  counts.processed = ids.length;
  return counts;
}
