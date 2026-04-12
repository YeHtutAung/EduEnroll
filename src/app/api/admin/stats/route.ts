import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import type { Class } from "@/types/database";

type ClassRow = Pick<Class, "level" | "seat_remaining" | "seat_total">;

// ─── GET /api/admin/stats ─────────────────────────────────────────────────────
// Dashboard statistics for the authenticated admin's tenant.
//
// Returns:
//   total_enrollments      — all-time count
//   confirmed_count        — enrollments with status='confirmed'
//   pending_payment_count  — enrollments with status='pending_payment'
//   payment_submitted_count— enrollments with status='payment_submitted'
//   total_revenue_mmk      — sum of verified payments
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

      (supabase.rpc as Function)("get_tenant_revenue", { p_tenant_id: tenantId }) as Promise<{ data: number | null; error: unknown }>,

      supabase
        .from("classes")
        .select("level, seat_remaining, seat_total")
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

  const total_revenue_mmk = paymentsRes.data ?? 0;
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
    total_revenue_mmk,
    seats_by_class,
  });
}
