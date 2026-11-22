import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { DEFAULT_TICKET_TZ, todayInTz } from "@/lib/tickets/exp";

// ─── Tags off on the host while a protected event is live (decision 8) ──────
//
// A tenant tag script runs on the whole host, and the session cookie covers
// the whole host, so a script on any tracked page could bind a phone to a
// buyer's account-bound ticket. The owner chose (a) on 2026-11-23: while the
// tenant has a LIVE protected event, TenantTagManager and AdClickCapture are
// off on that tenant's host. When every protected event has ended they come
// back (protection can't be switched off once an event has orders).
//
// "Live" uses the end rule of move_order_buyer
// (supabase/migrations/20261122130000_leaders_phone.sql):
//
//   last = max over the intake's classes of
//            greatest(event_date, coalesce(end_time, event_date))
//   ended  ⇔ last IS NOT NULL AND last < today in Asia/Yangon
//
// classes.end_time is the END DATE of a multi-day event (a DATE since
// migration 031). greatest() and max() skip NULLs, so a class with only an
// end_time counts by it, and an intake whose classes carry no date at all
// (or that has no classes) has no known end: it counts as live.
//
// Fail closed: a read error means tags off.

export interface ProtectedIntakeRow {
  ticket_protection: boolean | null;
  classes: { event_date: string | null; end_time: string | null }[] | null;
}

function day(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : null;
}

/** The intake's last event day (YYYY-MM-DD), or null when it has no date. */
export function lastEventDay(classes: ProtectedIntakeRow["classes"]): string | null {
  let last: string | null = null;
  for (const c of classes ?? []) {
    const start = day(c.event_date);
    const end = day(c.end_time) ?? start; // coalesce(end_time, event_date)
    for (const d of [start, end]) {
      if (d !== null && (last === null || d > last)) last = d; // greatest, then max
    }
  }
  return last;
}

/** True when any protected intake has an event not yet ended, or no date at all. */
export function isLiveProtected(rows: readonly ProtectedIntakeRow[], now: Date): boolean {
  const today = todayInTz(DEFAULT_TICKET_TZ, now);
  return rows.some((row) => {
    if (row.ticket_protection !== true) return false;
    const last = lastEventDay(row.classes);
    return last === null || last >= today;
  });
}

/**
 * Reads the tenant's protected intakes and their classes' dates in one query.
 * Never throws: a read error, a thrown error or an odd answer returns true.
 */
export async function tenantHasLiveProtectedEvent(
  admin: SupabaseClient<Database>,
  tenantSlug: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const { data, error } = (await admin
      .from("intakes")
      .select("ticket_protection, classes(event_date, end_time), tenants!inner(subdomain)")
      .eq("ticket_protection", true)
      .eq("tenants.subdomain", tenantSlug)) as unknown as {
      data: ProtectedIntakeRow[] | null;
      error: unknown;
    };
    if (error || !Array.isArray(data)) {
      console.error("[liveProtectedEvent] intakes lookup failed");
      return true;
    }
    return isLiveProtected(data, now);
  } catch {
    console.error("[liveProtectedEvent] intakes lookup threw");
    return true;
  }
}
