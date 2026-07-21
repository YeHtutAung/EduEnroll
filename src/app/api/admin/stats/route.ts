import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import type { Class } from "@/types/database";

type ClassRow = Pick<Class, "level" | "seat_remaining" | "seat_total">;

// Only an intake that is actually running belongs in the overview. `draft` is
// not published yet and `closed` is over, so counting either reports capacity
// nobody can buy — and the panel is the at-a-glance answer to "how are we
// selling right now".
const LIVE_INTAKE_STATUS = "open";

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────
// Dashboard statistics for the authenticated admin's tenant.
//
// Returns:
//   total_enrollments      — all-time count
//   confirmed_count        — enrollments with status='confirmed'
//   pending_payment_count  — enrollments with status='pending_payment'
//   payment_submitted_count— enrollments with status='payment_submitted'
//   total_revenue      — sum of verified payments
//   seats_by_class         — [{ level, seat_remaining, seat_total }, ...]

export async function GET() {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  // Use COUNT queries for enrollment status — avoids the 1000-row PostgREST default limit
  const [totalRes, confirmedRes, pendingRes, submittedRes, paymentsRes, classesRes] =
    await Promise.all([
      supabase
        .from("enrollments")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId),

      supabase
        .from("enrollments")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "confirmed"),

      supabase
        .from("enrollments")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "pending_payment"),

      supabase
        .from("enrollments")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("status", "payment_submitted"),

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase.rpc as any)("get_tenant_revenue", { p_tenant_id: tenantId }) as Promise<{ data: number | null; error: unknown }>,

      // `!inner` is load-bearing, not stylistic. A plain `intakes(status)` embed
      // LEFT-joins, so the `.eq` filters only the embedded object and every
      // class still comes back — the filter silently does nothing. Verified:
      // that variant returns the draft and closed rows too.
      // classes.intake_id is NOT NULL, so the inner join drops nothing a left
      // join would have kept.
      supabase
        .from("classes")
        .select("level, seat_remaining, seat_total, intakes!inner(status)")
        .eq("intakes.status", LIVE_INTAKE_STATUS)
        .eq("tenant_id", tenantId)
        .order("level", { ascending: true }) as unknown as Promise<{ data: ClassRow[] | null; error: unknown }>,
    ]);

  for (const res of [totalRes, confirmedRes, pendingRes, submittedRes]) {
    if (res.error) {
      return NextResponse.json({ error: (res.error as Error).message }, { status: 500 });
    }
  }
  if (paymentsRes.error) {
    return NextResponse.json({ error: (paymentsRes.error as Error).message }, { status: 500 });
  }
  if (classesRes.error) {
    return NextResponse.json({ error: (classesRes.error as Error).message }, { status: 500 });
  }

  const total_revenue = paymentsRes.data ?? 0;
  const classes = classesRes.data ?? [];

  const seats_by_class: { level: string; seat_remaining: number; seat_total: number }[] =
    classes.map((c) => ({
      level:          c.level,
      seat_remaining: c.seat_remaining,
      seat_total:     c.seat_total,
    }));

  return NextResponse.json({
    total_enrollments:       totalRes.count ?? 0,
    confirmed_count:         confirmedRes.count ?? 0,
    pending_payment_count:   pendingRes.count ?? 0,
    payment_submitted_count: submittedRes.count ?? 0,
    total_revenue,
    seats_by_class,
  });
}
