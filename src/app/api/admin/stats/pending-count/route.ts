import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";

// ─── GET /api/admin/stats/pending-count ───────────────────────────────────────
// The sidebar badge's number, polled by every open admin tab. Kept to one count
// query because /api/admin/stats also computes revenue, seats and other totals
// the badge doesn't use.
//
// The filters must match payment_submitted_count in /api/admin/stats, so the
// badge and the dashboard agree.

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  const { count, error } = await supabase
    .from("enrollments")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .is("internal_test_at", null)
    .eq("status", "payment_submitted");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ payment_submitted_count: count ?? 0 });
}
