import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTenantId } from "@/lib/api";
import { sizeChartUrlFor, sizeNoteFor } from "@/lib/enrollment/sizeChart";

// ─── GET /api/public/form-fields?intake_id=UUID ──────────────────────────────
// Public — returns form fields for an intake, ordered by sort_order.
// A size field listed in @/lib/enrollment/sizeChart also carries
// `size_chart_url`, which the public forms draw as size buttons plus a chart.

export async function GET(request: NextRequest) {
  const tenantId = await resolveTenantId();
  if (tenantId instanceof NextResponse) return tenantId;

  const intakeId = request.nextUrl.searchParams.get("intake_id");
  if (!intakeId) {
    return NextResponse.json({ error: "intake_id is required." }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Verify intake belongs to tenant
  const { data: intake } = await supabase
    .from("intakes")
    .select("id")
    .eq("id", intakeId)
    .eq("tenant_id", tenantId)
    .single() as { data: { id: string } | null; error: unknown };

  if (!intake) {
    return NextResponse.json({ error: "Intake not found." }, { status: 404 });
  }

  const { data: fields } = await supabase
    .from("intake_form_fields")
    .select("id, field_key, field_label, field_type, is_required, options, sort_order, is_default")
    .eq("intake_id", intakeId)
    .order("sort_order", { ascending: true })
    // Tie-break on the (intake_id, field_key) unique key so equal sort_orders
    // still come back in one order — the interest form and its API rely on it.
    .order("field_key", { ascending: true }) as {
    data: {
      id: string;
      field_key: string;
      field_label: string;
      field_type: string;
      is_required: boolean;
      options: string[] | null;
      sort_order: number;
      is_default: boolean;
    }[] | null;
    error: unknown;
  };

  const { data: tenant } = await supabase
    .from("tenants")
    .select("subdomain")
    .eq("id", tenantId)
    .maybeSingle() as { data: { subdomain: string } | null; error: unknown };

  return NextResponse.json(
    (fields ?? []).map((f) => {
      const sizeChartUrl = sizeChartUrlFor(tenant?.subdomain, f);
      if (!sizeChartUrl) return f;
      const sizeNote = sizeNoteFor(tenant?.subdomain, f);
      return sizeNote
        ? { ...f, size_chart_url: sizeChartUrl, size_note: sizeNote }
        : { ...f, size_chart_url: sizeChartUrl };
    }),
  );
}
