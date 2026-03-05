import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { User } from "@/types/database";

// ─── Helper: require superadmin role ────────────────────────────────────────

async function requireSuperadmin() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const { data: profile } = (await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single()) as { data: User | null; error: unknown };

  if (!profile || profile.role !== "superadmin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { profile };
}

// ─── GET /api/superadmin/schools ────────────────────────────────────────────

export async function GET() {
  const auth = await requireSuperadmin();
  if ("error" in auth && auth.error) return auth.error;

  const admin = createAdminClient();

  // Fetch all tenants
  const { data: tenants, error: tenantErr } = await admin
    .from("tenants")
    .select("*")
    .order("created_at", { ascending: false });

  if (tenantErr) {
    return NextResponse.json({ error: "Failed to fetch schools" }, { status: 500 });
  }

  // Fetch owner for each tenant + student counts
  const tenantIds = (tenants ?? []).map((t: { id: string }) => t.id);

  const [ownersRes, enrollCountsRes] = await Promise.all([
    admin
      .from("users")
      .select("tenant_id, email, full_name")
      .eq("role", "owner")
      .in("tenant_id", tenantIds),
    admin
      .from("enrollments")
      .select("tenant_id"),
  ]);

  const ownerMap = new Map<string, { email: string; full_name: string | null }>();
  for (const o of (ownersRes.data ?? []) as { tenant_id: string; email: string; full_name: string | null }[]) {
    if (!ownerMap.has(o.tenant_id)) {
      ownerMap.set(o.tenant_id, { email: o.email, full_name: o.full_name });
    }
  }

  const countMap = new Map<string, number>();
  for (const e of (enrollCountsRes.data ?? []) as { tenant_id: string }[]) {
    countMap.set(e.tenant_id, (countMap.get(e.tenant_id) ?? 0) + 1);
  }

  // Active this month
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthStartISO = monthStart.toISOString();

  const { data: activeThisMonth } = await admin
    .from("enrollments")
    .select("tenant_id")
    .gte("enrolled_at", monthStartISO);

  const activeSet = new Set(
    ((activeThisMonth ?? []) as { tenant_id: string }[]).map((e) => e.tenant_id)
  );

  const schools = (tenants ?? []).map((t: Record<string, unknown>) => ({
    id: t.id,
    name: t.name,
    subdomain: t.subdomain,
    plan: t.plan,
    created_at: t.created_at,
    logo_url: t.logo_url,
    owner_email: ownerMap.get(t.id as string)?.email ?? null,
    owner_name: ownerMap.get(t.id as string)?.full_name ?? null,
    student_count: countMap.get(t.id as string) ?? 0,
    status: (t.plan as string) === "suspended" ? "suspended" : "active",
  }));

  const totalStudents = Array.from(countMap.values()).reduce((s, c) => s + c, 0);

  return NextResponse.json({
    schools,
    stats: {
      total_schools: schools.length,
      total_students: totalStudents,
      active_this_month: activeSet.size,
    },
  });
}
