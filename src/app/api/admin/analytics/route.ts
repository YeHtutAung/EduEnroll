import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────────────────────────
type EnrollmentRow = {
  id: string;
  status: string;
  enrolled_at: string;
  class_id: string;
};

type ClassRow = {
  id: string;
  level: string;
  seat_remaining: number;
  seat_total: number;
  fee_mmk: number;
};

type PaymentRow = {
  enrollment_id: string;
  status: string;
  amount_mmk: number;
  created_at: string;
};

// ─── GET /api/admin/analytics ───────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const { supabase, tenantId } = auth;

  // Parse date range filter
  const { searchParams } = new URL(request.url);
  const range = searchParams.get("range") ?? "30d";

  let dateFrom: string | null = null;
  const now = new Date();
  if (range === "30d") {
    dateFrom = new Date(now.getTime() - 30 * 86400000).toISOString();
  } else if (range === "90d") {
    dateFrom = new Date(now.getTime() - 90 * 86400000).toISOString();
  } else if (range === "intake") {
    // Will filter by active intake below
    dateFrom = null;
  }
  // "all" → no date filter

  // ─── Fetch data in parallel ───────────────────────────────────────────
  const [enrollmentsRes, classesRes, paymentsRes] = await Promise.all([
    supabase
      .from("enrollments")
      .select("id, status, enrolled_at, class_id")
      .eq("tenant_id", tenantId)
      .order("enrolled_at", { ascending: true }) as unknown as Promise<{
      data: EnrollmentRow[] | null;
      error: unknown;
    }>,

    supabase
      .from("classes")
      .select("id, level, seat_remaining, seat_total, fee_mmk")
      .eq("tenant_id", tenantId) as unknown as Promise<{
      data: ClassRow[] | null;
      error: unknown;
    }>,

    supabase
      .from("payments")
      .select("enrollment_id, status, amount_mmk, created_at")
      .eq("tenant_id", tenantId) as unknown as Promise<{
      data: PaymentRow[] | null;
      error: unknown;
    }>,
  ]);

  if (enrollmentsRes.error || classesRes.error || paymentsRes.error) {
    console.error("[analytics] Query errors:", {
      enrollments: enrollmentsRes.error,
      classes: classesRes.error,
      payments: paymentsRes.error,
    });
    return NextResponse.json(
      {
        error: "Failed to fetch analytics",
        details: {
          enrollments: enrollmentsRes.error ? String(enrollmentsRes.error) : null,
          classes: classesRes.error ? String(classesRes.error) : null,
          payments: paymentsRes.error ? String(paymentsRes.error) : null,
        },
      },
      { status: 500 },
    );
  }

  let enrollments = enrollmentsRes.data ?? [];
  const classes = classesRes.data ?? [];
  const payments = paymentsRes.data ?? [];

  // For "intake" range, find the latest active intake's classes and filter
  if (range === "intake") {
    const { data: activeIntake } = (await supabase
      .from("intakes")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()) as { data: { id: string } | null; error: unknown };

    if (activeIntake) {
      const { data: intakeClasses } = (await supabase
        .from("classes")
        .select("id")
        .eq("intake_id", activeIntake.id)) as {
        data: { id: string }[] | null;
        error: unknown;
      };
      const classIds = new Set((intakeClasses ?? []).map((c) => c.id));
      enrollments = enrollments.filter((e) => classIds.has(e.class_id));
    }
  } else if (dateFrom) {
    enrollments = enrollments.filter((e) => e.enrolled_at >= dateFrom);
  }

  // Build a class lookup
  const classMap = new Map(classes.map((c) => [c.id, c]));

  // ─── 1. Daily enrollments (last 30 days for chart) ────────────────────
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  const dailyMap = new Map<string, number>();

  // Pre-fill last 30 days with 0
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
    dailyMap.set(d, 0);
  }
  for (const e of enrollments) {
    const day = e.enrolled_at.slice(0, 10);
    if (day >= thirtyDaysAgo) {
      dailyMap.set(day, (dailyMap.get(day) ?? 0) + 1);
    }
  }
  const daily_enrollments = Array.from(dailyMap.entries()).map(([date, count]) => ({
    date,
    count,
  }));

  // ─── 2. Enrollments by level ──────────────────────────────────────────
  const levelCounts: Record<string, number> = {};
  for (const e of enrollments) {
    const cls = classMap.get(e.class_id);
    if (cls) {
      levelCounts[cls.level] = (levelCounts[cls.level] ?? 0) + 1;
    }
  }
  const levels = ["N5", "N4", "N3", "N2", "N1"];
  const enrollments_by_level = levels.map((level) => ({
    level,
    count: levelCounts[level] ?? 0,
  }));

  // ─── 3. Revenue by level ──────────────────────────────────────────────
  const enrollmentIds = new Set(enrollments.map((e) => e.id));
  const filteredPayments = payments.filter(
    (p) => p.status === "verified" && enrollmentIds.has(p.enrollment_id)
  );

  // Map payment → enrollment → class → level
  const enrollmentClassMap = new Map(enrollments.map((e) => [e.id, e.class_id]));
  const revenueByLevel: Record<string, number> = {};
  for (const p of filteredPayments) {
    const classId = enrollmentClassMap.get(p.enrollment_id);
    const cls = classId ? classMap.get(classId) : null;
    if (cls) {
      revenueByLevel[cls.level] = (revenueByLevel[cls.level] ?? 0) + p.amount_mmk;
    }
  }
  const revenue_by_level = levels.map((level) => ({
    level,
    revenue: revenueByLevel[level] ?? 0,
  }));

  // ─── 4. Conversion rate ───────────────────────────────────────────────
  const totalEnrolled = enrollments.length;
  const confirmedCount = enrollments.filter((e) => e.status === "confirmed").length;
  const conversion_rate = totalEnrolled > 0
    ? Math.round((confirmedCount / totalEnrolled) * 1000) / 10
    : 0;

  // ─── 5. Seat fill rates ──────────────────────────────────────────────
  const seat_fill_rates = classes.map((c) => ({
    level: c.level,
    class_id: c.id,
    seat_remaining: c.seat_remaining,
    seat_total: c.seat_total,
    fill_pct:
      c.seat_total > 0
        ? Math.round(((c.seat_total - c.seat_remaining) / c.seat_total) * 1000) / 10
        : 0,
  }));

  // ─── 6. Average payment hours ─────────────────────────────────────────
  const enrollmentCreatedMap = new Map(
    enrollments.map((e) => [e.id, new Date(e.enrolled_at).getTime()])
  );
  let totalHours = 0;
  let paymentCount = 0;
  for (const p of payments) {
    if (p.status === "verified" || p.status === "submitted") {
      const enrolledAt = enrollmentCreatedMap.get(p.enrollment_id);
      if (enrolledAt) {
        const paidAt = new Date(p.created_at).getTime();
        totalHours += (paidAt - enrolledAt) / 3600000;
        paymentCount++;
      }
    }
  }
  const avg_payment_hours =
    paymentCount > 0 ? Math.round((totalHours / paymentCount) * 10) / 10 : 0;

  // ─── 7. Top stats ────────────────────────────────────────────────────
  const totalRevenue = filteredPayments.reduce((s, p) => s + p.amount_mmk, 0);

  return NextResponse.json({
    daily_enrollments,
    enrollments_by_level,
    revenue_by_level,
    conversion_rate,
    seat_fill_rates,
    avg_payment_hours,
    total_enrolled: totalEnrolled,
    confirmed_count: confirmedCount,
    total_revenue_mmk: totalRevenue,
  });
}
