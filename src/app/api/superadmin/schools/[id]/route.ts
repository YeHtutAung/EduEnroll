import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { User } from "@/types/database";

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

// ─── GET /api/superadmin/schools/[id] ───────────────────────────────────────

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireSuperadmin();
  if ("error" in auth && auth.error) return auth.error;

  const admin = createAdminClient();
  const tenantId = params.id;

  type AnyResult = { data: Record<string, unknown> | Record<string, unknown>[] | null; error: unknown };

  const [tenantRes, ownerRes, intakesRes, enrollRes, paymentsRes] = await Promise.all([
    admin.from("tenants").select("*").eq("id", tenantId).single() as unknown as Promise<AnyResult>,
    admin.from("users").select("*").eq("tenant_id", tenantId).eq("role", "owner").maybeSingle() as unknown as Promise<AnyResult>,
    admin.from("intakes").select("*").eq("tenant_id", tenantId).order("year", { ascending: false }) as unknown as Promise<AnyResult>,
    admin.from("enrollments").select("id, status, enrolled_at").eq("tenant_id", tenantId) as unknown as Promise<AnyResult>,
    admin.from("payments").select("amount_mmk, status, created_at").eq("tenant_id", tenantId) as unknown as Promise<AnyResult>,
  ]);

  if (tenantRes.error || !tenantRes.data) {
    return NextResponse.json({ error: "School not found" }, { status: 404 });
  }

  const enrollments = ((enrollRes.data ?? []) as unknown as { id: string; status: string; enrolled_at: string }[]);
  const payments = ((paymentsRes.data ?? []) as unknown as { amount_mmk: number; status: string; created_at: string }[]);

  const totalRevenue = payments
    .filter((p) => p.status === "verified")
    .reduce((s, p) => s + (p.amount_mmk ?? 0), 0);

  // Last activity = most recent enrollment or payment
  const allDates = [
    ...enrollments.map((e) => e.enrolled_at),
    ...payments.map((p) => p.created_at),
  ].filter(Boolean);
  const lastActivity = allDates.length > 0
    ? allDates.sort().reverse()[0]
    : null;

  return NextResponse.json({
    tenant: tenantRes.data,
    owner: ownerRes.data,
    intakes: intakesRes.data ?? [],
    total_students: enrollments.length,
    total_revenue_mmk: totalRevenue,
    last_activity: lastActivity,
  });
}

// ─── PATCH /api/superadmin/schools/[id] ─────────────────────────────────────
// Toggle suspend / activate

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await requireSuperadmin();
  if ("error" in auth && auth.error) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { plan } = body as { plan?: string };
  if (!plan || !["starter", "suspended"].includes(plan)) {
    return NextResponse.json({ error: "plan must be 'starter' or 'suspended'" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("tenants")
    .update({ plan } as never)
    .eq("id", params.id)
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }

  return NextResponse.json(data);
}
