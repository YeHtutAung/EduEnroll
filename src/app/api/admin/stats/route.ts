import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import type { Class, EnrollmentStatus } from "@/types/database";

type EnrollmentRow = { status: EnrollmentStatus };
type PaymentRow    = { status: string; amount_mmk: number };
type ClassRow      = Pick<Class, "level" | "seat_remaining" | "seat_total">;

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

  // Fetch all three datasets in parallel
  const [enrollmentsRes, paymentsRes, classesRes] = await Promise.all([
    supabase
      .from("enrollments")
      .select("status")
      .eq("tenant_id", tenantId) as unknown as Promise<{ data: EnrollmentRow[] | null; error: unknown }>,

    supabase
      .from("payments")
      .select("status, amount_mmk")
      .eq("tenant_id", tenantId) as unknown as Promise<{ data: PaymentRow[] | null; error: unknown }>,

    supabase
      .from("classes")
      .select("level, seat_remaining, seat_total")
      .eq("tenant_id", tenantId)
      .order("level", { ascending: true }) as unknown as Promise<{ data: ClassRow[] | null; error: unknown }>,
  ]);

  if (enrollmentsRes.error) {
    return NextResponse.json({ error: (enrollmentsRes.error as Error).message }, { status: 500 });
  }
  if (paymentsRes.error) {
    return NextResponse.json({ error: (paymentsRes.error as Error).message }, { status: 500 });
  }
  if (classesRes.error) {
    return NextResponse.json({ error: (classesRes.error as Error).message }, { status: 500 });
  }

  const enrollments = enrollmentsRes.data ?? [];
  const payments    = paymentsRes.data ?? [];
  const classes     = classesRes.data ?? [];

  const total_enrollments       = enrollments.length;
  const confirmed_count         = enrollments.filter((e) => e.status === "confirmed").length;
  const pending_payment_count   = enrollments.filter((e) => e.status === "pending_payment").length;
  const payment_submitted_count = enrollments.filter((e) => e.status === "payment_submitted").length;

  const total_revenue_mmk = payments
    .filter((p) => p.status === "verified")
    .reduce((sum, p) => sum + (p.amount_mmk ?? 0), 0);

  const seats_by_class: { level: string; seat_remaining: number; seat_total: number }[] =
    classes.map((c) => ({
      level:          c.level,
      seat_remaining: c.seat_remaining,
      seat_total:     c.seat_total,
    }));

  return NextResponse.json({
    total_enrollments,
    confirmed_count,
    pending_payment_count,
    payment_submitted_count,
    total_revenue_mmk,
    seats_by_class,
  });
}
